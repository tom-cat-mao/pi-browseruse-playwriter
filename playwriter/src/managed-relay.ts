/**
 * Managed browser relay for the /browser/v1 protocol (see docs/exec/browser-runtime-contract.md).
 *
 * Owner: B (managed relay and scoped routing). This module owns:
 * - Runtime validation and dispatch for GET /browser/v1/capabilities,
 *   GET /browser/v1/profiles and POST /browser/v1/request.
 * - Per-profile authoritative registry cache built from extension `browserInventory`
 *   snapshots. The extension is the resource source of truth; the relay only caches,
 *   checks ownership and never pushes old bindings back to the extension.
 * - sessionId/resource ownership checks, request dedup by requestId, per-profile input
 *   serialization and strict worker/control-connection revocation.
 * - Managed CDP scoping helpers consumed by cdp-relay.ts for /cdp clients that carry
 *   browserSessionId/browserEpoch.
 *
 * Routing rules from the contract:
 * - groups.* / tabs.* / tab.resolve are forwarded to the extension as legacy
 *   `{ id, method: 'browserRequest', params: BrowserRequest }` messages; the extension
 *   answers with the legacy `{ id, result: BrowserResponse }` envelope.
 * - profiles.list, session.release and request.cancel are handled by the relay.
 * - page.* runs in C's isolated executor pool (playwriter/src/managed-executor-pool.ts).
 *   Until that module exists the operation fails loudly with `unsupported-capability`;
 *   it never pretends to succeed.
 *
 * Requests that were never sent can report outcome `not-started`; requests already sent
 * (to the extension or to a worker) must report `unknown` on abnormal termination and
 * must never be replayed automatically.
 */
import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserCapabilities,
  type BrowserErrorCode,
  type BrowserGroup,
  type BrowserInventory,
  type BrowserOperation,
  type BrowserPageOperation,
  type BrowserProfile,
  type BrowserRequest,
  type BrowserResourceState,
  type BrowserResponse,
  type BrowserResultData,
  type BrowserTab,
  type ManagedExecutorPoolContract,
  type ManagedExecutorPoolOptions,
} from './browser-protocol.js'

export const MANAGED_REQUEST_BODY_LIMIT_BYTES = 4 * 1024 * 1024
export const MANAGED_RESPONSE_BODY_LIMIT_BYTES = 20 * 1024 * 1024
export const MANAGED_DEFAULT_TIMEOUT_MS = 30_000
export const MANAGED_MAX_TIMEOUT_MS = 120_000
export const MANAGED_DEDUP_LIMIT = 1000
export const MANAGED_DEDUP_MAX_AGE_MS = 15 * 60 * 1000

const IDENTIFIER_MAX_LENGTH = 512
const NAME_MAX_LENGTH = 200
const SELECTOR_MAX_LENGTH = 10_000
const CODE_MAX_LENGTH = 1_000_000
const VALUE_MAX_LENGTH = 1_000_000
const URL_MAX_LENGTH = 8_192
const MESSAGE_MAX_LENGTH = 2_000
const INVENTORY_ARRAY_MAX_LENGTH = 10_000

/** Navigation targets accepted from Pi. Anything else (javascript:, data:, chrome://,
 *  chrome-extension:, devtools:, file:, blob:, view-source:) is rejected as malformed. */
const ALLOWED_NAVIGATION_PROTOCOLS = new Set(['http:', 'https:'])

export type ManagedRelayLogger = {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

export type ManagedFailure = {
  code: BrowserErrorCode
  message: string
  outcome: 'not-started' | 'unknown'
}

/** Errors thrown by the extension transport. Carries the protocol failure to return. */
export class ManagedTransportError extends Error {
  readonly code: BrowserErrorCode
  readonly outcome: 'not-started' | 'unknown'

  constructor(failure: ManagedFailure, options?: { cause?: unknown }) {
    super(failure.message, options)
    this.name = 'ManagedTransportError'
    this.code = failure.code
    this.outcome = failure.outcome
  }
}

export type ManagedInventoryInfo = {
  browser?: string
  email?: string
  installId?: string
  /** Extension stable key from the current websocket connection. */
  stableKey?: string
}

export type ManagedInventoryMessageParse =
  | { found: false }
  | { found: true; ok: true; inventory: BrowserInventory }
  | { found: true; ok: false; message: string }

/** Narrow a legacy extension WS message into a validated browserInventory payload. */
export function parseBrowserInventoryMessage(message: unknown): ManagedInventoryMessageParse {
  if (!isRecord(message) || message.method !== 'browserInventory') {
    return { found: false }
  }
  const parsed = parseBrowserInventory(message.params)
  if (!parsed.ok) {
    return { found: true, ok: false, message: parsed.message }
  }
  return { found: true, ok: true, inventory: parsed.value }
}

/** Cached authoritative snapshot for one browser profile. */
export type ManagedProfileSnapshot = {
  profileId: string
  stableKey: string
  browser: string
  label: string
  browserEpoch: string
  revision: number
  groups: Map<string, BrowserGroup>
  tabs: Map<string, BrowserTab>
  connected: boolean
  connectionId: string | null
  connectionSeq: number
  updatedAt: number
}

export type ManagedRelayState = {
  profiles: Map<string, ManagedProfileSnapshot>
  connectionSeq: Map<string, number>
  nextConnectionSeq: number
}

export type ManagedInventoryResult =
  | { accepted: true; profile: ManagedProfileSnapshot; epochChanged: boolean }
  | { accepted: false; reason: string }

/** Per (sessionId, profileId) CDP scope. Derived sets are refreshed on access; the
 *  iframe sets persist until the profile snapshot is invalidated so child frame
 *  sessions stay attributed across events. */
export type ManagedScopeView = {
  sessionId: string
  profileId: string
  targetIds: Set<string>
  tabIds: Set<string>
  ownedCdpSessionIds: Set<string>
  ownedFrameIds: Set<string>
  iframeSessionIds: Set<string>
  iframeTargetIds: Set<string>
}

export type ManagedConnectionScope = {
  sessionId: string
  profileId: string
  browserEpoch: string
  connectionEpoch: string
  extensionConnectionId: string | null
  stableKey: string
}

export type ManagedCommandContext = {
  scope: ManagedScopeView
  method: string
  params: unknown
  sessionId?: string
}

export type ManagedRelayOptions = {
  host: string
  port: number
  /** Runtime token required by /cdp when configured; managed cdp urls must carry it. */
  token?: string
  logger?: ManagedRelayLogger
  /** Forward a validated BrowserRequest to the extension that owns the profile.
   *  Must throw ManagedTransportError on failure. */
  transport: {
    sendBrowserRequest: (options: {
      profileId: string
      stableKey: string
      request: BrowserRequest
      timeoutMs: number
    }) => Promise<unknown>
  }
  /** True when at least one extension websocket is connected (legacy or managed). */
  hasConnectedExtensions: () => boolean
  /** Close one managed /cdp client socket (used for strict worker revocation). */
  closeManagedClient: (options: { clientId: string; code: number; reason: string }) => void
  /** Test seam / custom wiring for the isolated executor pool. */
  poolFactory?: () => Promise<ManagedExecutorPoolContract>
  now?: () => number
}

type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string }

type DedupEntry = {
  kind: BrowserOperation['kind']
  /** Full request fingerprint (operation + cwd + deadline): a reused requestId
   *  with different content is a client bug, not a retry. */
  fingerprint: string
  timestamp: number
  promise: Promise<BrowserResponse>
}

type PendingManagedRequest = {
  sessionId: string
  requestId: string
  profileId: string
  kind: BrowserOperation['kind']
  controller: AbortController
  started: boolean
  cancelRequested: boolean
  sessionReleased: boolean
  timedOut: boolean
}

type ManagedClientEntry = {
  clientId: string
  sessionId: string
  profileId: string
  browserEpoch: string
  connectionEpoch: string
}

type ManagedExecutionSlot = {
  sessionId: string
  profileId: string
  connectionEpoch: string
  clientId: string | null
  cdpUrl: string
}

// ---------------------------------------------------------------------------
// Small validation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function readString(
  record: Record<string, unknown>,
  key: string,
  options: { maxLength: number; trim?: boolean },
): FieldResult<string> {
  const value = record[key]
  if (typeof value !== 'string') {
    return { ok: false, message: `"${key}" must be a string` }
  }
  const normalized = options.trim === false ? value : value.trim()
  if (!normalized) {
    return { ok: false, message: `"${key}" must not be empty` }
  }
  if (normalized.length > options.maxLength) {
    return { ok: false, message: `"${key}" exceeds the maximum length of ${options.maxLength}` }
  }
  return { ok: true, value: normalized }
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  options: { maxLength: number; trim?: boolean },
): FieldResult<string | undefined> {
  if (record[key] === undefined) {
    return { ok: true, value: undefined }
  }
  return readString(record, key, options)
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): FieldResult<boolean | undefined> {
  if (record[key] === undefined) {
    return { ok: true, value: undefined }
  }
  const value = record[key]
  if (typeof value !== 'boolean') {
    return { ok: false, message: `"${key}" must be a boolean` }
  }
  return { ok: true, value }
}

function readOptionalInteger(
  record: Record<string, unknown>,
  key: string,
  options: { min: number; max: number },
): FieldResult<number | undefined> {
  if (record[key] === undefined) {
    return { ok: true, value: undefined }
  }
  const value = record[key]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { ok: false, message: `"${key}" must be an integer` }
  }
  if (value < options.min || value > options.max) {
    return { ok: false, message: `"${key}" must be between ${options.min} and ${options.max}` }
  }
  return { ok: true, value }
}

function readNavigationUrl(record: Record<string, unknown>, key: string): FieldResult<string> {
  const url = readString(record, key, { maxLength: URL_MAX_LENGTH })
  if (!url.ok) {
    return url
  }
  if (!isAllowedNavigationUrl(url.value)) {
    return { ok: false, message: `"${key}" uses a disallowed URL scheme` }
  }
  return url
}

function assertNoExtraFields(record: Record<string, unknown>, allowed: Set<string>, context: string): FieldResult<null> {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return { ok: false, message: `unexpected field "${key}" in ${context}` }
    }
  }
  return { ok: true, value: null }
}

export function isAllowedNavigationUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'about:') {
    return url === 'about:blank'
  }
  return ALLOWED_NAVIGATION_PROTOCOLS.has(parsed.protocol)
}

function isBrowserResourceState(value: unknown): value is BrowserResourceState {
  return value === 'ready' || value === 'disconnected' || value === 'released' || value === 'needs-rebind'
}

// ---------------------------------------------------------------------------
// Request parsing (runtime validation, never a bare TypeScript cast)
// ---------------------------------------------------------------------------

const OPERATION_KINDS = new Set<BrowserOperation['kind']>([
  'profiles.list',
  'groups.list',
  'groups.create',
  'groups.rename',
  'groups.close',
  'tabs.list',
  'tabs.create',
  'tabs.close',
  'tabs.release',
  'tab.resolve',
  'session.release',
  'request.cancel',
  'page.navigate',
  'page.snapshot',
  'page.click',
  'page.fill',
  'page.evaluate',
  'page.screenshot',
  'page.network',
  'page.logs',
  'page.execute',
])

const REQUEST_FIELDS = new Set(['requestId', 'sessionId', 'operation', 'cwd', 'timeoutMs'])

export function parseBrowserRequest(value: unknown): ParseResult<BrowserRequest> {
  if (!isRecord(value)) {
    return { ok: false, message: 'request body must be a JSON object' }
  }
  const extra = assertNoExtraFields(value, REQUEST_FIELDS, 'BrowserRequest')
  if (!extra.ok) {
    return extra
  }
  const requestId = readString(value, 'requestId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!requestId.ok) {
    return requestId
  }
  const sessionId = readString(value, 'sessionId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!sessionId.ok) {
    return sessionId
  }
  const cwd = readOptionalString(value, 'cwd', { maxLength: URL_MAX_LENGTH, trim: false })
  if (!cwd.ok) {
    return cwd
  }
  const timeoutMs = readOptionalInteger(value, 'timeoutMs', { min: 1, max: MANAGED_MAX_TIMEOUT_MS })
  if (!timeoutMs.ok) {
    return timeoutMs
  }
  const operation = parseBrowserOperation(value.operation)
  if (!operation.ok) {
    return operation
  }
  return {
    ok: true,
    value: {
      requestId: requestId.value,
      sessionId: sessionId.value,
      operation: operation.value,
      ...(cwd.value !== undefined ? { cwd: cwd.value } : {}),
      ...(timeoutMs.value !== undefined ? { timeoutMs: timeoutMs.value } : {}),
    },
  }
}

function parseBrowserOperation(value: unknown): ParseResult<BrowserOperation> {
  if (!isRecord(value)) {
    return { ok: false, message: 'operation must be a JSON object' }
  }
  const kind = value.kind
  if (typeof kind !== 'string' || !OPERATION_KINDS.has(kind as BrowserOperation['kind'])) {
    return { ok: false, message: `unknown operation kind "${String(kind)}"` }
  }

  const withFields = (allowed: string[]): FieldResult<Record<string, unknown>> => {
    const extra = assertNoExtraFields(value, new Set(['kind', ...allowed]), `operation ${kind}`)
    return extra.ok ? { ok: true, value } : extra
  }

  switch (kind as BrowserOperation['kind']) {
    case 'profiles.list': {
      const fields = withFields([])
      return fields.ok ? { ok: true, value: { kind: 'profiles.list' } } : fields
    }
    case 'groups.list': {
      const fields = withFields(['profileId'])
      if (!fields.ok) {
        return fields
      }
      const profileId = readOptionalString(value, 'profileId', { maxLength: IDENTIFIER_MAX_LENGTH })
      return profileId.ok ? { ok: true, value: { kind: 'groups.list', profileId: profileId.value } } : profileId
    }
    case 'groups.create': {
      const fields = withFields(['profileId', 'name'])
      if (!fields.ok) {
        return fields
      }
      const profileId = readString(value, 'profileId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!profileId.ok) {
        return profileId
      }
      const name = readString(value, 'name', { maxLength: NAME_MAX_LENGTH })
      if (!name.ok) {
        return name
      }
      return { ok: true, value: { kind: 'groups.create', profileId: profileId.value, name: name.value } }
    }
    case 'groups.rename': {
      const fields = withFields(['groupId', 'name'])
      if (!fields.ok) {
        return fields
      }
      const groupId = readString(value, 'groupId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!groupId.ok) {
        return groupId
      }
      const name = readString(value, 'name', { maxLength: NAME_MAX_LENGTH })
      if (!name.ok) {
        return name
      }
      return { ok: true, value: { kind: 'groups.rename', groupId: groupId.value, name: name.value } }
    }
    case 'groups.close': {
      const fields = withFields(['groupId'])
      if (!fields.ok) {
        return fields
      }
      const groupId = readString(value, 'groupId', { maxLength: IDENTIFIER_MAX_LENGTH })
      return groupId.ok ? { ok: true, value: { kind: 'groups.close', groupId: groupId.value } } : groupId
    }
    case 'tabs.list': {
      const fields = withFields(['groupId'])
      if (!fields.ok) {
        return fields
      }
      const groupId = readOptionalString(value, 'groupId', { maxLength: IDENTIFIER_MAX_LENGTH })
      return groupId.ok ? { ok: true, value: { kind: 'tabs.list', groupId: groupId.value } } : groupId
    }
    case 'tabs.create': {
      const fields = withFields(['groupId', 'url'])
      if (!fields.ok) {
        return fields
      }
      const groupId = readString(value, 'groupId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!groupId.ok) {
        return groupId
      }
      const url = readNavigationUrl(value, 'url')
      if (!url.ok) {
        return url
      }
      return { ok: true, value: { kind: 'tabs.create', groupId: groupId.value, url: url.value } }
    }
    case 'tabs.close':
    case 'tabs.release':
    case 'tab.resolve': {
      const fields = withFields(['tabId'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      return { ok: true, value: { kind: kind as 'tabs.close' | 'tabs.release' | 'tab.resolve', tabId: tabId.value } }
    }
    case 'session.release': {
      const fields = withFields([])
      return fields.ok ? { ok: true, value: { kind: 'session.release' } } : fields
    }
    case 'request.cancel': {
      const fields = withFields(['targetRequestId'])
      if (!fields.ok) {
        return fields
      }
      const targetRequestId = readString(value, 'targetRequestId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!targetRequestId.ok) {
        return targetRequestId
      }
      return { ok: true, value: { kind: 'request.cancel', targetRequestId: targetRequestId.value } }
    }
    case 'page.navigate': {
      const fields = withFields(['tabId', 'url'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const url = readNavigationUrl(value, 'url')
      if (!url.ok) {
        return url
      }
      return { ok: true, value: { kind: 'page.navigate', tabId: tabId.value, url: url.value } }
    }
    case 'page.snapshot': {
      const fields = withFields(['tabId', 'selector', 'search', 'full', 'interactiveOnly'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const selector = readOptionalString(value, 'selector', { maxLength: SELECTOR_MAX_LENGTH, trim: false })
      if (!selector.ok) {
        return selector
      }
      const search = readOptionalString(value, 'search', { maxLength: MESSAGE_MAX_LENGTH, trim: false })
      if (!search.ok) {
        return search
      }
      const full = readOptionalBoolean(value, 'full')
      if (!full.ok) {
        return full
      }
      const interactiveOnly = readOptionalBoolean(value, 'interactiveOnly')
      if (!interactiveOnly.ok) {
        return interactiveOnly
      }
      return {
        ok: true,
        value: {
          kind: 'page.snapshot',
          tabId: tabId.value,
          ...(selector.value !== undefined ? { selector: selector.value } : {}),
          ...(search.value !== undefined ? { search: search.value } : {}),
          ...(full.value !== undefined ? { full: full.value } : {}),
          ...(interactiveOnly.value !== undefined ? { interactiveOnly: interactiveOnly.value } : {}),
        },
      }
    }
    case 'page.click': {
      const fields = withFields(['tabId', 'selector', 'snapshotId'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const selector = readString(value, 'selector', { maxLength: SELECTOR_MAX_LENGTH, trim: false })
      if (!selector.ok) {
        return selector
      }
      const snapshotId = readOptionalString(value, 'snapshotId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!snapshotId.ok) {
        return snapshotId
      }
      return {
        ok: true,
        value: {
          kind: 'page.click',
          tabId: tabId.value,
          selector: selector.value,
          ...(snapshotId.value !== undefined ? { snapshotId: snapshotId.value } : {}),
        },
      }
    }
    case 'page.fill': {
      const fields = withFields(['tabId', 'selector', 'value', 'snapshotId'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const selector = readString(value, 'selector', { maxLength: SELECTOR_MAX_LENGTH, trim: false })
      if (!selector.ok) {
        return selector
      }
      const fillValue = readString(value, 'value', { maxLength: VALUE_MAX_LENGTH, trim: false })
      if (!fillValue.ok) {
        return fillValue
      }
      const snapshotId = readOptionalString(value, 'snapshotId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!snapshotId.ok) {
        return snapshotId
      }
      return {
        ok: true,
        value: {
          kind: 'page.fill',
          tabId: tabId.value,
          selector: selector.value,
          value: fillValue.value,
          ...(snapshotId.value !== undefined ? { snapshotId: snapshotId.value } : {}),
        },
      }
    }
    case 'page.evaluate':
    case 'page.execute': {
      const fields = withFields(['tabId', 'code'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const code = readString(value, 'code', { maxLength: CODE_MAX_LENGTH, trim: false })
      if (!code.ok) {
        return code
      }
      return {
        ok: true,
        value: { kind: kind as 'page.evaluate' | 'page.execute', tabId: tabId.value, code: code.value },
      }
    }
    case 'page.screenshot': {
      const fields = withFields(['tabId', 'path', 'fullPage', 'labels'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const screenshotPath = readOptionalString(value, 'path', { maxLength: URL_MAX_LENGTH, trim: false })
      if (!screenshotPath.ok) {
        return screenshotPath
      }
      const fullPage = readOptionalBoolean(value, 'fullPage')
      if (!fullPage.ok) {
        return fullPage
      }
      const labels = readOptionalBoolean(value, 'labels')
      if (!labels.ok) {
        return labels
      }
      return {
        ok: true,
        value: {
          kind: 'page.screenshot',
          tabId: tabId.value,
          ...(screenshotPath.value !== undefined ? { path: screenshotPath.value } : {}),
          ...(fullPage.value !== undefined ? { fullPage: fullPage.value } : {}),
          ...(labels.value !== undefined ? { labels: labels.value } : {}),
        },
      }
    }
    case 'page.network': {
      const fields = withFields(['tabId', 'action', 'filter'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const action = value.action
      if (action !== 'start' && action !== 'list' && action !== 'stop') {
        return { ok: false, message: '"action" must be one of start, list, stop' }
      }
      const filter = readOptionalString(value, 'filter', { maxLength: MESSAGE_MAX_LENGTH, trim: false })
      if (!filter.ok) {
        return filter
      }
      return {
        ok: true,
        value: {
          kind: 'page.network',
          tabId: tabId.value,
          action,
          ...(filter.value !== undefined ? { filter: filter.value } : {}),
        },
      }
    }
    case 'page.logs': {
      const fields = withFields(['tabId', 'limit'])
      if (!fields.ok) {
        return fields
      }
      const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
      if (!tabId.ok) {
        return tabId
      }
      const limit = readOptionalInteger(value, 'limit', { min: 1, max: 10_000 })
      if (!limit.ok) {
        return limit
      }
      return {
        ok: true,
        value: { kind: 'page.logs', tabId: tabId.value, ...(limit.value !== undefined ? { limit: limit.value } : {}) },
      }
    }
    default: {
      return { ok: false, message: `unknown operation kind "${kind}"` }
    }
  }
}

// ---------------------------------------------------------------------------
// Inventory parsing
// ---------------------------------------------------------------------------

function parseGroupValue(value: unknown, index: number): FieldResult<BrowserGroup> {
  if (!isRecord(value)) {
    return { ok: false, message: `groups[${index}] must be an object` }
  }
  const allowed = new Set([
    'groupId',
    'sessionId',
    'profileId',
    'name',
    'state',
    'browserEpoch',
    'revision',
    'chromeGroupId',
    'windowId',
  ])
  const extra = assertNoExtraFields(value, allowed, `groups[${index}]`)
  if (!extra.ok) {
    return extra
  }
  const groupId = readString(value, 'groupId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!groupId.ok) {
    return groupId
  }
  const sessionId = readString(value, 'sessionId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!sessionId.ok) {
    return sessionId
  }
  const profileId = readString(value, 'profileId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!profileId.ok) {
    return profileId
  }
  const name = readString(value, 'name', { maxLength: NAME_MAX_LENGTH })
  if (!name.ok) {
    return name
  }
  if (!isBrowserResourceState(value.state)) {
    return { ok: false, message: `groups[${index}].state is invalid` }
  }
  const browserEpoch = readString(value, 'browserEpoch', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!browserEpoch.ok) {
    return browserEpoch
  }
  const revision = readOptionalInteger(value, 'revision', { min: 0, max: Number.MAX_SAFE_INTEGER })
  if (!revision.ok) {
    return revision
  }
  const chromeGroupId = readOptionalInteger(value, 'chromeGroupId', { min: 0, max: Number.MAX_SAFE_INTEGER })
  if (!chromeGroupId.ok) {
    return chromeGroupId
  }
  const windowId = readOptionalInteger(value, 'windowId', { min: 0, max: Number.MAX_SAFE_INTEGER })
  if (!windowId.ok) {
    return windowId
  }
  return {
    ok: true,
    value: {
      groupId: groupId.value,
      sessionId: sessionId.value,
      profileId: profileId.value,
      name: name.value,
      state: value.state,
      browserEpoch: browserEpoch.value,
      revision: revision.value ?? 0,
      ...(chromeGroupId.value !== undefined ? { chromeGroupId: chromeGroupId.value } : {}),
      ...(windowId.value !== undefined ? { windowId: windowId.value } : {}),
    },
  }
}

function parseTabValue(value: unknown, index: number): FieldResult<BrowserTab> {
  if (!isRecord(value)) {
    return { ok: false, message: `tabs[${index}] must be an object` }
  }
  const allowed = new Set([
    'tabId',
    'groupId',
    'sessionId',
    'profileId',
    'url',
    'title',
    'state',
    'browserEpoch',
    'revision',
    'chromeTabId',
    'targetId',
    'cdpSessionId',
  ])
  const extra = assertNoExtraFields(value, allowed, `tabs[${index}]`)
  if (!extra.ok) {
    return extra
  }
  const tabId = readString(value, 'tabId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!tabId.ok) {
    return tabId
  }
  const groupId = readString(value, 'groupId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!groupId.ok) {
    return groupId
  }
  const sessionId = readString(value, 'sessionId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!sessionId.ok) {
    return sessionId
  }
  const profileId = readString(value, 'profileId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!profileId.ok) {
    return profileId
  }
  const url = readString(value, 'url', { maxLength: URL_MAX_LENGTH * 4, trim: false })
  if (!url.ok) {
    return url
  }
  const title = readOptionalString(value, 'title', { maxLength: MESSAGE_MAX_LENGTH, trim: false })
  if (!title.ok) {
    return title
  }
  if (!isBrowserResourceState(value.state)) {
    return { ok: false, message: `tabs[${index}].state is invalid` }
  }
  const browserEpoch = readString(value, 'browserEpoch', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!browserEpoch.ok) {
    return browserEpoch
  }
  const revision = readOptionalInteger(value, 'revision', { min: 0, max: Number.MAX_SAFE_INTEGER })
  if (!revision.ok) {
    return revision
  }
  const chromeTabId = readOptionalInteger(value, 'chromeTabId', { min: 0, max: Number.MAX_SAFE_INTEGER })
  if (!chromeTabId.ok) {
    return chromeTabId
  }
  const targetId = readOptionalString(value, 'targetId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!targetId.ok) {
    return targetId
  }
  const cdpSessionId = readOptionalString(value, 'cdpSessionId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!cdpSessionId.ok) {
    return cdpSessionId
  }
  return {
    ok: true,
    value: {
      tabId: tabId.value,
      groupId: groupId.value,
      sessionId: sessionId.value,
      profileId: profileId.value,
      url: url.value,
      title: title.value ?? '',
      state: value.state,
      browserEpoch: browserEpoch.value,
      revision: revision.value ?? 0,
      chromeTabId: chromeTabId.value ?? -1,
      ...(targetId.value !== undefined ? { targetId: targetId.value } : {}),
      ...(cdpSessionId.value !== undefined ? { cdpSessionId: cdpSessionId.value } : {}),
    },
  }
}

export function parseBrowserInventory(value: unknown): ParseResult<BrowserInventory> {
  if (!isRecord(value)) {
    return { ok: false, message: 'inventory must be a JSON object' }
  }
  const allowed = new Set(['protocolVersion', 'profileId', 'browserEpoch', 'revision', 'groups', 'tabs'])
  const extra = assertNoExtraFields(value, allowed, 'BrowserInventory')
  if (!extra.ok) {
    return extra
  }
  if (value.protocolVersion !== BROWSER_PROTOCOL_VERSION) {
    return { ok: false, message: `unsupported protocolVersion ${String(value.protocolVersion)}` }
  }
  const profileId = readString(value, 'profileId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!profileId.ok) {
    return profileId
  }
  const browserEpoch = readString(value, 'browserEpoch', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!browserEpoch.ok) {
    return browserEpoch
  }
  const revision = readOptionalInteger(value, 'revision', { min: 0, max: Number.MAX_SAFE_INTEGER })
  if (!revision.ok) {
    return revision
  }
  if (!Array.isArray(value.groups) || value.groups.length > INVENTORY_ARRAY_MAX_LENGTH) {
    return { ok: false, message: 'groups must be an array' }
  }
  if (!Array.isArray(value.tabs) || value.tabs.length > INVENTORY_ARRAY_MAX_LENGTH) {
    return { ok: false, message: 'tabs must be an array' }
  }
  const groups: BrowserGroup[] = []
  for (const [index, group] of value.groups.entries()) {
    const parsed = parseGroupValue(group, index)
    if (!parsed.ok) {
      return parsed
    }
    groups.push(parsed.value)
  }
  const tabs: BrowserTab[] = []
  for (const [index, tab] of value.tabs.entries()) {
    const parsed = parseTabValue(tab, index)
    if (!parsed.ok) {
      return parsed
    }
    tabs.push(parsed.value)
  }
  return {
    ok: true,
    value: {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      profileId: profileId.value,
      browserEpoch: browserEpoch.value,
      revision: revision.value ?? 0,
      groups,
      tabs,
    },
  }
}

const ERROR_CODES = new Set<BrowserErrorCode>([
  'invalid-request',
  'unsupported-capability',
  'profile-disconnected',
  'profile-required',
  'resource-not-found',
  'ownership-mismatch',
  'resource-released',
  'needs-rebind',
  'stale-snapshot',
  'execution-failed',
  'cancelled',
  'timeout',
  'outcome-unknown',
  'internal-error',
])

export function parseBrowserResponse(value: unknown): ParseResult<BrowserResponse> {
  if (!isRecord(value)) {
    return { ok: false, message: 'response must be an object' }
  }
  const requestId = readString(value, 'requestId', { maxLength: IDENTIFIER_MAX_LENGTH })
  if (!requestId.ok) {
    return requestId
  }
  if (value.ok === true) {
    if (value.data !== undefined && !isRecord(value.data)) {
      return { ok: false, message: '"data" must be an object' }
    }
    return {
      ok: true,
      value: { requestId: requestId.value, ok: true, data: (value.data ?? {}) as BrowserResultData },
    }
  }
  if (value.ok !== false) {
    return { ok: false, message: '"ok" must be a boolean' }
  }
  const error = value.error
  if (!isRecord(error)) {
    return { ok: false, message: 'error must be an object' }
  }
  const code = error.code
  if (typeof code !== 'string' || !ERROR_CODES.has(code as BrowserErrorCode)) {
    return { ok: false, message: 'error.code is invalid' }
  }
  const message = readString(error, 'message', { maxLength: MESSAGE_MAX_LENGTH })
  if (!message.ok) {
    return message
  }
  const outcome = error.outcome
  if (outcome !== 'not-started' && outcome !== 'unknown') {
    return { ok: false, message: 'error.outcome is invalid' }
  }
  return {
    ok: true,
    value: {
      requestId: requestId.value,
      ok: false,
      error: { code: code as BrowserErrorCode, message: message.value, outcome },
    },
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export function buildBrowserCapabilities(): BrowserCapabilities {
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    managedGroups: true,
    persistentOwnership: true,
    explicitTabs: true,
    isolatedExecution: true,
  }
}

// ---------------------------------------------------------------------------
// Registry cache (pure transitions)
// ---------------------------------------------------------------------------

export function createManagedRelayState(): ManagedRelayState {
  return { profiles: new Map(), connectionSeq: new Map(), nextConnectionSeq: 0 }
}

export function noteManagedConnectionOpened(
  state: ManagedRelayState,
  { connectionId }: { connectionId: string },
): ManagedRelayState {
  if (state.connectionSeq.has(connectionId)) {
    return state
  }
  const seq = state.nextConnectionSeq + 1
  const connectionSeq = new Map(state.connectionSeq)
  connectionSeq.set(connectionId, seq)
  return { ...state, connectionSeq, nextConnectionSeq: seq }
}

/**
 * Apply one authoritative inventory snapshot from the extension.
 *
 * Stale rejection rules:
 * - a snapshot from an older connection (reconnect ordering) is rejected;
 * - within the same browserEpoch a lower revision is rejected;
 * - a different browserEpoch from the same or a newer connection is accepted and
 *   reported through epochChanged so executors/control connections are revoked.
 * The relay never resurrects resources missing from a newer snapshot.
 */
export function applyBrowserInventory(
  state: ManagedRelayState,
  input: { connectionId: string; info: ManagedInventoryInfo; inventory: BrowserInventory },
): { state: ManagedRelayState; result: ManagedInventoryResult } {
  const { inventory } = input
  const connectionSeq = state.connectionSeq.get(input.connectionId) ?? state.nextConnectionSeq + 1
  const existing = state.profiles.get(inventory.profileId)
  if (existing) {
    if (connectionSeq < existing.connectionSeq) {
      return { state, result: { accepted: false, reason: 'stale-inventory from an older connection' } }
    }
    if (
      connectionSeq === existing.connectionSeq &&
      existing.browserEpoch === inventory.browserEpoch &&
      inventory.revision < existing.revision
    ) {
      return { state, result: { accepted: false, reason: 'stale-inventory revision' } }
    }
    if (connectionSeq === existing.connectionSeq && existing.connected && existing.browserEpoch === inventory.browserEpoch && inventory.revision === existing.revision) {
      return { state, result: { accepted: true, profile: existing, epochChanged: false } }
    }
  }
  const browser = input.info.browser || existing?.browser || 'Chrome'
  const label = input.info.email || browser
  const snapshot: ManagedProfileSnapshot = {
    profileId: inventory.profileId,
    stableKey: input.info.stableKey || existing?.stableKey || `profile:${inventory.profileId}`,
    browser,
    label,
    browserEpoch: inventory.browserEpoch,
    revision: inventory.revision,
    groups: new Map(inventory.groups.map((group) => [group.groupId, group])),
    tabs: new Map(inventory.tabs.map((tab) => [tab.tabId, tab])),
    connected: true,
    connectionId: input.connectionId,
    connectionSeq,
    updatedAt: Date.now(),
  }
  const profiles = new Map(state.profiles)
  profiles.set(inventory.profileId, snapshot)
  const epochChanged = Boolean(existing && existing.browserEpoch !== inventory.browserEpoch)
  return { state: { ...state, profiles }, result: { accepted: true, profile: snapshot, epochChanged } }
}

export function bindManagedProfileStableKey(
  state: ManagedRelayState,
  { profileId, stableKey }: { profileId: string; stableKey: string },
): ManagedRelayState {
  const snapshot = state.profiles.get(profileId)
  if (!snapshot) {
    return state
  }
  const profiles = new Map(state.profiles)
  profiles.set(profileId, { ...snapshot, stableKey })
  return { ...state, profiles }
}

export function markManagedConnectionOffline(
  state: ManagedRelayState,
  { connectionId }: { connectionId: string },
): { state: ManagedRelayState; profiles: ManagedProfileSnapshot[] } {
  const profiles = new Map(state.profiles)
  const affected: ManagedProfileSnapshot[] = []
  for (const [profileId, snapshot] of state.profiles) {
    if (snapshot.connectionId !== connectionId) {
      continue
    }
    const offline = { ...snapshot, connected: false, connectionId: null }
    profiles.set(profileId, offline)
    affected.push(offline)
  }
  if (affected.length === 0) {
    return { state, profiles: [] }
  }
  return { state: { ...state, profiles }, profiles: affected }
}

/** Offline profiles keep their cached ownership but never advertise 'ready'. */
export function effectiveResourceState({
  profile,
  state,
}: {
  profile: ManagedProfileSnapshot
  state: BrowserResourceState
}): BrowserResourceState {
  if (!profile.connected && state === 'ready') {
    return 'disconnected'
  }
  return state
}

export function listManagedProfiles(state: ManagedRelayState): BrowserProfile[] {
  const capabilities = buildBrowserCapabilities()
  return Array.from(state.profiles.values())
    .sort((a, b) => {
      return a.profileId.localeCompare(b.profileId)
    })
    .map((profile) => {
      return {
        profileId: profile.profileId,
        browser: profile.browser,
        label: profile.label,
        connected: profile.connected,
        browserEpoch: profile.browserEpoch,
        capabilities,
      }
    })
}

export function findManagedGroup(
  state: ManagedRelayState,
  groupId: string,
): { profile: ManagedProfileSnapshot; group: BrowserGroup } | null {
  for (const profile of sortedProfiles(state)) {
    const group = profile.groups.get(groupId)
    if (group) {
      return { profile, group }
    }
  }
  return null
}

export function findManagedTab(
  state: ManagedRelayState,
  tabId: string,
): { profile: ManagedProfileSnapshot; tab: BrowserTab } | null {
  for (const profile of sortedProfiles(state)) {
    const tab = profile.tabs.get(tabId)
    if (tab) {
      return { profile, tab }
    }
  }
  return null
}

export function listManagedGroups(
  state: ManagedRelayState,
  { sessionId, profileId }: { sessionId: string; profileId?: string },
): BrowserGroup[] {
  const profiles = profileId ? Array.from(state.profiles.values()).filter((profile) => profile.profileId === profileId) : sortedProfiles(state)
  return profiles.flatMap((profile) => {
    return Array.from(profile.groups.values())
      .filter((group) => {
        return group.sessionId === sessionId
      })
      .map((group) => {
        return { ...group, state: effectiveResourceState({ profile, state: group.state }) }
      })
  })
}

export function listManagedTabs(
  state: ManagedRelayState,
  { sessionId, groupId, profileId }: { sessionId: string; groupId?: string; profileId?: string },
): BrowserTab[] {
  const profiles = profileId ? Array.from(state.profiles.values()).filter((profile) => profile.profileId === profileId) : sortedProfiles(state)
  return profiles.flatMap((profile) => {
    return Array.from(profile.tabs.values())
      .filter((tab) => {
        return tab.sessionId === sessionId && (!groupId || tab.groupId === groupId)
      })
      .map((tab) => {
        return { ...tab, state: effectiveResourceState({ profile, state: tab.state }) }
      })
  })
}

function sortedProfiles(state: ManagedRelayState): ManagedProfileSnapshot[] {
  return Array.from(state.profiles.values()).sort((a, b) => {
    return a.profileId.localeCompare(b.profileId)
  })
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function successResponse(requestId: string, data: BrowserResultData): BrowserResponse {
  return { requestId, ok: true, data }
}

export function failureResponse(requestId: string, failure: ManagedFailure): BrowserResponse {
  return {
    requestId,
    ok: false,
    error: { code: failure.code, message: failure.message, outcome: failure.outcome },
  }
}

// ---------------------------------------------------------------------------
// Per-profile serialization (real Chrome keyboard focus is shared per profile)
// ---------------------------------------------------------------------------

class ManagedInputQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run(entry: {
    key: string
    controller: AbortController
    task: (signal: AbortSignal) => Promise<BrowserResponse>
  }): Promise<BrowserResponse> {
    const previous = this.tails.get(entry.key) ?? Promise.resolve()
    const result = previous.then(async () => {
      if (entry.controller.signal.aborted) {
        throw entry.controller.signal.reason instanceof Error ? entry.controller.signal.reason : new Error('cancelled')
      }
      return entry.task(entry.controller.signal)
    })
    this.tails.set(
      entry.key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }
}

// ---------------------------------------------------------------------------
// Managed relay
// ---------------------------------------------------------------------------

export class ManagedRelay {
  private state: ManagedRelayState = createManagedRelayState()
  private readonly options: ManagedRelayOptions
  private readonly dedup = new Map<string, DedupEntry>()
  private readonly pending = new Map<string, PendingManagedRequest>()
  private readonly queue = new ManagedInputQueue()
  private readonly scopes = new Map<string, ManagedScopeView>()
  private readonly slots = new Map<string, ManagedExecutionSlot>()
  private readonly managedClients = new Map<string, ManagedClientEntry>()
  private poolPromise: Promise<ManagedExecutorPoolContract | null> | null = null
  private disposed = false

  constructor(options: ManagedRelayOptions) {
    this.options = options
  }

  getState(): ManagedRelayState {
    return this.state
  }

  getCapabilities(): BrowserCapabilities {
    return buildBrowserCapabilities()
  }

  listProfiles(): BrowserProfile[] {
    return listManagedProfiles(this.state)
  }

  noteConnectionOpened({ connectionId }: { connectionId: string }): void {
    this.state = noteManagedConnectionOpened(this.state, { connectionId })
  }

  handleInventory({
    connectionId,
    info,
    inventory,
  }: {
    connectionId: string
    info: ManagedInventoryInfo
    inventory: BrowserInventory
  }): ManagedInventoryResult {
    const { state, result } = applyBrowserInventory(this.state, { connectionId, info, inventory })
    this.state = state
    if (!result.accepted) {
      this.options.logger?.log(
        `[managed-relay] rejected inventory for ${inventory.profileId}: ${result.reason}`,
      )
      return result
    }
    if (result.epochChanged) {
      this.invalidateProfileExecutions({
        profileId: result.profile.profileId,
        reason: `browserEpoch changed to ${inventory.browserEpoch}`,
      })
      this.clearProfileScopes(result.profile.profileId)
    }
    return result
  }

  handleConnectionClosed({ connectionId }: { connectionId: string }): void {
    const { state, profiles } = markManagedConnectionOffline(this.state, { connectionId })
    this.state = state
    for (const profile of profiles) {
      this.options.logger?.log(
        `[managed-relay] profile ${profile.profileId} offline, keeping cached ownership (${profile.groups.size} groups, ${profile.tabs.size} tabs)`,
      )
      this.abortPendingForProfile(profile.profileId)
      this.invalidateProfileExecutions({ profileId: profile.profileId, reason: 'extension disconnected' })
      this.clearProfileScopes(profile.profileId)
      void this.getPool()
        .then(async (pool) => {
          await pool?.disconnectProfile({ profileId: profile.profileId })
        })
        .catch((error) => {
          this.options.logger?.error('[managed-relay] disconnectProfile failed:', error)
        })
    }
  }

  // -------------------------------------------------------------------------
  // HTTP request handling
  // -------------------------------------------------------------------------

  async handleRequest(request: BrowserRequest): Promise<BrowserResponse> {
    if (this.disposed) {
      return failureResponse(request.requestId, {
        code: 'internal-error',
        message: 'managed relay is shutting down',
        outcome: 'not-started',
      })
    }
    const timeoutMs = request.timeoutMs ?? MANAGED_DEFAULT_TIMEOUT_MS
    const operation = request.operation

    // Read-only local operations and side-effect-only operations are not deduped.
    if (operation.kind === 'profiles.list') {
      return successResponse(request.requestId, { profiles: this.listProfiles() })
    }
    if (operation.kind === 'groups.list') {
      const profile = this.assertProfile({ profileId: operation.profileId, allowOffline: true, requestId: request.requestId })
      if (!profile.ok) {
        return profile.response
      }
      return successResponse(request.requestId, {
        groups: listManagedGroups(this.state, { sessionId: request.sessionId, profileId: operation.profileId }),
      })
    }
    if (operation.kind === 'tabs.list') {
      if (operation.groupId) {
        const group = this.resolveGroup({ requestId: request.requestId, sessionId: request.sessionId, groupId: operation.groupId })
        if (!group.ok) {
          return group.response
        }
      }
      return successResponse(request.requestId, {
        tabs: listManagedTabs(this.state, {
          sessionId: request.sessionId,
          groupId: operation.groupId,
        }),
      })
    }
    if (operation.kind === 'session.release') {
      return this.releaseSession({ requestId: request.requestId, sessionId: request.sessionId })
    }
    if (operation.kind === 'request.cancel') {
      return this.cancelRequest({
        requestId: request.requestId,
        sessionId: request.sessionId,
        targetRequestId: operation.targetRequestId,
      })
    }

    const dedupKey = `${request.sessionId}\u0000${request.requestId}`
    const fingerprint = buildRequestFingerprint(request)
    const existing = this.dedup.get(dedupKey)
    if (existing) {
      if (existing.kind !== operation.kind || existing.fingerprint !== fingerprint) {
        return failureResponse(request.requestId, {
          code: 'invalid-request',
          message: `requestId ${request.requestId} was already used with a different request payload`,
          outcome: 'not-started',
        })
      }
      return existing.promise
    }

    const promise = this.dispatch({ request, timeoutMs }).then((response) => {
      return this.enforceResponseLimit(response, request.requestId)
    })
    this.dedup.set(dedupKey, { kind: operation.kind, fingerprint, timestamp: Date.now(), promise })
    this.pruneDedup()
    return promise
  }

  private async dispatch({
    request,
    timeoutMs,
  }: {
    request: BrowserRequest
    timeoutMs: number
  }): Promise<BrowserResponse> {
    const operation = request.operation
    try {
      switch (operation.kind) {
        case 'groups.create': {
          const profile = this.requireRoutableProfile({ requestId: request.requestId, profileId: operation.profileId })
          if (!profile.ok) {
            return profile.response
          }
          return await this.sendControl({ request, profile: profile.profile, timeoutMs })
        }
        case 'groups.rename': {
          const group = this.resolveGroup({ requestId: request.requestId, sessionId: request.sessionId, groupId: operation.groupId })
          if (!group.ok) {
            return group.response
          }
          const routable = this.requireRoutableProfile({ requestId: request.requestId, profileId: group.profile.profileId })
          if (!routable.ok) {
            return routable.response
          }
          return await this.sendControl({ request, profile: routable.profile, timeoutMs })
        }
        case 'groups.close': {
          const group = this.resolveGroup({ requestId: request.requestId, sessionId: request.sessionId, groupId: operation.groupId })
          if (!group.ok) {
            return group.response
          }
          const routable = this.requireRoutableProfile({ requestId: request.requestId, profileId: group.profile.profileId })
          if (!routable.ok) {
            return routable.response
          }
          return await this.sendControl({ request, profile: routable.profile, timeoutMs })
        }
        case 'tabs.create': {
          const group = this.resolveGroup({ requestId: request.requestId, sessionId: request.sessionId, groupId: operation.groupId })
          if (!group.ok) {
            return group.response
          }
          const routable = this.requireRoutableProfile({ requestId: request.requestId, profileId: group.profile.profileId })
          if (!routable.ok) {
            return routable.response
          }
          return await this.sendControl({ request, profile: routable.profile, timeoutMs })
        }
        case 'tabs.close':
        case 'tabs.release':
        case 'tab.resolve': {
          const tab = this.resolveTab({ requestId: request.requestId, sessionId: request.sessionId, tabId: operation.tabId })
          if (!tab.ok) {
            return tab.response
          }
          const routable = this.requireRoutableProfile({ requestId: request.requestId, profileId: tab.profile.profileId })
          if (!routable.ok) {
            return routable.response
          }
          return await this.sendControl({ request, profile: routable.profile, timeoutMs })
        }
        case 'page.navigate':
        case 'page.snapshot':
        case 'page.click':
        case 'page.fill':
        case 'page.evaluate':
        case 'page.screenshot':
        case 'page.network':
        case 'page.logs':
        case 'page.execute': {
          return await this.executePageOperation({ request, operation, timeoutMs })
        }
        default: {
          return failureResponse(request.requestId, {
            code: 'invalid-request',
            message: `operation ${operation.kind} is not dispatachable`,
            outcome: 'not-started',
          })
        }
      }
    } catch (error) {
      const pending = this.pending.get(`${request.sessionId}\u0000${request.requestId}`)
      const failure: ManagedFailure = {
        code: 'internal-error',
        message: error instanceof Error ? error.message : String(error),
        outcome: pending?.started ? 'unknown' : 'not-started',
      }
      this.options.logger?.error('[managed-relay] request failed:', error)
      return failureResponse(request.requestId, failure)
    }
  }

  // -------------------------------------------------------------------------
  // Extension control operations
  // -------------------------------------------------------------------------

  private async sendControl({
    request,
    profile,
    timeoutMs,
  }: {
    request: BrowserRequest
    profile: ManagedProfileSnapshot
    timeoutMs: number
  }): Promise<BrowserResponse> {
    const pending = this.createPending({
      sessionId: request.sessionId,
      requestId: request.requestId,
      profileId: profile.profileId,
      kind: request.operation.kind,
    })
    try {
      const transportPromise = this.options.transport.sendBrowserRequest({
        profileId: profile.profileId,
        stableKey: profile.stableKey,
        request,
        timeoutMs,
      })
      // Do not let a late settlement become an unhandled rejection after a cancel.
      transportPromise.catch(() => {})
      pending.started = true
      const value = await this.awaitWithAbort({ promise: transportPromise, signal: pending.controller.signal })
      const parsed = parseBrowserResponse(value)
      if (!parsed.ok) {
        return failureResponse(request.requestId, {
          code: 'internal-error',
          message: `extension returned a malformed response: ${parsed.message}`,
          outcome: 'unknown',
        })
      }
      if (parsed.value.requestId !== request.requestId) {
        return failureResponse(request.requestId, {
          code: 'internal-error',
          message: 'extension response requestId does not match the request',
          outcome: 'unknown',
        })
      }
      const resultCheck = this.validateResourceResponse({ request, response: parsed.value })
      if (!resultCheck.ok) {
        return resultCheck.response
      }
      return parsed.value
    } catch (error) {
      return failureResponse(request.requestId, this.describeRequestError({ error, pending }))
    } finally {
      this.pending.delete(`${request.sessionId}\u0000${request.requestId}`)
    }
  }

  private validateResourceResponse({
    request,
    response,
  }: {
    request: BrowserRequest
    response: BrowserResponse
  }): { ok: true } | { ok: false; response: BrowserResponse } {
    if (!response.ok) {
      return { ok: true }
    }
    const invalid = (message: string): { ok: false; response: BrowserResponse } => {
      return {
        ok: false,
        response: failureResponse(request.requestId, { code: 'internal-error', message, outcome: 'unknown' }),
      }
    }
    const operation = request.operation
    if (operation.kind === 'groups.create') {
      const group = response.data.group
      if (!group || group.sessionId !== request.sessionId || group.profileId !== operation.profileId) {
        return invalid('extension returned a group that does not belong to this session/profile')
      }
    }
    if (operation.kind === 'tabs.create') {
      const tab = response.data.tab
      if (!tab || tab.sessionId !== request.sessionId || tab.groupId !== operation.groupId) {
        return invalid('extension returned a tab that does not belong to this session/group')
      }
    }
    return { ok: true }
  }

  // -------------------------------------------------------------------------
  // Page execution (isolated executor pool)
  // -------------------------------------------------------------------------

  private async executePageOperation({
    request,
    operation,
    timeoutMs,
  }: {
    request: BrowserRequest
    operation: BrowserPageOperation
    timeoutMs: number
  }): Promise<BrowserResponse> {
    const tabResult = this.resolveTab({ requestId: request.requestId, sessionId: request.sessionId, tabId: operation.tabId })
    if (!tabResult.ok) {
      return tabResult.response
    }
    const routable = this.requireRoutableProfile({ requestId: request.requestId, profileId: tabResult.profile.profileId })
    if (!routable.ok) {
      return routable.response
    }
    const slot = this.beginExecution({
      sessionId: request.sessionId,
      profileId: tabResult.profile.profileId,
      requestId: request.requestId,
    })
    const pending = this.createPending({
      sessionId: request.sessionId,
      requestId: request.requestId,
      profileId: tabResult.profile.profileId,
      kind: operation.kind,
    })
    const timer = setTimeout(() => {
      pending.timedOut = true
      pending.controller.abort(new Error('timeout'))
    }, timeoutMs)
    try {
      const response = await this.queue.run({
        key: tabResult.profile.profileId,
        controller: pending.controller,
        task: async (signal) => {
          // Authoritative release/ownership re-check with the extension right
          // before executing: the cached inventory may be a moment behind a
          // release that happened while this request was queued.
          const authoritative = await this.resolveTabWithExtension({
            request,
            operation,
            profile: tabResult.profile,
            timeoutMs,
            signal,
          })
          if (!authoritative.ok) {
            throw new ManagedTransportError(authoritative.failure)
          }
          const pool = await this.getPool()
          if (!pool) {
            throw new ManagedTransportError({
              code: 'unsupported-capability',
              message: 'isolated executor pool is not available in this runtime',
              outcome: 'not-started',
            })
          }
          pending.started = true
          return await pool.execute({
            request: { ...request, operation },
            tab: authoritative.tab,
            cdpUrl: slot.cdpUrl,
            connectionEpoch: slot.connectionEpoch,
            signal,
          })
        },
      })
      const parsed = parseBrowserResponse(response)
      if (!parsed.ok) {
        return failureResponse(request.requestId, {
          code: 'internal-error',
          message: `executor returned a malformed response: ${parsed.message}`,
          outcome: 'unknown',
        })
      }
      if (parsed.value.requestId !== request.requestId) {
        return failureResponse(request.requestId, {
          code: 'internal-error',
          message: 'executor response requestId does not match the request',
          outcome: 'unknown',
        })
      }
      return parsed.value
    } catch (error) {
      return failureResponse(request.requestId, this.describeRequestError({ error, pending }))
    } finally {
      clearTimeout(timer)
      this.pending.delete(`${request.sessionId}\u0000${request.requestId}`)
    }
  }

  /**
   * Ask the extension for the authoritative state of the request tab immediately
   * before running a page action. The cached inventory is only a snapshot: a tab
   * released (or rebound) while the request was queued must not be executed.
   */
  private async resolveTabWithExtension({
    request,
    operation,
    profile,
    timeoutMs,
    signal,
  }: {
    request: BrowserRequest
    operation: BrowserPageOperation
    profile: ManagedProfileSnapshot
    timeoutMs: number
    signal: AbortSignal
  }): Promise<{ ok: true; tab: BrowserTab } | { ok: false; failure: ManagedFailure }> {
    const resolveRequest: BrowserRequest = {
      requestId: `${request.requestId}#tab.resolve`,
      sessionId: request.sessionId,
      operation: { kind: 'tab.resolve', tabId: operation.tabId },
      timeoutMs,
      ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
    }
    let value: unknown
    try {
      const transportPromise = this.options.transport.sendBrowserRequest({
        profileId: profile.profileId,
        stableKey: profile.stableKey,
        request: resolveRequest,
        timeoutMs,
      })
      transportPromise.catch(() => {})
      value = await this.awaitWithAbort({ promise: transportPromise, signal })
    } catch (error) {
      return { ok: false, failure: describeTransportFailure(error) }
    }
    const parsed = parseBrowserResponse(value)
    if (!parsed.ok) {
      return {
        ok: false,
        failure: {
          code: 'internal-error',
          message: `extension returned a malformed tab.resolve response: ${parsed.message}`,
          outcome: 'unknown',
        },
      }
    }
    if (!parsed.value.ok) {
      return { ok: false, failure: { ...parsed.value.error } }
    }
    if (parsed.value.requestId !== resolveRequest.requestId) {
      return {
        ok: false,
        failure: {
          code: 'internal-error',
          message: 'tab.resolve response requestId does not match the request',
          outcome: 'unknown',
        },
      }
    }
    const tab = parsed.value.data.tab
    if (!tab || tab.tabId !== operation.tabId || tab.sessionId !== request.sessionId || tab.profileId !== profile.profileId) {
      return {
        ok: false,
        failure: {
          code: 'internal-error',
          message: 'extension returned a tab.resolve payload that does not match this session/profile',
          outcome: 'unknown',
        },
      }
    }
    if (tab.state === 'released') {
      return {
        ok: false,
        failure: {
          code: 'resource-released',
          message: `tab ${operation.tabId} was released before execution`,
          outcome: 'not-started',
        },
      }
    }
    if (tab.state === 'needs-rebind') {
      return {
        ok: false,
        failure: {
          code: 'needs-rebind',
          message: `tab ${operation.tabId} needs to be re-bound before execution`,
          outcome: 'not-started',
        },
      }
    }
    if (tab.state !== 'ready') {
      return {
        ok: false,
        failure: {
          code: 'profile-disconnected',
          message: `tab ${operation.tabId} is not attached (state ${tab.state})`,
          outcome: 'not-started',
        },
      }
    }
    return { ok: true, tab }
  }

  private async getPool(): Promise<ManagedExecutorPoolContract | null> {
    if (this.poolPromise) {
      return this.poolPromise
    }
    const load = async (): Promise<ManagedExecutorPoolContract | null> => {
      try {
        const factory = this.options.poolFactory ?? (async () => {
          const moduleId: string = './managed-executor-pool.js'
          const loaded: unknown = await import(moduleId)
          if (!isManagedExecutorPoolModule(loaded)) {
            throw new Error('managed-executor-pool.js does not export the ManagedExecutorPool class')
          }
          return new loaded.ManagedExecutorPool({
            onInvalidate: (options) => {
              this.handlePoolInvalidate(options)
            },
          })
        })
        return await factory()
      } catch (error) {
        this.options.logger?.error(
          '[managed-relay] isolated executor pool unavailable (C worker not integrated yet):',
          error,
        )
        return null
      }
    }
    this.poolPromise = load()
    const pool = await this.poolPromise
    if (!pool) {
      // Allow a later request to retry the import instead of caching the failure.
      this.poolPromise = null
    }
    return pool
  }

  private handlePoolInvalidate(options: { sessionId: string; profileId: string; connectionEpoch: string }): void {
    const slot = this.slots.get(slotKey(options.sessionId, options.profileId))
    if (!slot || slot.connectionEpoch !== options.connectionEpoch) {
      return
    }
    this.options.logger?.log(
      `[managed-relay] revoking managed CDP connection for session ${options.sessionId} profile ${options.profileId} (worker invalidated)`,
    )
    this.invalidateSlot({ sessionId: options.sessionId, profileId: options.profileId, reason: 'worker invalidated' })
  }

  // -------------------------------------------------------------------------
  // session.release / request.cancel
  // -------------------------------------------------------------------------

  private async releaseSession({ requestId, sessionId }: { requestId: string; sessionId: string }): Promise<BrowserResponse> {
    this.abortPendingForSession(sessionId, 'session-released')
    this.invalidateSessionExecutions({ sessionId, reason: 'session released' })
    try {
      const pool = await this.getPool()
      if (pool) {
        await pool.releaseSession({ sessionId })
      }
    } catch (error) {
      this.options.logger?.error('[managed-relay] releaseSession failed:', error)
      return failureResponse(requestId, {
        code: 'internal-error',
        message: 'failed to release the isolated executor session',
        outcome: 'unknown',
      })
    }
    return successResponse(requestId, { text: 'session released; groups and tabs are preserved' })
  }

  private async cancelRequest({
    requestId,
    sessionId,
    targetRequestId,
  }: {
    requestId: string
    sessionId: string
    targetRequestId: string
  }): Promise<BrowserResponse> {
    const pendingKey = `${sessionId}\u0000${targetRequestId}`
    const pending = this.pending.get(pendingKey)
    if (!pending) {
      // A request that exists but belongs to another session must never be
      // cancellable from here; report the ownership problem explicitly.
      const foreign = Array.from(this.pending.values()).find((entry) => {
        return entry.requestId === targetRequestId
      })
      if (foreign) {
        return failureResponse(requestId, {
          code: 'ownership-mismatch',
          message: `request ${targetRequestId} belongs to another session`,
          outcome: 'not-started',
        })
      }
      if (this.dedup.has(pendingKey)) {
        return successResponse(requestId, { text: 'request already finished' })
      }
      return failureResponse(requestId, {
        code: 'resource-not-found',
        message: `no in-flight request ${targetRequestId} for this session`,
        outcome: 'not-started',
      })
    }
    pending.cancelRequested = true
    pending.controller.abort(new Error('cancelled'))
    if (isPageOperationKind(pending.kind)) {
      void this.cancelPoolRequest({ sessionId, requestId: targetRequestId, profileId: pending.profileId })
    }
    return successResponse(requestId, { text: `cancellation requested for ${targetRequestId}` })
  }

  private async cancelPoolRequest({
    sessionId,
    requestId,
    profileId,
  }: {
    sessionId: string
    requestId: string
    profileId: string
  }): Promise<void> {
    try {
      const pool = await this.getPool()
      if (pool) {
        await pool.cancel({ sessionId, requestId })
      }
    } catch (error) {
      this.options.logger?.error('[managed-relay] pool cancel failed:', error)
    }
    this.invalidateSlot({ sessionId, profileId, reason: 'request cancelled' })
  }

  // -------------------------------------------------------------------------
  // Managed CDP connection lifecycle (called from cdp-relay)
  // -------------------------------------------------------------------------

  validateManagedConnection(request: {
    sessionId: string
    profileId?: string | null
    stableKey?: string | null
    browserEpoch?: string | null
    connectionEpoch?: string | null
  }):
    | { ok: true; scope: ManagedConnectionScope }
    | { ok: false; code: BrowserErrorCode; reason: string } {
    const profileId = (() => {
      if (request.profileId) {
        return request.profileId
      }
      if (request.stableKey) {
        const match = sortedProfiles(this.state).find((profile) => {
          return profile.stableKey === request.stableKey
        })
        return match?.profileId ?? null
      }
      const connected = sortedProfiles(this.state).filter((profile) => {
        return profile.connected
      })
      return connected.length === 1 ? connected[0].profileId : null
    })()
    if (!profileId) {
      return {
        ok: false,
        code: 'profile-required',
        reason: 'profileId or a unique managed profile is required for a managed CDP connection',
      }
    }
    const snapshot = this.state.profiles.get(profileId)
    if (!snapshot) {
      return { ok: false, code: 'profile-disconnected', reason: `unknown managed profile ${profileId}` }
    }
    if (request.stableKey && snapshot.stableKey !== request.stableKey) {
      return {
        ok: false,
        code: 'ownership-mismatch',
        reason: `extension ${request.stableKey} does not own profile ${profileId}`,
      }
    }
    if (request.browserEpoch && snapshot.browserEpoch !== request.browserEpoch) {
      return {
        ok: false,
        code: 'stale-snapshot',
        reason: `stale browserEpoch ${request.browserEpoch} (current ${snapshot.browserEpoch})`,
      }
    }
    const key = slotKey(request.sessionId, profileId)
    let slot = this.slots.get(key)
    if (request.connectionEpoch) {
      if (!slot || slot.connectionEpoch !== request.connectionEpoch) {
        return {
          ok: false,
          code: 'stale-snapshot',
          reason: 'managed control connection epoch is stale',
        }
      }
    } else {
      const active = Array.from(this.managedClients.values()).find((client) => {
        return client.sessionId === request.sessionId && client.profileId === profileId
      })
      if (active) {
        return {
          ok: false,
          code: 'stale-snapshot',
          reason: 'an active managed CDP connection already exists for this session/profile',
        }
      }
      if (!slot) {
        slot = this.createSlot({ sessionId: request.sessionId, profileId })
      }
    }
    return {
      ok: true,
      scope: {
        sessionId: request.sessionId,
        profileId,
        browserEpoch: snapshot.browserEpoch,
        connectionEpoch: slot.connectionEpoch,
        extensionConnectionId: snapshot.connectionId,
        stableKey: snapshot.stableKey,
      },
    }
  }

  noteManagedClientOpen({ clientId, scope }: { clientId: string; scope: ManagedConnectionScope }): void {
    for (const [otherId, other] of this.managedClients) {
      if (otherId !== clientId && other.sessionId === scope.sessionId && other.profileId === scope.profileId) {
        this.options.closeManagedClient({ clientId: otherId, code: 4001, reason: 'Replaced by newer managed connection' })
      }
    }
    this.managedClients.set(clientId, {
      clientId,
      sessionId: scope.sessionId,
      profileId: scope.profileId,
      browserEpoch: scope.browserEpoch,
      connectionEpoch: scope.connectionEpoch,
    })
    const slot = this.slots.get(slotKey(scope.sessionId, scope.profileId))
    if (slot) {
      slot.clientId = clientId
    }
  }

  noteManagedClientClosed({ clientId }: { clientId: string }): void {
    const entry = this.managedClients.get(clientId)
    if (!entry) {
      return
    }
    this.managedClients.delete(clientId)
    const slot = this.slots.get(slotKey(entry.sessionId, entry.profileId))
    if (slot && slot.clientId === clientId) {
      slot.clientId = null
    }
  }

  beginExecution({
    sessionId,
    profileId,
    requestId,
  }: {
    sessionId: string
    profileId: string
    requestId: string
  }): { connectionEpoch: string; cdpUrl: string } {
    const key = slotKey(sessionId, profileId)
    const existing = this.slots.get(key)
    if (existing) {
      return { connectionEpoch: existing.connectionEpoch, cdpUrl: existing.cdpUrl }
    }
    const slot = this.createSlot({ sessionId, profileId })
    return { connectionEpoch: slot.connectionEpoch, cdpUrl: slot.cdpUrl }
  }

  private createSlot({ sessionId, profileId }: { sessionId: string; profileId: string }): ManagedExecutionSlot {
    const connectionEpoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    const clientId = `managed-${connectionEpoch}`
    const params = new URLSearchParams()
    const snapshot = this.state.profiles.get(profileId)
    if (snapshot) {
      params.set('extensionId', snapshot.stableKey)
    }
    params.set('browserSessionId', sessionId)
    params.set('profileId', profileId)
    params.set('browserEpoch', snapshot?.browserEpoch ?? '')
    params.set('connectionEpoch', connectionEpoch)
    if (this.options.token) {
      params.set('token', this.options.token)
    }
    const host = this.options.host === '0.0.0.0' || this.options.host === '::' ? '127.0.0.1' : this.options.host
    const cdpUrl = `ws://${host}:${this.options.port}/cdp/${clientId}?${params.toString()}`
    const slot: ManagedExecutionSlot = { sessionId, profileId, connectionEpoch, clientId: null, cdpUrl }
    this.slots.set(slotKey(sessionId, profileId), slot)
    return slot
  }

  invalidateSlot({ sessionId, profileId, reason }: { sessionId: string; profileId: string; reason: string }): void {
    const slot = this.slots.get(slotKey(sessionId, profileId))
    if (!slot) {
      return
    }
    this.slots.delete(slotKey(sessionId, profileId))
    for (const [clientId, client] of this.managedClients) {
      if (client.sessionId === sessionId && client.profileId === profileId) {
        this.options.closeManagedClient({ clientId, code: 4002, reason: `Stale managed connection: ${reason}` })
      }
    }
  }

  private invalidateProfileExecutions({ profileId, reason }: { profileId: string; reason: string }): void {
    for (const slot of Array.from(this.slots.values())) {
      if (slot.profileId !== profileId) {
        continue
      }
      this.invalidateSlot({ sessionId: slot.sessionId, profileId: slot.profileId, reason })
    }
  }

  invalidateSessionExecutions({ sessionId, reason }: { sessionId: string; reason: string }): void {
    for (const slot of Array.from(this.slots.values())) {
      if (slot.sessionId !== sessionId) {
        continue
      }
      this.invalidateSlot({ sessionId: slot.sessionId, profileId: slot.profileId, reason })
    }
  }

  private clearProfileScopes(profileId: string): void {
    for (const key of Array.from(this.scopes.keys())) {
      if (key.endsWith(`\u0000${profileId}`)) {
        this.scopes.delete(key)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Scope derivation + CDP command/event authorization (used by cdp-relay)
  // -------------------------------------------------------------------------

  getScope({ sessionId, profileId }: { sessionId: string; profileId: string }): ManagedScopeView {
    const key = `${sessionId}\u0000${profileId}`
    let scope = this.scopes.get(key)
    if (!scope) {
      scope = {
        sessionId,
        profileId,
        targetIds: new Set(),
        tabIds: new Set(),
        ownedCdpSessionIds: new Set(),
        ownedFrameIds: new Set(),
        iframeSessionIds: new Set(),
        iframeTargetIds: new Set(),
      }
      this.scopes.set(key, scope)
    }
    scope.targetIds.clear()
    scope.tabIds.clear()
    // Session/frame sets are re-derived from the cached inventory and the
    // extension target map on every access, so stale ids cannot accumulate.
    scope.ownedCdpSessionIds.clear()
    scope.ownedFrameIds.clear()
    const snapshot = this.state.profiles.get(profileId)
    if (snapshot) {
      for (const tab of snapshot.tabs.values()) {
        if (tab.sessionId !== sessionId || tab.state === 'released') {
          continue
        }
        scope.tabIds.add(tab.tabId)
        if (tab.targetId) {
          scope.targetIds.add(tab.targetId)
        }
        if (tab.cdpSessionId) {
          scope.ownedCdpSessionIds.add(tab.cdpSessionId)
        }
      }
    }
    return scope
  }

  /** cdp-relay fills session ids and frame ids resolved from the extension target map. */
  noteOwnedTargetState({
    scope,
    cdpSessionIds,
    frameIds,
  }: {
    scope: ManagedScopeView
    cdpSessionIds: Iterable<string>
    frameIds: Iterable<string>
  }): void {
    for (const sessionId of cdpSessionIds) {
      scope.ownedCdpSessionIds.add(sessionId)
    }
    for (const frameId of frameIds) {
      scope.ownedFrameIds.add(frameId)
    }
  }

  noteIframeSession({ scope, cdpSessionId, targetId }: { scope: ManagedScopeView; cdpSessionId?: string; targetId?: string }): void {
    if (cdpSessionId) {
      scope.iframeSessionIds.add(cdpSessionId)
    }
    if (targetId) {
      scope.iframeTargetIds.add(targetId)
    }
  }

  forgetIframeSession({ scope, cdpSessionId, targetId }: { scope: ManagedScopeView; cdpSessionId?: string; targetId?: string }): void {
    if (cdpSessionId) {
      scope.iframeSessionIds.delete(cdpSessionId)
    }
    if (targetId) {
      scope.iframeTargetIds.delete(targetId)
    }
  }

  isTargetInScope({ scope, targetId }: { scope: ManagedScopeView; targetId: string }): boolean {
    return scope.targetIds.has(targetId) || scope.iframeTargetIds.has(targetId)
  }

  isCdpSessionInScope({ scope, cdpSessionId }: { scope: ManagedScopeView; cdpSessionId: string }): boolean {
    return scope.ownedCdpSessionIds.has(cdpSessionId) || scope.iframeSessionIds.has(cdpSessionId)
  }

  /**
   * Per-CDP-command authorization for managed clients. Returns a rejection message
   * or null when the command is allowed. This runs in addition to (not instead of)
   * list filtering, so a command referencing another session's target/session fails.
   */
  validateCdpCommand({ scope, method, params, sessionId }: ManagedCommandContext): string | null {
    const deniedMethods = new Set([
      'Browser.close',
      'Browser.crash',
      'Browser.crashGpuProcess',
      'Browser.grantPermissions',
      'Browser.resetPermissions',
      'Browser.setPermission',
      'Browser.setDockTile',
      'Target.createTarget',
      'Target.createBrowserContext',
      'Target.disposeBrowserContext',
    ])
    if (deniedMethods.has(method)) {
      return `${method} is not allowed for managed sessions`
    }
    if (method.startsWith('Browser.') && method !== 'Browser.getVersion' && method !== 'Browser.setDownloadBehavior') {
      return `${method} is a profile-wide operation and is not allowed for managed sessions`
    }
    if (sessionId) {
      if (!this.isCdpSessionInScope({ scope, cdpSessionId: sessionId })) {
        return `session ${sessionId} does not belong to this managed session`
      }
    }
    const targetId = isRecord(params) && typeof params.targetId === 'string' ? params.targetId : null
    if (targetId && !this.isTargetInScope({ scope, targetId })) {
      return `target ${targetId} does not belong to this managed session`
    }
    if (!sessionId && !targetId && requiresCdpSession(method)) {
      return `${method} requires an explicit managed session`
    }
    return null
  }

  /**
   * Event authorization for managed clients. Events for other sessions/profiles are
   * dropped; legal child-frame attaches are remembered so their later events pass.
   */
  isEventInScope({ scope, method, sessionId, params }: { scope: ManagedScopeView; method: string; sessionId?: string; params?: unknown }): boolean {
    const record = isRecord(params) ? params : null
    if (method === 'Target.attachedToTarget') {
      const targetInfo = record && isRecord(record.targetInfo) ? record.targetInfo : null
      const targetId = targetInfo && typeof targetInfo.targetId === 'string' ? targetInfo.targetId : null
      if (!targetId) {
        return false
      }
      if (this.isTargetInScope({ scope, targetId })) {
        return true
      }
      const parentFrameId = targetInfo && typeof targetInfo.parentFrameId === 'string' ? targetInfo.parentFrameId : null
      if (parentFrameId && scope.ownedFrameIds.has(parentFrameId)) {
        const childSessionId = record && typeof record.sessionId === 'string' ? record.sessionId : undefined
        this.noteIframeSession({ scope, cdpSessionId: childSessionId, targetId })
        return true
      }
      return false
    }
    if (method === 'Target.detachedFromTarget') {
      const detachedSessionId = record && typeof record.sessionId === 'string' ? record.sessionId : sessionId
      if (detachedSessionId && this.isCdpSessionInScope({ scope, cdpSessionId: detachedSessionId })) {
        this.forgetIframeSession({ scope, cdpSessionId: detachedSessionId })
        return true
      }
      return false
    }
    if (method === 'Target.targetInfoChanged' || method === 'Target.targetCrashed') {
      const targetInfo = record && isRecord(record.targetInfo) ? record.targetInfo : null
      const targetId = isRecord(params) && typeof params.targetId === 'string' ? params.targetId : null
      const resolved = targetId ?? (targetInfo && typeof targetInfo.targetId === 'string' ? targetInfo.targetId : null)
      return Boolean(resolved && this.isTargetInScope({ scope, targetId: resolved }))
    }
    if (sessionId) {
      return this.isCdpSessionInScope({ scope, cdpSessionId: sessionId })
    }
    if (record) {
      const targetId = typeof record.targetId === 'string' ? record.targetId : null
      if (targetId) {
        return this.isTargetInScope({ scope, targetId })
      }
      const targetInfo = isRecord(record.targetInfo) ? record.targetInfo : null
      const infoTargetId = targetInfo && typeof targetInfo.targetId === 'string' ? targetInfo.targetId : null
      if (infoTargetId) {
        return this.isTargetInScope({ scope, targetId: infoTargetId })
      }
    }
    // Events with no target/session attribution are not safely scoped to a session.
    return false
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async dispose(): Promise<void> {
    this.disposed = true
    for (const pending of this.pending.values()) {
      pending.controller.abort(new Error('relay shutting down'))
    }
    this.pending.clear()
    for (const slot of this.slots.values()) {
      this.invalidateSlot({ sessionId: slot.sessionId, profileId: slot.profileId, reason: 'relay shutting down' })
    }
    const pool = this.poolPromise ? await this.poolPromise : null
    this.poolPromise = null
    if (pool) {
      try {
        await pool.dispose()
      } catch (error) {
        this.options.logger?.error('[managed-relay] pool dispose failed:', error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private createPending({
    sessionId,
    requestId,
    profileId,
    kind,
  }: {
    sessionId: string
    requestId: string
    profileId: string
    kind: BrowserOperation['kind']
  }): PendingManagedRequest {
    const pending: PendingManagedRequest = {
      sessionId,
      requestId,
      profileId,
      kind,
      controller: new AbortController(),
      started: false,
      cancelRequested: false,
      sessionReleased: false,
      timedOut: false,
    }
    this.pending.set(`${sessionId}\u0000${requestId}`, pending)
    return pending
  }

  private abortPendingForSession(sessionId: string, reason: 'session-released'): void {
    for (const pending of this.pending.values()) {
      if (pending.sessionId !== sessionId) {
        continue
      }
      pending.sessionReleased = reason === 'session-released'
      pending.controller.abort(new Error('session released'))
    }
  }

  private abortPendingForProfile(profileId: string): void {
    for (const pending of this.pending.values()) {
      if (pending.profileId !== profileId) {
        continue
      }
      pending.controller.abort(new Error('profile disconnected'))
    }
  }

  private describeRequestError({ error, pending }: { error: unknown; pending: PendingManagedRequest }): ManagedFailure {
    const outcome = pending.started ? 'unknown' : 'not-started'
    if (pending.timedOut) {
      return { code: 'timeout', message: `request timed out after the configured deadline`, outcome }
    }
    if (pending.cancelRequested) {
      return { code: 'cancelled', message: 'request cancelled', outcome }
    }
    if (pending.sessionReleased) {
      return { code: 'cancelled', message: 'session released while the request was running', outcome }
    }
    if (error instanceof ManagedTransportError) {
      return { code: error.code, message: error.message, outcome: error.outcome }
    }
    if (error instanceof Error && pending.controller.signal.aborted) {
      return { code: 'cancelled', message: error.message, outcome }
    }
    return {
      code: 'execution-failed',
      message: error instanceof Error ? error.message : String(error),
      outcome,
    }
  }

  private awaitWithAbort<T>({ promise, signal }: { promise: Promise<T>; signal: AbortSignal }): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  private enforceResponseLimit(response: BrowserResponse, requestId: string): BrowserResponse {
    let serialized: string
    try {
      serialized = JSON.stringify(response)
    } catch (error) {
      return failureResponse(requestId, {
        code: 'internal-error',
        message: 'response could not be serialized',
        outcome: 'unknown',
      })
    }
    if (Buffer.byteLength(serialized, 'utf8') > MANAGED_RESPONSE_BODY_LIMIT_BYTES) {
      return failureResponse(requestId, {
        code: 'execution-failed',
        message: `response exceeds the ${MANAGED_RESPONSE_BODY_LIMIT_BYTES} byte limit`,
        outcome: 'unknown',
      })
    }
    return response
  }

  private pruneDedup(): void {
    const now = Date.now()
    for (const [key, entry] of this.dedup) {
      if (now - entry.timestamp > MANAGED_DEDUP_MAX_AGE_MS) {
        this.dedup.delete(key)
      }
    }
    while (this.dedup.size > MANAGED_DEDUP_LIMIT) {
      const oldest = this.dedup.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.dedup.delete(oldest)
    }
  }

  private requireRoutableProfile({
    requestId,
    profileId,
  }: {
    requestId: string
    profileId: string
  }): { ok: true; profile: ManagedProfileSnapshot } | { ok: false; response: BrowserResponse } {
    const result = this.assertProfile({ profileId, allowOffline: false, requestId })
    if (!result.ok) {
      return result
    }
    if (!result.profile) {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'profile-required',
          message: 'profileId is required for this operation',
          outcome: 'not-started',
        }),
      }
    }
    return { ok: true, profile: result.profile }
  }

  private assertProfile({
    requestId,
    profileId,
    allowOffline,
  }: {
    requestId: string
    profileId?: string
    allowOffline: boolean
  }): { ok: true; profile: ManagedProfileSnapshot | null } | { ok: false; response: BrowserResponse } {
    if (!profileId) {
      if (!allowOffline) {
        return {
          ok: false,
          response: failureResponse(requestId, {
            code: 'profile-required',
            message: 'profileId is required for this operation',
            outcome: 'not-started',
          }),
        }
      }
      return { ok: true, profile: null }
    }
    const snapshot = this.state.profiles.get(profileId)
    if (!snapshot) {
      if (!this.options.hasConnectedExtensions()) {
        return {
          ok: false,
          response: failureResponse(requestId, {
            code: 'profile-disconnected',
            message: `profile ${profileId} is not connected`,
            outcome: 'not-started',
          }),
        }
      }
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'unsupported-capability',
          message: `profile ${profileId} is not a managed profile (legacy extension?)`,
          outcome: 'not-started',
        }),
      }
    }
    if (!snapshot.connected && !allowOffline) {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'profile-disconnected',
          message: `profile ${profileId} is disconnected`,
          outcome: 'not-started',
        }),
      }
    }
    return { ok: true, profile: snapshot }
  }

  private resolveGroup({
    requestId,
    sessionId,
    groupId,
  }: {
    requestId: string
    sessionId: string
    groupId: string
  }): { ok: true; profile: ManagedProfileSnapshot; group: BrowserGroup } | { ok: false; response: BrowserResponse } {
    const found = findManagedGroup(this.state, groupId)
    if (!found) {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'resource-not-found',
          message: `group ${groupId} not found`,
          outcome: 'not-started',
        }),
      }
    }
    if (found.group.sessionId !== sessionId) {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'ownership-mismatch',
          message: `group ${groupId} belongs to another session`,
          outcome: 'not-started',
        }),
      }
    }
    if (found.group.state === 'released') {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'resource-released',
          message: `group ${groupId} was released`,
          outcome: 'not-started',
        }),
      }
    }
    return { ok: true, profile: found.profile, group: found.group }
  }

  private resolveTab({
    requestId,
    sessionId,
    tabId,
  }: {
    requestId: string
    sessionId: string
    tabId: string
  }): { ok: true; profile: ManagedProfileSnapshot; tab: BrowserTab } | { ok: false; response: BrowserResponse } {
    const found = findManagedTab(this.state, tabId)
    if (!found) {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'resource-not-found',
          message: `tab ${tabId} not found`,
          outcome: 'not-started',
        }),
      }
    }
    if (found.tab.sessionId !== sessionId) {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'ownership-mismatch',
          message: `tab ${tabId} belongs to another session`,
          outcome: 'not-started',
        }),
      }
    }
    if (found.tab.state === 'released') {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'resource-released',
          message: `tab ${tabId} was released`,
          outcome: 'not-started',
        }),
      }
    }
    if (found.tab.state === 'needs-rebind') {
      return {
        ok: false,
        response: failureResponse(requestId, {
          code: 'needs-rebind',
          message: `tab ${tabId} needs to be re-bound after a browser restart`,
          outcome: 'not-started',
        }),
      }
    }
    return { ok: true, profile: found.profile, tab: found.tab }
  }
}

function isPageOperationKind(kind: BrowserOperation['kind']): boolean {
  return kind.startsWith('page.')
}

/** Deterministic identity of a request payload for dedup collision detection. */
function buildRequestFingerprint(request: BrowserRequest): string {
  return JSON.stringify({
    operation: request.operation,
    cwd: request.cwd ?? null,
    timeoutMs: request.timeoutMs ?? null,
  })
}

function describeTransportFailure(error: unknown): ManagedFailure {
  if (error instanceof ManagedTransportError) {
    return { code: error.code, message: error.message, outcome: error.outcome }
  }
  return {
    code: 'internal-error',
    message: error instanceof Error ? error.message : String(error),
    outcome: 'unknown',
  }
}

function slotKey(sessionId: string, profileId: string): string {
  return `${sessionId}\u0000${profileId}`
}

function isManagedExecutorPoolModule(value: unknown): value is {
  ManagedExecutorPool: new (options?: ManagedExecutorPoolOptions) => ManagedExecutorPoolContract
} {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = (value as { ManagedExecutorPool?: unknown }).ManagedExecutorPool
  return typeof candidate === 'function'
}

/** CDP domains that only act on a page/target and therefore require an explicit session. */
const SESSION_BOUND_DOMAINS = new Set([
  'Accessibility',
  'Animation',
  'Audits',
  'CSS',
  'CacheStorage',
  'Cast',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'DOMStorage',
  'Debugger',
  'DeviceOrientation',
  'Emulation',
  'EventBreakpoints',
  'FedCm',
  'HeadlessExperimental',
  'HeapProfiler',
  'IndexedDB',
  'Input',
  'Inspector',
  'LayerTree',
  'Log',
  'Media',
  'Memory',
  'Network',
  'Overlay',
  'PWA',
  'Page',
  'Performance',
  'Profiler',
  'Runtime',
  'ServiceWorker',
  'Storage',
  'Tracing',
  'WebAudio',
  'WebAuthn',
])

function requiresCdpSession(method: string): boolean {
  if (method.startsWith('Target.')) {
    return false
  }
  if (method.startsWith('Browser.')) {
    return false
  }
  if (method === 'Schema.getDomains' || method === 'SystemInfo.getInfo') {
    return false
  }
  const domain = method.split('.')[0]
  return SESSION_BOUND_DOMAINS.has(domain)
}
