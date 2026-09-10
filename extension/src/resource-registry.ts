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
 * - released records are tombstones: they are excluded from inventories but kept
 *   so reconnect/reconcile can never pull a user-released tab back into a group.
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
}

export function createEmptyRegistry(options: { profileId: string; browserEpoch: string }): ManagedResourceRegistry {
  return {
    version: MANAGED_REGISTRY_VERSION,
    profileId: options.profileId,
    browserEpoch: options.browserEpoch,
    revision: 0,
    groups: [],
    tabs: [],
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

const EMPTY_REGISTRY: ManagedResourceRegistry = createEmptyRegistry({ profileId: '', browserEpoch: '' })

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

  return { version: MANAGED_REGISTRY_VERSION, profileId, browserEpoch, revision, groups, tabs }
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

/** Tombstone lookup used to block stale async flows from re-adopting a released tab. */
export function isChromeTabTombstoned(registry: ManagedResourceRegistry, chromeTabId: number): boolean {
  return registry.tabs.some((tab) => tab.chromeTabId === chromeTabId && tab.state === 'released')
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
  changes: { groups?: BrowserGroup[]; tabs?: BrowserTab[] },
): ManagedResourceRegistry {
  const next: ManagedResourceRegistry = {
    ...registry,
    revision: registry.revision + 1,
    groups: changes.groups ?? registry.groups,
    tabs: changes.tabs ?? registry.tabs,
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

export function buildInventory(registry: ManagedResourceRegistry): BrowserInventory {
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    profileId: registry.profileId,
    browserEpoch: registry.browserEpoch,
    revision: registry.revision,
    groups: registry.groups.filter((group) => group.state !== 'released'),
    tabs: registry.tabs.filter((tab) => tab.state !== 'released'),
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

  const reattachTabIds = tabs.filter((tab) => tab.state === 'disconnected').map((tab) => tab.chromeTabId)

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
