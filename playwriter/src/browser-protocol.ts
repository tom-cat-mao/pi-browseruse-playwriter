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

export interface BrowserCapabilities {
  protocolVersion: typeof BROWSER_PROTOCOL_VERSION
  managedGroups: boolean
  persistentOwnership: boolean
  explicitTabs: boolean
  isolatedExecution: boolean
}

export interface BrowserProfile {
  profileId: string
  browser: string
  label: string
  connected: boolean
  browserEpoch: string
  capabilities: BrowserCapabilities
}

export interface BrowserGroup {
  groupId: string
  sessionId: string
  profileId: string
  name: string
  state: BrowserResourceState
  browserEpoch: string
  revision: number
  chromeGroupId?: number
  windowId?: number
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
  chromeTabId: number
  targetId?: string
  cdpSessionId?: string
}

export type BrowserOperation =
  | { kind: 'profiles.list' }
  | { kind: 'groups.list'; profileId?: string }
  | { kind: 'groups.create'; profileId: string; name: string }
  | { kind: 'groups.rename'; groupId: string; name: string }
  | { kind: 'groups.close'; groupId: string }
  | { kind: 'tabs.list'; groupId?: string }
  | { kind: 'tabs.create'; groupId: string; url: string }
  | { kind: 'tabs.close'; tabId: string }
  | { kind: 'tabs.release'; tabId: string }
  | { kind: 'tab.resolve'; tabId: string }
  | { kind: 'session.release' }
  | { kind: 'request.cancel'; targetRequestId: string }
  | { kind: 'page.navigate'; tabId: string; url: string }
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

export interface BrowserResultData {
  text?: string
  value?: BrowserJson
  profiles?: BrowserProfile[]
  groups?: BrowserGroup[]
  tabs?: BrowserTab[]
  group?: BrowserGroup
  tab?: BrowserTab
  snapshotId?: string
  images?: BrowserImage[]
  artifacts?: BrowserArtifact[]
  logs?: string[]
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

export interface ManagedExecutorPoolContract {
  execute(options: ManagedExecution & { signal?: AbortSignal }): Promise<BrowserResponse>
  cancel(options: { sessionId: string; requestId: string }): Promise<void>
  releaseSession(options: { sessionId: string }): Promise<void>
  disconnectProfile(options: { profileId: string }): Promise<void>
  dispose(): Promise<void>
}
