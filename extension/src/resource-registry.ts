import { BROWSER_PROTOCOL_VERSION } from 'playwriter/src/browser-protocol'
import type { BrowserGroup, BrowserInventory, BrowserResourceState, BrowserTab } from 'playwriter/src/browser-protocol'

/**
 * Persistent ownership registry for managed (Pi) browser resources.
 *
 * This module is pure data-in / data-out so every ownership transition can be
 * unit tested without Chrome. The extension keeps the authoritative records in
 * chrome.storage.local and materializes them in background.ts:
 *
 * - logical groupId / tabId are opaque strings, never Chrome's numeric ids.
 * - chromeGroupId / windowId / chromeTabId are separate physical mappings that
 *   only describe one browser run (browserEpoch).
 * - records stay in the registry while the relay is offline; disconnects must
 *   never dissolve a group or drop ownership. Only explicit close/release (or a
 *   verified Chrome-side removal) writes a tombstone.
 * - released records are tombstones: they are published in inventories so the
 *   relay reports them as released and rejects operations on them, but they
 *   never authorize work, and reconnect/reconcile can never pull a
 *   user-released tab back into a group.
 * - a browser restart (new browserEpoch) makes old physical mappings
 *   unverifiable. Those records become needs-rebind instead of being silently
 *   adopted by chromeTabId/title/url guessing.
 */

export const MANAGED_REGISTRY_VERSION = 1

export interface ManagedResourceRegistry {
  version: typeof MANAGED_REGISTRY_VERSION
  profileId: string
  browserEpoch: string
  revision: number
  groups: BrowserGroup[]
  tabs: BrowserTab[]
  requestLedger: RequestLedgerEntry[]
}

/**
 * Completed-create dedup ledger. Persisted so a retried create request cannot
 * create a second group/tab after a relay reconnect or service-worker restart.
 * Entries start as `pending` (written before Chrome side effects) and flip to
 * `completed` in the same transaction as the final record update.
 */
export interface RequestLedgerEntry {
  sessionId: string
  requestId: string
  operation: 'groups.create' | 'tabs.create'
  /** Payload fingerprint; a retry with the same requestId must match it. */
  fingerprint: string
  phase: 'pending' | 'completed'
  createdAt: number
  groupId?: string
  tabId?: string
  chromeTabId?: number
}

export function createEmptyRegistry(options: { profileId: string; browserEpoch: string }): ManagedResourceRegistry {
  return {
    version: MANAGED_REGISTRY_VERSION,
    profileId: options.profileId,
    browserEpoch: options.browserEpoch,
    revision: 0,
    groups: [],
    tabs: [],
    requestLedger: [],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readState(value: unknown): BrowserResourceState | undefined {
  if (value === 'ready' || value === 'disconnected' || value === 'released' || value === 'needs-rebind') {
    return value
  }
  return undefined
}

function readGroup(value: unknown): BrowserGroup | null {
  if (!isRecord(value)) return null
  const groupId = readString(value.groupId)
  const sessionId = readString(value.sessionId)
  const profileId = readString(value.profileId)
  const name = readString(value.name)
  const state = readState(value.state)
  const browserEpoch = readString(value.browserEpoch)
  const revision = readNumber(value.revision)
  if (!groupId || !sessionId || !profileId || !name || !state || !browserEpoch || revision === undefined) {
    return null
  }
  const chromeGroupId = readNumber(value.chromeGroupId)
  const windowId = readNumber(value.windowId)
  return {
    groupId,
    sessionId,
    profileId,
    name,
    state,
    browserEpoch,
    revision,
    ...(chromeGroupId !== undefined ? { chromeGroupId } : {}),
    ...(windowId !== undefined ? { windowId } : {}),
  }
}

function readTab(value: unknown): BrowserTab | null {
  if (!isRecord(value)) return null
  const tabId = readString(value.tabId)
  const groupId = readString(value.groupId)
  const sessionId = readString(value.sessionId)
  const profileId = readString(value.profileId)
  const url = readString(value.url)
  const title = readString(value.title)
  const state = readState(value.state)
  const browserEpoch = readString(value.browserEpoch)
  const revision = readNumber(value.revision)
  const chromeTabId = readNumber(value.chromeTabId)
  if (
    !tabId ||
    !groupId ||
    !sessionId ||
    !profileId ||
    url === undefined ||
    title === undefined ||
    !state ||
    !browserEpoch ||
    revision === undefined ||
    chromeTabId === undefined
  ) {
    return null
  }
  const targetId = readString(value.targetId)
  const cdpSessionId = readString(value.cdpSessionId)
  return {
    tabId,
    groupId,
    sessionId,
    profileId,
    url,
    title,
    state,
    browserEpoch,
    revision,
    chromeTabId,
    ...(targetId !== undefined ? { targetId } : {}),
    ...(cdpSessionId !== undefined ? { cdpSessionId } : {}),
  }
}

function readLedgerEntry(value: unknown): RequestLedgerEntry | null {
  if (!isRecord(value)) return null
  const sessionId = readString(value.sessionId)
  const requestId = readString(value.requestId)
  const operation =
    value.operation === 'groups.create' || value.operation === 'tabs.create' ? value.operation : undefined
  const fingerprint = readString(value.fingerprint)
  const createdAt = readNumber(value.createdAt)
  if (!sessionId || !requestId || !operation || !fingerprint || createdAt === undefined) return null
  // Entries persisted before the pending phase existed are completed creates.
  const phase = value.phase === 'pending' ? 'pending' : 'completed'
  const groupId = readString(value.groupId)
  const tabId = readString(value.tabId)
  const chromeTabId = readNumber(value.chromeTabId)
  return {
    sessionId,
    requestId,
    operation,
    fingerprint,
    phase,
    createdAt,
    ...(groupId !== undefined ? { groupId } : {}),
    ...(tabId !== undefined ? { tabId } : {}),
    ...(chromeTabId !== undefined ? { chromeTabId } : {}),
  }
}

/** Defensive parse of persisted JSON - storage can hold anything. */
export function parseRegistry(raw: unknown): ManagedResourceRegistry | null {
  if (!isRecord(raw)) return null
  if (raw.version !== MANAGED_REGISTRY_VERSION) return null
  const profileId = readString(raw.profileId)
  const browserEpoch = readString(raw.browserEpoch)
  const revision = readNumber(raw.revision)
  if (!profileId || !browserEpoch || revision === undefined) return null
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.tabs)) return null

  const groups = raw.groups.map(readGroup).filter((group): group is BrowserGroup => group !== null)
  const tabs = raw.tabs.map(readTab).filter((tab): tab is BrowserTab => tab !== null)
  if (groups.length !== raw.groups.length || tabs.length !== raw.tabs.length) return null

  // The ledger is dedup metadata, not ownership: unknown fields and malformed
  // entries are dropped instead of rejecting the whole registry.
  const ledgerRaw = raw.requestLedger
  const requestLedger = Array.isArray(ledgerRaw)
    ? ledgerRaw.map(readLedgerEntry).filter((entry): entry is RequestLedgerEntry => entry !== null)
    : []

  return { version: MANAGED_REGISTRY_VERSION, profileId, browserEpoch, revision, groups, tabs, requestLedger }
}

export function findGroup(registry: ManagedResourceRegistry, groupId: string): BrowserGroup | undefined {
  return registry.groups.find((group) => group.groupId === groupId)
}

export function findTab(registry: ManagedResourceRegistry, tabId: string): BrowserTab | undefined {
  return registry.tabs.find((tab) => tab.tabId === tabId)
}

export function findTabByChromeTabId(registry: ManagedResourceRegistry, chromeTabId: number): BrowserTab | undefined {
  return registry.tabs.find((tab) => tab.chromeTabId === chromeTabId)
}

/**
 * Chrome numeric ids are only meaningful inside one browser run: after a restart
 * (or cleared session storage) the same number can belong to an unrelated tab.
 * Runtime lookups must therefore always pin the current epoch and skip records
 * that are released or waiting for a rebind.
 */
export function findActiveTabByChromeTabId(
  registry: ManagedResourceRegistry,
  options: { chromeTabId: number; browserEpoch: string },
): BrowserTab | undefined {
  return registry.tabs.find((tab) => {
    return (
      tab.chromeTabId === options.chromeTabId &&
      tab.browserEpoch === options.browserEpoch &&
      tab.state !== 'released' &&
      tab.state !== 'needs-rebind'
    )
  })
}

/** Tombstone lookup used to block stale async flows from re-adopting a released tab. */
export function isChromeTabTombstoned(
  registry: ManagedResourceRegistry,
  chromeTabId: number,
  options: { browserEpoch?: string } = {},
): boolean {
  return registry.tabs.some((tab) => {
    if (tab.chromeTabId !== chromeTabId || tab.state !== 'released') return false
    if (options.browserEpoch !== undefined && tab.browserEpoch !== options.browserEpoch) return false
    return true
  })
}

export function activeTabsForGroup(registry: ManagedResourceRegistry, groupId: string): BrowserTab[] {
  return registry.tabs.filter((tab) => tab.groupId === groupId && tab.state !== 'released')
}

/** Released groups are tombstones: never listed as usable session resources. */
export function listSessionGroups(
  registry: ManagedResourceRegistry,
  sessionId: string,
  profileId?: string,
): BrowserGroup[] {
  return registry.groups.filter((group) => {
    if (group.sessionId !== sessionId) return false
    if (group.state === 'released') return false
    if (profileId !== undefined && group.profileId !== profileId) return false
    return true
  })
}

/** Released tabs are tombstones: never listed as usable session resources. */
export function listSessionTabs(registry: ManagedResourceRegistry, sessionId: string, groupId?: string): BrowserTab[] {
  return registry.tabs.filter((tab) => {
    if (tab.sessionId !== sessionId) return false
    if (tab.state === 'released') return false
    if (groupId !== undefined && tab.groupId !== groupId) return false
    return true
  })
}

function cloneWithRevision(
  registry: ManagedResourceRegistry,
  changes: { groups?: BrowserGroup[]; tabs?: BrowserTab[]; requestLedger?: RequestLedgerEntry[] },
): ManagedResourceRegistry {
  const next: ManagedResourceRegistry = {
    ...registry,
    revision: registry.revision + 1,
    groups: changes.groups ?? registry.groups,
    tabs: changes.tabs ?? registry.tabs,
    requestLedger: changes.requestLedger ?? registry.requestLedger,
  }
  return next
}

export function addGroup(
  registry: ManagedResourceRegistry,
  options: { groupId: string; sessionId: string; name: string; browserEpoch: string },
): ManagedResourceRegistry {
  const group: BrowserGroup = {
    groupId: options.groupId,
    sessionId: options.sessionId,
    profileId: registry.profileId,
    name: options.name,
    state: 'ready',
    browserEpoch: options.browserEpoch,
    revision: registry.revision + 1,
  }
  return cloneWithRevision(registry, { groups: [...registry.groups, group] })
}

export function renameGroup(
  registry: ManagedResourceRegistry,
  options: { groupId: string; name: string },
): ManagedResourceRegistry {
  const groups = registry.groups.map((group) => {
    if (group.groupId !== options.groupId) return group
    return { ...group, name: options.name, revision: registry.revision + 1 }
  })
  return cloneWithRevision(registry, { groups })
}

export function setGroupChromeBinding(
  registry: ManagedResourceRegistry,
  options: { groupId: string; chromeGroupId: number; windowId: number },
): ManagedResourceRegistry {
  const groups = registry.groups.map((group) => {
    if (group.groupId !== options.groupId) return group
    return {
      ...group,
      chromeGroupId: options.chromeGroupId,
      windowId: options.windowId,
      revision: registry.revision + 1,
    }
  })
  return cloneWithRevision(registry, { groups })
}

/** Drops the physical Chrome group binding while keeping the logical group alive. */
export function clearGroupChromeBinding(
  registry: ManagedResourceRegistry,
  options: { groupId: string },
): ManagedResourceRegistry {
  const groups = registry.groups.map((group) => {
    if (group.groupId !== options.groupId || group.chromeGroupId === undefined) return group
    const { chromeGroupId: _chromeGroupId, ...rest } = group
    return { ...rest, revision: registry.revision + 1 }
  })
  return cloneWithRevision(registry, { groups })
}

/** Tracks where the Chrome group lives after the user moves it between windows. */
export function setGroupWindowId(
  registry: ManagedResourceRegistry,
  options: { groupId: string; windowId: number },
): ManagedResourceRegistry {
  const group = findGroup(registry, options.groupId)
  if (!group || group.windowId === options.windowId) return registry
  const groups = registry.groups.map((candidate) => {
    if (candidate.groupId !== options.groupId) return candidate
    return { ...candidate, windowId: options.windowId, revision: registry.revision + 1 }
  })
  return cloneWithRevision(registry, { groups })
}

export function setGroupState(
  registry: ManagedResourceRegistry,
  options: { groupId: string; state: BrowserResourceState },
): ManagedResourceRegistry {
  const groups = registry.groups.map((group) => {
    if (group.groupId !== options.groupId) return group
    return { ...group, state: options.state, revision: registry.revision + 1 }
  })
  return cloneWithRevision(registry, { groups })
}

export function addTab(
  registry: ManagedResourceRegistry,
  options: {
    tabId: string
    groupId: string
    sessionId: string
    chromeTabId: number
    url: string
    title: string
    browserEpoch: string
  },
): ManagedResourceRegistry {
  const tab: BrowserTab = {
    tabId: options.tabId,
    groupId: options.groupId,
    sessionId: options.sessionId,
    profileId: registry.profileId,
    url: options.url,
    title: options.title,
    state: 'disconnected',
    browserEpoch: options.browserEpoch,
    revision: registry.revision + 1,
    chromeTabId: options.chromeTabId,
  }
  return cloneWithRevision(registry, { tabs: [...registry.tabs, tab] })
}

function updateTab(
  registry: ManagedResourceRegistry,
  tabId: string,
  update: (tab: BrowserTab) => BrowserTab,
): ManagedResourceRegistry {
  const tabs = registry.tabs.map((tab) => {
    if (tab.tabId !== tabId) return tab
    return update(tab)
  })
  return cloneWithRevision(registry, { tabs })
}

/** Marks a tab released (tombstone). Never resurrected by reconnect/reconcile. */
export function releaseTab(registry: ManagedResourceRegistry, tabId: string): ManagedResourceRegistry {
  const tab = findTab(registry, tabId)
  if (!tab || tab.state === 'released') return registry
  return updateTab(registry, tabId, (current) => {
    const { targetId: _targetId, cdpSessionId: _cdpSessionId, ...rest } = current
    return { ...rest, state: 'released', revision: registry.revision + 1 }
  })
}

export function setTabAttachment(
  registry: ManagedResourceRegistry,
  options: { tabId: string; targetId: string; cdpSessionId: string },
): ManagedResourceRegistry {
  const tab = findTab(registry, options.tabId)
  if (!tab || tab.state === 'released') return registry
  return updateTab(registry, options.tabId, (current) => {
    return {
      ...current,
      state: 'ready',
      targetId: options.targetId,
      cdpSessionId: options.cdpSessionId,
      revision: registry.revision + 1,
    }
  })
}

export function clearTabAttachment(registry: ManagedResourceRegistry, tabId: string): ManagedResourceRegistry {
  const tab = findTab(registry, tabId)
  if (!tab || tab.state === 'released') return registry
  return updateTab(registry, tabId, (current) => {
    const { targetId: _targetId, cdpSessionId: _cdpSessionId, ...rest } = current
    return { ...rest, state: 'disconnected', revision: registry.revision + 1 }
  })
}

export function setTabPageInfo(
  registry: ManagedResourceRegistry,
  options: { tabId: string; url: string; title: string },
): ManagedResourceRegistry {
  const tab = findTab(registry, options.tabId)
  if (!tab || tab.state === 'released') return registry
  if (tab.url === options.url && tab.title === options.title) return registry
  return updateTab(registry, options.tabId, (current) => {
    return { ...current, url: options.url, title: options.title, revision: registry.revision + 1 }
  })
}

export type CreateDedupeDecision = 'proceed' | 'replay' | 'recover-pending' | 'reject-payload-mismatch'

/**
 * Pure decision for a create request that may have completed before (ledger
 * entry) or be retried with the same requestId. Reusing a requestId with a
 * different operation or payload is always rejected. A `pending` entry means a
 * previous attempt was interrupted before completion, so the caller must verify
 * and resume instead of replaying side effects.
 */
export function classifyCreateRequestDedupe(options: {
  ledgerEntry: RequestLedgerEntry | undefined
  operation: RequestLedgerEntry['operation']
  fingerprint: string
}): CreateDedupeDecision {
  const entry = options.ledgerEntry
  if (!entry) return 'proceed'
  if (entry.operation !== options.operation || entry.fingerprint !== options.fingerprint) {
    return 'reject-payload-mismatch'
  }
  return entry.phase === 'pending' ? 'recover-pending' : 'replay'
}

export type PendingCreateRecovery = 'resume-attach' | 'released' | 'resource-not-recorded' | 'unknown'

/**
 * Decides what a retry may do for an interrupted (pending) create. The only
 * non-destructive outcome is resuming the debugger attachment for a tab that is
 * verifiably still ours; navigation is never replayed because we cannot know
 * whether it was already sent.
 */
export function classifyPendingCreateRecovery(options: {
  hasRecord: boolean
  recordState: BrowserResourceState | 'missing'
  recordBrowserEpoch: string | undefined
  browserEpoch: string
  chromeTabExists: boolean
  observedChromeGroupId: number | null
  expectedChromeGroupId: number | undefined
}): PendingCreateRecovery {
  if (!options.hasRecord) return 'resource-not-recorded'
  if (options.recordState === 'released') return 'released'
  if (options.recordBrowserEpoch !== options.browserEpoch) return 'unknown'
  if (!options.chromeTabExists) return 'unknown'
  if (options.expectedChromeGroupId !== undefined && options.observedChromeGroupId !== options.expectedChromeGroupId) {
    return 'unknown'
  }
  return 'resume-attach'
}

/** Flips a pending ledger entry to completed (same transaction as the record). */
export function updateRequestLedgerPhase(
  registry: ManagedResourceRegistry,
  options: {
    sessionId: string
    requestId: string
    phase: RequestLedgerEntry['phase']
    chromeTabId?: number
  },
): ManagedResourceRegistry {
  const requestLedger = registry.requestLedger.map((entry) => {
    if (entry.sessionId !== options.sessionId || entry.requestId !== options.requestId) return entry
    return {
      ...entry,
      phase: options.phase,
      ...(options.chromeTabId !== undefined ? { chromeTabId: options.chromeTabId } : {}),
    }
  })
  if (requestLedger.every((entry, index) => entry === registry.requestLedger[index])) return registry
  return cloneWithRevision(registry, { requestLedger })
}

/** Stable payload fingerprint for create dedup: retries must match it exactly. */
export function buildCreateRequestFingerprint(
  operation: { kind: 'groups.create'; name: string } | { kind: 'tabs.create'; groupId: string; url: string },
): string {
  if (operation.kind === 'groups.create') {
    return `groups.create|name=${operation.name}`
  }
  return `tabs.create|groupId=${operation.groupId}|url=${operation.url}`
}

export function findRequestLedgerEntry(
  registry: ManagedResourceRegistry,
  options: { sessionId: string; requestId: string },
): RequestLedgerEntry | undefined {
  return registry.requestLedger.find((entry) => {
    return entry.sessionId === options.sessionId && entry.requestId === options.requestId
  })
}

export function removeRequestLedgerEntry(
  registry: ManagedResourceRegistry,
  options: { sessionId: string; requestId: string },
): ManagedResourceRegistry {
  const requestLedger = registry.requestLedger.filter((entry) => {
    return !(entry.sessionId === options.sessionId && entry.requestId === options.requestId)
  })
  if (requestLedger.length === registry.requestLedger.length) return registry
  return cloneWithRevision(registry, { requestLedger })
}

export function appendRequestLedgerEntry(
  registry: ManagedResourceRegistry,
  options: { entry: RequestLedgerEntry; now: number; maxEntries: number; maxAgeMs: number },
): ManagedResourceRegistry {
  const kept = registry.requestLedger.filter((entry) => {
    return !(entry.sessionId === options.entry.sessionId && entry.requestId === options.entry.requestId)
  })
  const maxEntries = Math.max(0, Math.floor(options.maxEntries))
  const requestLedger = [...kept, options.entry]
    .filter((entry) => {
      return options.now - entry.createdAt <= options.maxAgeMs
    })
    .slice(-maxEntries)
  return cloneWithRevision(registry, { requestLedger })
}

export type FailedCreateCleanup = 'remove-chrome-tab' | 'leave-user-tab'

/**
 * Decides whether a failed `tabs.create` may still remove the Chrome tab it
 * created. If the user released it, moved it out of the created group, or the
 * record belongs to another browser epoch, the tab is no longer ours and must
 * be left open untouched.
 */
export function classifyFailedCreateCleanup(options: {
  recordState: BrowserResourceState | 'missing'
  recordBrowserEpoch: string | undefined
  browserEpoch: string
  approvedChromeGroupId: number
  observedChromeGroupId: number | null
}): FailedCreateCleanup {
  if (options.recordState === 'released') return 'leave-user-tab'
  if (options.recordState === 'missing') {
    if (options.observedChromeGroupId === null) return 'remove-chrome-tab'
    return options.observedChromeGroupId === options.approvedChromeGroupId ? 'remove-chrome-tab' : 'leave-user-tab'
  }
  if (options.recordBrowserEpoch !== options.browserEpoch) return 'leave-user-tab'
  if (options.observedChromeGroupId === null) return 'remove-chrome-tab'
  if (options.observedChromeGroupId !== options.approvedChromeGroupId) return 'leave-user-tab'
  return 'remove-chrome-tab'
}

/**
 * Full authoritative snapshot for the relay. Released tombstones are included,
 * otherwise the relay would wholesale-replace its cache and forget released
 * resources: tabs.list would lose them and later actions would return
 * resource-not-found instead of resource-released. A released group and its
 * tabs must both be present (the relay refuses tabs that reference unknown
 * groups). Publishing a tombstone only records state - authorization still
 * comes from the active-only lookups, and releaseTab keeps targetId/cdpSessionId
 * stripped.
 */
export function buildInventory(registry: ManagedResourceRegistry): BrowserInventory {
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    profileId: registry.profileId,
    browserEpoch: registry.browserEpoch,
    revision: registry.revision,
    groups: registry.groups,
    tabs: registry.tabs,
  }
}

export interface ObservedChromeTab {
  chromeTabId: number
  /** -1 when the tab is not in any Chrome tab group. */
  chromeGroupId: number
  windowId: number
  url: string
  title: string
}

export interface ReconcileOptions {
  browserEpoch: string
  observedTabs: ObservedChromeTab[]
  observedChromeGroupIds: number[]
  /**
   * Registry revision captured before the Chrome snapshot was taken. Records
   * written after that revision (a create or release that landed while we were
   * observing) are newer than the snapshot and must not be overwritten by it.
   */
  ignoreRecordsNewerThan?: number
}

export interface ReconcileResult {
  registry: ManagedResourceRegistry
  /** Chrome tab ids of managed tabs that should be re-attached to the debugger. */
  reattachTabIds: number[]
  changed: boolean
}

/**
 * Restores persisted ownership against the live Chrome state.
 *
 * Same browserEpoch: records are verifiable - a tab is kept only when Chrome
 * still has the same chromeTabId inside the recorded Chrome group. Anything the
 * user moved out / closed while we were offline becomes a tombstone.
 *
 * New browserEpoch (Chrome restarted, or storage.session was cleared): old
 * chromeTabId/windowId/group ids may now belong to unrelated tabs, so nothing is
 * auto-adopted. Active records switch to needs-rebind and keep their logical
 * identity; stale tombstones are dropped.
 */
export function reconcileRegistry(registry: ManagedResourceRegistry, options: ReconcileOptions): ReconcileResult {
  if (registry.browserEpoch !== options.browserEpoch) {
    return reconcileAfterBrowserRestart(registry, options.browserEpoch)
  }

  const observedByChromeTabId = new Map(options.observedTabs.map((tab) => [tab.chromeTabId, tab]))
  const observedGroupIds = new Set(options.observedChromeGroupIds)
  let changed = false

  const tabs = registry.tabs.map((tab): BrowserTab => {
    // Released records are tombstones and must survive reconciliation, otherwise
    // a user-released tab could be re-adopted later in the same browser run.
    if (tab.state === 'released') return tab
    // needs-rebind records have no verifiable Chrome identity; they stay put
    // until the owning session closes/releases them explicitly.
    if (tab.state === 'needs-rebind') return tab
    // Newer than the Chrome snapshot: a create/release happened while observing,
    // so the stale snapshot must not release this live record.
    if (options.ignoreRecordsNewerThan !== undefined && tab.revision > options.ignoreRecordsNewerThan) {
      return tab
    }

    const group = findGroup(registry, tab.groupId)
    if (!group || group.state === 'released') {
      changed = true
      return { ...tab, state: 'released', revision: registry.revision + 1 }
    }

    const observed = observedByChromeTabId.get(tab.chromeTabId)
    if (!observed) {
      changed = true
      return { ...tab, state: 'released', revision: registry.revision + 1 }
    }

    if (group.chromeGroupId !== undefined && observed.chromeGroupId !== group.chromeGroupId) {
      changed = true
      return { ...tab, state: 'released', revision: registry.revision + 1 }
    }

    const { targetId: _targetId, cdpSessionId: _cdpSessionId, ...rest } = tab
    changed = true
    return {
      ...rest,
      state: 'disconnected',
      url: observed.url,
      title: observed.title,
      revision: registry.revision + 1,
    }
  })

  const groups = registry.groups.map((group): BrowserGroup => {
    if (group.state === 'released' || group.state === 'needs-rebind') return group
    if (group.chromeGroupId === undefined) return group
    if (observedGroupIds.has(group.chromeGroupId)) return group
    // Same fence as tabs: a group updated while we were observing is newer than
    // the snapshot and keeps its live binding.
    if (options.ignoreRecordsNewerThan !== undefined && group.revision > options.ignoreRecordsNewerThan) {
      return group
    }
    // Chrome emptied/closed the visual group while we were offline. Logical
    // groups are session-owned (only groups.close releases them), so we only
    // drop the stale physical binding here.
    changed = true
    const { chromeGroupId: _chromeGroupId, ...rest } = group
    return { ...rest, revision: registry.revision + 1 }
  })

  const nextRegistry: ManagedResourceRegistry = {
    ...registry,
    groups,
    tabs,
    revision: changed ? registry.revision + 1 : registry.revision,
  }

  // Records newer than the snapshot are mid-flight (a create is still running);
  // they are neither released nor re-attached by this reconcile pass.
  const reattachTabIds = tabs
    .filter((tab) => {
      if (tab.state !== 'disconnected') return false
      if (options.ignoreRecordsNewerThan === undefined) return true
      return tab.revision <= options.ignoreRecordsNewerThan
    })
    .map((tab) => tab.chromeTabId)

  return {
    registry: nextRegistry,
    reattachTabIds,
    changed,
  }
}

function reconcileAfterBrowserRestart(registry: ManagedResourceRegistry, browserEpoch: string): ReconcileResult {
  const groups = registry.groups
    .filter((group) => group.state !== 'released')
    .map((group): BrowserGroup => {
      const { chromeGroupId: _chromeGroupId, windowId: _windowId, ...rest } = group
      return { ...rest, state: 'needs-rebind', revision: registry.revision + 1 }
    })

  const tabs = registry.tabs
    .filter((tab) => tab.state !== 'released')
    .map((tab): BrowserTab => {
      const { targetId: _targetId, cdpSessionId: _cdpSessionId, ...rest } = tab
      return { ...rest, state: 'needs-rebind', revision: registry.revision + 1 }
    })

  return {
    registry: {
      ...registry,
      browserEpoch,
      groups,
      tabs,
      revision: registry.revision + 1,
    },
    reattachTabIds: [],
    changed: true,
  }
}
