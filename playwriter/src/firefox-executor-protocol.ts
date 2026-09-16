import type {
  BrowserDomCommand,
  BrowserExtractFormat,
  BrowserExtractImagesMode,
  BrowserJson,
  BrowserResponse,
} from './browser-protocol.js'
import { parseBrowserDomCommand } from './browser-dom-validation.js'

export const FIREFOX_EXECUTOR_PROTOCOL_VERSION = 1
export const MAX_FIREFOX_EXECUTOR_MESSAGE_BYTES = 8 * 1024 * 1024

/**
 * Byte channel budget for `page.extract` images: the worker asks the extension
 * background to fetch image bytes, the extension answers with base64. The
 * channel is the only Firefox path that moves binary data, so it carries its
 * own bounds instead of the 8 MiB control-message limit.
 */
export const MAX_FIREFOX_ASSET_COUNT = 20
/** Largest single image the channel carries, before base64 expansion. */
export const MAX_FIREFOX_ASSET_BYTES = 16 * 1024 * 1024
/** Largest total of image bytes one extraction may carry. */
export const MAX_FIREFOX_ASSET_TOTAL_BYTES = 64 * 1024 * 1024
/** Frame budget for asset payloads: base64 is 4/3 of the bytes plus envelope slack. */
export const MAX_FIREFOX_ASSET_FRAME_BYTES = 96 * 1024 * 1024

export const MAX_FIREFOX_ASSET_BASE64_LENGTH = base64Length(MAX_FIREFOX_ASSET_BYTES)
export const MAX_FIREFOX_ASSET_TOTAL_BASE64_LENGTH = base64Length(MAX_FIREFOX_ASSET_TOTAL_BYTES)
/** Bounds on one asset target: an absolute http(s) URL, never a data: URL. */
export const MAX_FIREFOX_ASSET_URL_LENGTH = 8_192
export const MAX_FIREFOX_ASSET_ALT_LENGTH = 1_000
export const MAX_FIREFOX_ASSET_MIME_TYPE_LENGTH = 255
export const MAX_FIREFOX_ASSET_REASON_LENGTH = 1_000

function base64Length(bytes: number): number {
  return Math.ceil(bytes / 3) * 4
}

/** One image the worker wants bytes for; `src` is the absolute http(s) URL. */
export interface FirefoxAssetTarget {
  src: string
  alt?: string
}

/** Per-image outcome: a failed image never fails its siblings. */
export type FirefoxAssetOutcome =
  | { src: string; ok: true; base64: string; mimeType: string }
  | { src: string; ok: false; reason: string }

/**
 * Worker → extension request, dispatched by the runtime over the extension
 * websocket. It names the tab it belongs to so the extension can refuse a
 * session that does not own the page the images came from.
 */
export interface FirefoxAssetFetchRequest {
  requestId: string
  sessionId: string
  tabId: string
  browserEpoch: string
  targets: FirefoxAssetTarget[]
}

/** Extension → worker answer; `error` reports a channel failure for every target at once. */
export interface FirefoxAssetFetchResponse {
  requestId: string
  assets: FirefoxAssetOutcome[]
  error?: string
}

export interface FirefoxWorkerExecution {
  requestId: string
  tabId: string
  code: string
  deadline: number
  cwd: string
  url: string
}

/**
 * `page.extract` for the Firefox backend. The worker asks the DOM driver for
 * the serialized document and runs the shared Node pipeline itself, so the
 * relay never blocks on parsing and both backends extract identically.
 */
export interface FirefoxWorkerExtract {
  requestId: string
  sessionId: string
  tabId: string
  browserEpoch: string
  format: BrowserExtractFormat
  selector?: string
  search?: string
  offset?: number
  limit?: number
  /** Image handling; 'save' needs the extension background byte channel. */
  images?: BrowserExtractImagesMode
  /** The whole extraction travels in `value.artifactText` for the relay to write. */
  persist: boolean
}

export type FirefoxWorkerCommand =
  | { type: 'execute'; id: string; execution: FirefoxWorkerExecution }
  | { type: 'extract'; id: string; execution: FirefoxWorkerExtract }
  | { type: 'dom-response'; id: string; rpcId: string; response: BrowserResponse }
  | { type: 'asset-response'; id: string; rpcId: string; response: FirefoxAssetFetchResponse }

export type FirefoxWorkerMessage =
  | { type: 'ready'; protocolVersion: typeof FIREFOX_EXECUTOR_PROTOCOL_VERSION }
  | { type: 'dom-request'; id: string; rpcId: string; command: BrowserDomCommand }
  | { type: 'asset-request'; id: string; rpcId: string; request: FirefoxAssetFetchRequest }
  | { type: 'response'; id: string; response: BrowserResponse }

export function isFirefoxWorkerRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isFirefoxBrowserJson(value: unknown): value is BrowserJson {
  const visit = ({ entry, depth }: { entry: unknown; depth: number }): boolean => {
    if (depth > 32) {
      return false
    }
    if (entry === null || typeof entry === 'boolean' || typeof entry === 'string') {
      return true
    }
    if (typeof entry === 'number') {
      return Number.isFinite(entry)
    }
    if (Array.isArray(entry)) {
      return entry.every((item) => {
        return visit({ entry: item, depth: depth + 1 })
      })
    }
    if (!isFirefoxWorkerRecord(entry)) {
      return false
    }
    return Object.values(entry).every((item) => {
      return visit({ entry: item, depth: depth + 1 })
    })
  }
  return visit({ entry: value, depth: 0 })
}

export function isFirefoxBrowserResponse(value: unknown): value is BrowserResponse {
  if (!isFirefoxWorkerRecord(value) || !boundedString(value.requestId) || typeof value.ok !== 'boolean') {
    return false
  }
  if (value.ok) {
    return isFirefoxWorkerRecord(value.data) && isFirefoxBrowserJson(value.data)
  }
  if (!isFirefoxWorkerRecord(value.error)) {
    return false
  }
  return typeof value.error.message === 'string' && [
    'invalid-request', 'unsupported-capability', 'profile-disconnected', 'profile-required',
    'resource-not-found', 'ownership-mismatch', 'resource-released', 'needs-rebind', 'stale-snapshot',
    'execution-failed', 'cancelled', 'timeout', 'outcome-unknown', 'internal-error',
  ].includes(String(value.error.code)) && ['not-started', 'unknown'].includes(String(value.error.outcome))
}

export function validateFirefoxMessageSize(message: unknown): void {
  const serialized = JSON.stringify(message)
  if (!serialized) {
    throw new Error('Firefox executor IPC message is not serializable')
  }
  const bytes = utf8ByteLength(serialized)
  if (bytes <= MAX_FIREFOX_EXECUTOR_MESSAGE_BYTES) {
    return
  }
  // Only the asset channel may exceed the control-message limit, and only up to
  // the budget its parsers enforce on the same payload.
  if (bytes <= MAX_FIREFOX_ASSET_FRAME_BYTES && carriesAssetPayload(message)) {
    return
  }
  throw new Error('Firefox executor IPC message exceeds its 8 MiB limit')
}

/**
 * UTF-8 length without Buffer or TextEncoder: this module is loaded both by the
 * worker and, for the asset channel types, by the extension, and the Firefox
 * execution sandbox installs its own globals.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        bytes += 3
      }
    } else {
      bytes += 3
    }
  }
  return bytes
}

function carriesAssetPayload(message: unknown): boolean {
  if (!isFirefoxWorkerRecord(message)) {
    return false
  }
  if (message.type === 'asset-request' || message.type === 'asset-response') {
    return true
  }
  const response = message.response
  if (message.type !== 'response' || !isFirefoxWorkerRecord(response) || response.ok !== true || !isFirefoxWorkerRecord(response.data)) {
    return false
  }
  const value = response.data.value
  return isFirefoxWorkerRecord(value) && Array.isArray(value.savedAssets)
}

export function parseFirefoxWorkerMessage(value: unknown): FirefoxWorkerMessage | null {
  if (!isFirefoxWorkerRecord(value)) {
    return null
  }
  if (value.type === 'ready' && value.protocolVersion === FIREFOX_EXECUTOR_PROTOCOL_VERSION) {
    return { type: 'ready', protocolVersion: FIREFOX_EXECUTOR_PROTOCOL_VERSION }
  }
  if (!boundedString(value.id)) {
    return null
  }
  if (value.type === 'response' && isFirefoxBrowserResponse(value.response)) {
    return { type: 'response', id: value.id, response: value.response }
  }
  if (value.type === 'dom-request' && boundedString(value.rpcId)) {
    const command = parseBrowserDomCommand(value.command)
    if (command) {
      return { type: 'dom-request', id: value.id, rpcId: value.rpcId, command }
    }
  }
  if (value.type === 'asset-request' && boundedString(value.rpcId)) {
    const request = parseFirefoxAssetFetchRequest(value.request)
    if (request) {
      return { type: 'asset-request', id: value.id, rpcId: value.rpcId, request }
    }
  }
  return null
}

export function parseFirefoxWorkerCommand(value: unknown): FirefoxWorkerCommand | null {
  if (!isFirefoxWorkerRecord(value) || !boundedString(value.id)) {
    return null
  }
  if (value.type === 'dom-response' && boundedString(value.rpcId) && isFirefoxBrowserResponse(value.response)) {
    return { type: 'dom-response', id: value.id, rpcId: value.rpcId, response: value.response }
  }
  if (value.type === 'asset-response' && boundedString(value.rpcId)) {
    const response = parseFirefoxAssetFetchResponse(value.response)
    if (response) {
      return { type: 'asset-response', id: value.id, rpcId: value.rpcId, response }
    }
  }
  if (value.type === 'extract') {
    const execution = parseExtractExecution(value.execution)
    return execution ? { type: 'extract', id: value.id, execution } : null
  }
  const execution = value.execution
  if (value.type !== 'execute' || !isFirefoxWorkerRecord(execution)) {
    return null
  }
  if (!boundedString(execution.requestId) || !boundedString(execution.tabId) || typeof execution.code !== 'string' || execution.code.length > 1_000_000 ||
    typeof execution.deadline !== 'number' || !Number.isSafeInteger(execution.deadline) ||
    typeof execution.cwd !== 'string' || typeof execution.url !== 'string') {
    return null
  }
  return { type: 'execute', id: value.id, execution: {
    requestId: execution.requestId,
    tabId: execution.tabId,
    code: execution.code,
    deadline: execution.deadline,
    cwd: execution.cwd,
    url: execution.url,
  } }
}

export function parseFirefoxAssetFetchRequest(value: unknown): FirefoxAssetFetchRequest | null {
  if (!isFirefoxWorkerRecord(value) || !fields({ value, keys: ['requestId', 'sessionId', 'tabId', 'browserEpoch', 'targets'] })) {
    return null
  }
  const { requestId, sessionId, tabId, browserEpoch, targets } = value
  if (!boundedString(requestId) || !boundedString(sessionId) || !boundedString(tabId) || !boundedString(browserEpoch)) {
    return null
  }
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_FIREFOX_ASSET_COUNT) {
    return null
  }
  const parsed: FirefoxAssetTarget[] = []
  for (const target of targets) {
    if (!isFirefoxWorkerRecord(target) || !fields({ value: target, keys: ['src', 'alt'] })) {
      return null
    }
    if (!boundedUrl(target.src) || !optionalBoundedString({ value: target.alt, maxLength: MAX_FIREFOX_ASSET_ALT_LENGTH })) {
      return null
    }
    parsed.push({ src: target.src, ...(target.alt !== undefined ? { alt: target.alt as string } : {}) })
  }
  return { requestId, sessionId, tabId, browserEpoch, targets: parsed }
}

export function parseFirefoxAssetFetchResponse(value: unknown): FirefoxAssetFetchResponse | null {
  if (!isFirefoxWorkerRecord(value) || !fields({ value, keys: ['requestId', 'assets', 'error'] }) || !boundedString(value.requestId)) {
    return null
  }
  if (value.error !== undefined && (typeof value.error !== 'string' || value.error.length === 0 || value.error.length > MAX_FIREFOX_ASSET_REASON_LENGTH)) {
    return null
  }
  if (!Array.isArray(value.assets) || value.assets.length > MAX_FIREFOX_ASSET_COUNT) {
    return null
  }
  const assets: FirefoxAssetOutcome[] = []
  let base64Total = 0
  for (const asset of value.assets) {
    if (!isFirefoxWorkerRecord(asset) || !boundedUrl(asset.src) || typeof asset.ok !== 'boolean') {
      return null
    }
    if (!asset.ok) {
      if (!fields({ value: asset, keys: ['src', 'ok', 'reason'] }) ||
        !boundedString(asset.reason) || asset.reason.length > MAX_FIREFOX_ASSET_REASON_LENGTH) {
        return null
      }
      assets.push({ src: asset.src, ok: false, reason: asset.reason })
      continue
    }
    if (!fields({ value: asset, keys: ['src', 'ok', 'base64', 'mimeType'] }) ||
      typeof asset.base64 !== 'string' || asset.base64.length > MAX_FIREFOX_ASSET_BASE64_LENGTH ||
      !boundedMimeType(asset.mimeType)) {
      return null
    }
    base64Total += asset.base64.length
    if (base64Total > MAX_FIREFOX_ASSET_TOTAL_BASE64_LENGTH) {
      return null
    }
    assets.push({ src: asset.src, ok: true, base64: asset.base64, mimeType: asset.mimeType })
  }
  return { requestId: value.requestId, assets, ...(value.error !== undefined ? { error: value.error } : {}) }
}

function boundedUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIREFOX_ASSET_URL_LENGTH) {
    return false
  }
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

function boundedMimeType(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIREFOX_ASSET_MIME_TYPE_LENGTH &&
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value)
}

function fields({ value, keys }: { value: Record<string, unknown>; keys: string[] }): boolean {
  return Object.keys(value).every((key) => {
    return keys.includes(key)
  })
}

/** Same bounds the relay enforces for `page.extract`, so the worker never reads a wider window than the model asked for. */
const EXTRACT_FORMATS: BrowserExtractFormat[] = ['markdown', 'text', 'html', 'assets-manifest']
const EXTRACT_IMAGES_MODES: BrowserExtractImagesMode[] = ['none', 'urls', 'save']
const MAX_EXTRACT_SELECTOR_LENGTH = 10_000
const MAX_EXTRACT_SEARCH_LENGTH = 2_000
const MAX_EXTRACT_WINDOW = 1_000_000

function parseExtractExecution(value: unknown): FirefoxWorkerExtract | null {
  if (!isFirefoxWorkerRecord(value)) {
    return null
  }
  const { requestId, sessionId, tabId, browserEpoch, format, selector, search, offset, limit, images, persist } = value
  if (!boundedString(requestId) || !boundedString(sessionId) || !boundedString(tabId) || !boundedString(browserEpoch) ||
    typeof format !== 'string' || !EXTRACT_FORMATS.includes(format as BrowserExtractFormat) || typeof persist !== 'boolean') {
    return null
  }
  if (images !== undefined && (typeof images !== 'string' || !EXTRACT_IMAGES_MODES.includes(images as BrowserExtractImagesMode))) {
    return null
  }
  if (!optionalBoundedString({ value: selector, maxLength: MAX_EXTRACT_SELECTOR_LENGTH }) ||
    !optionalBoundedString({ value: search, maxLength: MAX_EXTRACT_SEARCH_LENGTH })) {
    return null
  }
  if (!optionalBoundedInteger({ value: offset, maximum: MAX_EXTRACT_WINDOW }) ||
    !optionalBoundedInteger({ value: limit, maximum: MAX_EXTRACT_WINDOW })) {
    return null
  }
  return {
    requestId,
    sessionId,
    tabId,
    browserEpoch,
    format: format as BrowserExtractFormat,
    ...(selector !== undefined ? { selector: selector as string } : {}),
    ...(search !== undefined ? { search: search as string } : {}),
    ...(offset !== undefined ? { offset: offset as number } : {}),
    ...(limit !== undefined ? { limit: limit as number } : {}),
    ...(images !== undefined ? { images: images as BrowserExtractImagesMode } : {}),
    persist,
  }
}

function optionalBoundedString({ value, maxLength }: { value: unknown; maxLength: number }): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= maxLength)
}

function optionalBoundedInteger({ value, maximum }: { value: unknown; maximum: number }): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum)
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
}
