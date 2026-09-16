import type {
  BrowserDomCommand,
  BrowserExtractFormat,
  BrowserJson,
  BrowserResponse,
} from './browser-protocol.js'
import { parseBrowserDomCommand } from './browser-dom-validation.js'

export const FIREFOX_EXECUTOR_PROTOCOL_VERSION = 1
export const MAX_FIREFOX_EXECUTOR_MESSAGE_BYTES = 8 * 1024 * 1024

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
  tabId: string
  format: BrowserExtractFormat
  selector?: string
  search?: string
  offset?: number
  limit?: number
  /** The whole extraction travels in `value.artifactText` for the relay to write. */
  persist: boolean
}

export type FirefoxWorkerCommand =
  | { type: 'execute'; id: string; execution: FirefoxWorkerExecution }
  | { type: 'extract'; id: string; execution: FirefoxWorkerExtract }
  | { type: 'dom-response'; id: string; rpcId: string; response: BrowserResponse }

export type FirefoxWorkerMessage =
  | { type: 'ready'; protocolVersion: typeof FIREFOX_EXECUTOR_PROTOCOL_VERSION }
  | { type: 'dom-request'; id: string; rpcId: string; command: BrowserDomCommand }
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
  if (!serialized || Buffer.byteLength(serialized) > MAX_FIREFOX_EXECUTOR_MESSAGE_BYTES) {
    throw new Error('Firefox executor IPC message exceeds its 8 MiB limit')
  }
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
  return null
}

export function parseFirefoxWorkerCommand(value: unknown): FirefoxWorkerCommand | null {
  if (!isFirefoxWorkerRecord(value) || !boundedString(value.id)) {
    return null
  }
  if (value.type === 'dom-response' && boundedString(value.rpcId) && isFirefoxBrowserResponse(value.response)) {
    return { type: 'dom-response', id: value.id, rpcId: value.rpcId, response: value.response }
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

/** Same bounds the relay enforces for `page.extract`, so the worker never reads a wider window than the model asked for. */
const EXTRACT_FORMATS: BrowserExtractFormat[] = ['markdown', 'text', 'html', 'assets-manifest']
const MAX_EXTRACT_SELECTOR_LENGTH = 10_000
const MAX_EXTRACT_SEARCH_LENGTH = 2_000
const MAX_EXTRACT_WINDOW = 1_000_000

function parseExtractExecution(value: unknown): FirefoxWorkerExtract | null {
  if (!isFirefoxWorkerRecord(value)) {
    return null
  }
  const { requestId, tabId, format, selector, search, offset, limit, persist } = value
  if (!boundedString(requestId) || !boundedString(tabId) || typeof format !== 'string' ||
    !EXTRACT_FORMATS.includes(format as BrowserExtractFormat) || typeof persist !== 'boolean') {
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
    tabId,
    format: format as BrowserExtractFormat,
    ...(selector !== undefined ? { selector: selector as string } : {}),
    ...(search !== undefined ? { search: search as string } : {}),
    ...(offset !== undefined ? { offset: offset as number } : {}),
    ...(limit !== undefined ? { limit: limit as number } : {}),
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
