export const BROWSER_PROTOCOL_VERSION = 1
export const BROWSER_RUNTIME_PORT = 19989

export type BrowserResourceState = 'ready' | 'disconnected' | 'released' | 'needs-rebind'
export type BrowserErrorCode =
  | 'invalid-request'
  | 'unsupported-capability'
  | 'profile-disconnected'
  | 'profile-required'
  | 'resource-not-found'
  | 'ownership-mismatch'
  | 'resource-released'
  | 'needs-rebind'
  | 'stale-snapshot'
  | 'execution-failed'
  | 'cancelled'
  | 'timeout'
  | 'outcome-unknown'
  | 'internal-error'

export type BrowserJson =
  | null
  | boolean
  | number
  | string
  | BrowserJson[]
  | { [key: string]: BrowserJson }

export type BrowserBackend = 'cdp' | 'webextension'

export interface BrowserCapabilities {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  managedGroups: boolean
  persistentOwnership: boolean
  explicitTabs: boolean
  isolatedExecution: boolean
  /** Optional so a profile served by an older extension keeps working. */
  existingTabControl?: boolean
  backend?: BrowserBackend
  inputMode?: 'native' | 'dom'
  snapshotMode?: 'native-ax' | 'dom-aria'
  executeMode?: 'playwright' | 'dom-compatible'
  evaluateWorld?: 'page' | 'isolated'
  limitations?: string[]
  supportedOperations?: BrowserPageOperation['kind'][]
}

export interface BrowserProfile {
  profileId: string
  browser: string
  label: string
  connected: boolean
  browserEpoch: string
  capabilities: BrowserCapabilities
}

/**
 * How a resource came under this session's control. `task` is the original
 * auto-grouped/task-owned flow; `existing` marks a tab the user was already
 * using (and the child tabs opened from it) that we attached in place.
 *
 * `existing` groups carry no Chrome group binding on purpose: they must never be
 * released by reconcile/tab.resolve just because the tab is not inside a task
 * group, and attaching one must not pull the user's other same-group tabs in.
 */
export type BrowserTabOrigin = 'task' | 'existing'

export interface BrowserGroup {
  groupId: string
  sessionId: string
  profileId: string
  name: string
  state: BrowserResourceState
  browserEpoch: string
  revision: number
  chromeGroupId?: number
  browserGroupId?: number
  windowId?: number
  origin?: BrowserTabOrigin
}

export interface BrowserTab {
  tabId: string
  groupId: string
  sessionId: string
  profileId: string
  url: string
  title: string
  state: BrowserResourceState
  browserEpoch: string
  revision: number
  /** Legacy CDP identity. Firefox uses -1 and supplies browserTabId. */
  chromeTabId: number
  browserTabId?: number
  targetId?: string
  cdpSessionId?: string
  origin?: BrowserTabOrigin
  /** Managed tab a new tab was opened from (target=_blank / window.open). */
  sourceTabId?: string
}

/**
 * One real tab found in a connected profile. Discovery metadata only: listing
 * candidates never reads page content.
 *
 * `candidateId` is what `tabs.attach` takes. It pins profile + browserEpoch +
 * chromeTabId, so a stale discovery can never attach an unrelated tab.
 */
export interface BrowserTabCandidate {
  candidateId: string
  profileId: string
  profileLabel: string
  browser: string
  browserEpoch: string
  windowId: number
  /** True when this is the active tab of its own window (every window has one). */
  active: boolean
  /** True when its window currently has OS focus (false right after the user
   *  switches back to the terminal - never treated as "the one current tab"). */
  windowFocused: boolean
  chromeTabId: number
  browserTabId?: number
  backend?: BrowserBackend
  url: string
  title: string
  /** Already under this session's control; attach returns the existing tab. */
  managed: boolean
  ownedByThisSession: boolean
  /** Set when the tab is already managed by this session. */
  tabId?: string
  /** False when attach would be refused (restricted page, another session...). */
  attachable: boolean
  /** Why it cannot be attached, or why it is not listed as attachable. */
  reason?: 'restricted-url' | 'owned-by-other-session' | 'unsupported-page'
}

const TAB_CANDIDATE_PREFIX = 'pcdt'

/**
 * Single source of truth for discovery identity. Every layer (extension, relay,
 * Pi) uses these instead of re-deriving the format.
 */
export function buildTabCandidateId(options: {
  profileId: string
  browserEpoch: string
  chromeTabId: number
}): string {
  return `${TAB_CANDIDATE_PREFIX}:${options.profileId}:${options.browserEpoch}:${options.chromeTabId}`
}

export function parseTabCandidateId(
  candidateId: string,
): { profileId: string; browserEpoch: string; chromeTabId: number } | null {
  if (typeof candidateId !== 'string') return null
  const parts = candidateId.split(':')
  if (parts.length !== 4 || parts[0] !== TAB_CANDIDATE_PREFIX) return null
  const chromeTabId = Number(parts[3])
  if (!Number.isInteger(chromeTabId) || chromeTabId < 0) return null
  return { profileId: parts[1], browserEpoch: parts[2], chromeTabId }
}

export function buildFirefoxTabCandidateId(options: {
  profileId: string
  browserEpoch: string
  browserTabId: number
}): string {
  return `pfxdt:${options.profileId}:${options.browserEpoch}:${options.browserTabId}`
}

export function parseBrowserTabCandidateId(candidateId: string): {
  profileId: string
  browserEpoch: string
  browserTabId: number
  backend: BrowserBackend
} | null {
  const legacy = parseTabCandidateId(candidateId)
  if (legacy) {
    return { profileId: legacy.profileId, browserEpoch: legacy.browserEpoch, browserTabId: legacy.chromeTabId, backend: 'cdp' }
  }
  const parts = candidateId.split(':')
  if (parts.length !== 4 || parts[0] !== 'pfxdt' || !parts[1] || !parts[2] || !/^(0|[1-9]\d*)$/.test(parts[3])) return null
  const browserTabId = Number(parts[3])
  if (!Number.isSafeInteger(browserTabId)) return null
  return { profileId: parts[1], browserEpoch: parts[2], browserTabId, backend: 'webextension' }
}

export type BrowserOperation =
  | { kind: 'profiles.list' }
  | { kind: 'groups.list'; profileId?: string }
  | { kind: 'groups.create'; profileId: string; name: string }
  | { kind: 'groups.rename'; groupId: string; name: string }
  | { kind: 'groups.close'; groupId: string }
  | { kind: 'tabs.list'; groupId?: string; sourceTabId?: string }
  | { kind: 'tabs.create'; groupId: string; url: string }
  | { kind: 'tabs.discover'; profileId?: string; windowId?: number; query?: string; includeManaged?: boolean }
  | { kind: 'tabs.attach'; candidateId: string }
  | { kind: 'tabs.activate'; tabId: string }
  | { kind: 'tabs.close'; tabId: string }
  | { kind: 'tabs.release'; tabId: string }
  | { kind: 'tab.resolve'; tabId: string }
  | { kind: 'session.release' }
  | { kind: 'request.cancel'; targetRequestId: string }
  | { kind: 'page.navigate'; tabId: string; url: string }
  | { kind: 'page.back'; tabId: string }
  | { kind: 'page.snapshot'; tabId: string; selector?: string; search?: string; full?: boolean; interactiveOnly?: boolean }
  | { kind: 'page.click'; tabId: string; selector: string; snapshotId?: string }
  | { kind: 'page.fill'; tabId: string; selector: string; value: string; snapshotId?: string }
  | { kind: 'page.evaluate'; tabId: string; code: string }
  | { kind: 'page.screenshot'; tabId: string; path?: string; fullPage?: boolean; labels?: boolean }
  | { kind: 'page.network'; tabId: string; action: 'start' | 'list' | 'stop'; filter?: string }
  | { kind: 'page.logs'; tabId: string; limit?: number }
  | { kind: 'page.execute'; tabId: string; code: string }

export type BrowserPageOperation = Extract<BrowserOperation, { kind: `page.${string}` }>
export type BrowserControlOperation = Exclude<BrowserOperation, BrowserPageOperation>

export interface BrowserRequest {
  requestId: string
  sessionId: string
  operation: BrowserOperation
  cwd?: string
  timeoutMs?: number
}

export interface BrowserArtifact {
  path: string
  mimeType: string
}

export interface BrowserImage {
  data: string
  mimeType: string
}

export type BrowserNetworkCaptureStatus = 'active' | 'stopped' | 'interrupted' | 'not-started'

export interface BrowserNetworkCaptureMetadata {
  status: BrowserNetworkCaptureStatus
  captureId?: string
  retainedCount: number
  droppedCount: number
  reason?: string
}

export interface BrowserPageInfo {
  tabId: string
  url: string
  title?: string
}

export interface BrowserResultData {
  text?: string
  value?: BrowserJson
  profiles?: BrowserProfile[]
  groups?: BrowserGroup[]
  tabs?: BrowserTab[]
  candidates?: BrowserTabCandidate[]
  group?: BrowserGroup
  tab?: BrowserTab
  snapshotId?: string
  images?: BrowserImage[]
  artifacts?: BrowserArtifact[]
  logs?: string[]
  networkCapture?: BrowserNetworkCaptureMetadata
  pageInfo?: BrowserPageInfo
}

export type BrowserResponse =
  | { requestId: string; ok: true; data: BrowserResultData }
  | {
      requestId: string
      ok: false
      error: {
        code: BrowserErrorCode
        message: string
        outcome: 'not-started' | 'unknown'
      }
    }

export interface BrowserInventory {
  backend?: BrowserBackend
  capabilities?: BrowserCapabilities
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  profileId: string
  browserEpoch: string
  revision: number
  groups: BrowserGroup[]
  tabs: BrowserTab[]
}

export interface BrowserInventoryMessage {
  method: 'browserInventory'
  params: BrowserInventory
}

export interface BrowserExtensionRequest {
  id: number
  method: 'browserRequest'
  params: BrowserRequest
}

export interface ManagedExecution {
  request: BrowserRequest & { operation: BrowserPageOperation }
  tab: BrowserTab
  cdpUrl: string
  connectionEpoch: string
}

export interface ManagedExecutorPoolOptions {
  workerPath?: string
  onInvalidate?: (options: {
    sessionId: string
    profileId: string
    connectionEpoch: string
  }) => void | Promise<void>
}

/** Why a managed executor task is being stopped. Internal to the relay→pool
 *  boundary: a server deadline must never be reported as a user cancel. */
export type ManagedCancelReason = 'cancelled' | 'timeout'

export interface ManagedExecutorPoolContract {
  execute(options: ManagedExecution & { signal?: AbortSignal }): Promise<BrowserResponse>
  cancel(options: { sessionId: string; requestId: string; reason?: ManagedCancelReason }): Promise<void>
  releaseSession(options: { sessionId: string }): Promise<void>
  disconnectProfile(options: { profileId: string }): Promise<void>
  dispose(): Promise<void>
}

/** Serialized locator program; physical page ownership is carried by the envelope. */
export interface BrowserDomLocator {
  steps: BrowserDomLocatorStep[]
  snapshotId?: string
}

export type BrowserDomLocatorStep =
  | {
      kind: 'selector'
      engine: 'css' | 'role' | 'text' | 'label' | 'placeholder' | 'testId' | 'alt' | 'title'
      value: string
      name?: string
      exact?: boolean
      options?: {
        checked?: boolean
        disabled?: boolean
        expanded?: boolean
        selected?: boolean
        pressed?: boolean
        level?: number
        includeHidden?: boolean
      }
    }
  | { kind: 'nth'; index: number }
  | { kind: 'filter'; hasText?: string; hasNotText?: string; has?: BrowserDomLocator; hasNot?: BrowserDomLocator }
  | { kind: 'frame'; selector: string }

export type BrowserDomLocatorAction =
  | 'count' | 'click' | 'dblclick' | 'fill' | 'type' | 'press' | 'check' | 'uncheck' | 'setChecked'
  | 'selectOption' | 'hover' | 'focus' | 'blur' | 'scrollIntoViewIfNeeded' | 'waitFor'
  | 'textContent' | 'innerText' | 'innerHTML' | 'inputValue' | 'getAttribute'
  | 'allTextContents' | 'allInnerTexts' | 'isVisible' | 'isHidden' | 'isEnabled' | 'isDisabled'
  | 'isEditable' | 'isChecked' | 'boundingBox'

export type BrowserDomCommand =
  | { method: 'snapshot'; selector?: string; search?: string; full?: boolean; interactiveOnly?: boolean }
  | { method: 'click'; selector: string; snapshotId?: string }
  | { method: 'fill'; selector: string; value: string; snapshotId?: string }
  | { method: 'evaluate'; code: string; locator?: BrowserDomLocator }
  | { method: 'locator'; locator: BrowserDomLocator; action: BrowserDomLocatorAction; args?: BrowserJson[]; expectedPoint?: { x: number; y: number }; preparationId?: string }
  | { method: 'page'; action: 'title' | 'url' | 'content' | 'readyState' }
  | { method: 'frame.resolve'; locator: BrowserDomLocator }
  | { method: 'frame.check'; locator: BrowserDomLocator; point: { x: number; y: number } }
  | { method: 'frame.actionPoint'; locator: BrowserDomLocator; action: BrowserDomLocatorAction; args?: BrowserJson[] }
  | { method: 'invalidate' | 'dispose' }
  | { method: 'screenshot.prepare'; fullPage?: boolean; labels?: boolean }
  | { method: 'screenshot.cleanup' }
  | { method: 'logs'; limit?: number }
  | { method: 'operation'; operation: Exclude<BrowserPageOperation, { kind: 'page.execute' }> }

export interface BrowserDomRequest {
  requestId: string
  sessionId: string
  tabId: string
  browserEpoch: string
  command: BrowserDomCommand
  timeoutMs?: number
}

export interface BrowserExtensionDomRequest {
  id: number
  method: 'browserDomRequest'
  params: BrowserDomRequest
}
