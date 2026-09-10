import type {
  BrowserErrorCode,
  BrowserGroup,
  BrowserRequest,
  BrowserResponse,
  BrowserResultData,
  BrowserTab,
  BrowserOperation,
} from 'playwriter/src/browser-protocol'
import {
  activeTabsForGroup,
  addGroup,
  addTab,
  buildInventory,
  clearGroupChromeBinding,
  clearTabAttachment,
  createEmptyRegistry,
  findGroup,
  findTab,
  findTabByChromeTabId,
  isChromeTabTombstoned,
  listSessionGroups,
  listSessionTabs,
  reconcileRegistry,
  releaseTab,
  renameGroup,
  setGroupChromeBinding,
  setGroupState,
  setTabAttachment,
  setTabPageInfo,
} from './resource-registry'
import type { ManagedResourceRegistry, ObservedChromeTab } from './resource-registry'
import {
  createOpaqueId,
  ensureBrowserEpoch,
  loadRegistry,
  saveRegistry,
  restrictSessionStorageToTrustedContexts,
} from './resource-storage'

/**
 * Managed (Pi) ownership runtime.
 *
 * Wraps the pure registry with the Chrome side effects: named groups, atomic
 * tab creation, popup inheritance, user-move release tombstones and inventory
 * broadcasts. Everything here assumes background.ts wires the dependencies;
 * the module itself never guesses ownership from URLs or group titles.
 */

const MANAGED_GROUP_COLORS: chrome.tabGroups.ColorEnum[] = ['blue', 'red', 'yellow', 'pink', 'purple', 'cyan', 'orange']
const GROUP_NAME_MAX_LENGTH = 200
const INTERNAL_MOVE_TTL_MS = 3000
const MAX_REQUEST_CACHE_ENTRIES = 200

export interface ManagedGroupsDeps {
  getProfileId: () => Promise<string>
  attachTab: (
    tabId: number,
  ) => Promise<{ targetInfo: { targetId: string; url?: string; title?: string }; sessionId: string }>
  /** Detaches the debugger, removes the tab from the legacy store and emits detachedFromTarget. */
  detachManagedTab: (tabId: number) => void
  sendMessage: (message: unknown) => void
  logger: {
    debug: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  getPreferredWindowId: () => Promise<number | undefined>
  isRestrictedUrl: (url: string | undefined) => boolean
}

class ManagedGroupsError extends Error {
  readonly code: BrowserErrorCode
  readonly outcome: 'not-started' | 'unknown'

  constructor(options: { code: BrowserErrorCode; message: string; outcome?: 'not-started' | 'unknown' }) {
    super(options.message)
    this.name = 'ManagedGroupsError'
    this.code = options.code
    this.outcome = options.outcome ?? 'not-started'
  }
}

function ok(requestId: string, data: BrowserResultData): BrowserResponse {
  return { requestId, ok: true, data }
}

function fail(
  requestId: string,
  options: { code: BrowserErrorCode; message: string; outcome?: 'not-started' | 'unknown' },
): BrowserResponse {
  return {
    requestId,
    ok: false,
    error: { code: options.code, message: options.message, outcome: options.outcome ?? 'not-started' },
  }
}

function isBrowserOperation(value: unknown): value is BrowserOperation {
  if (typeof value !== 'object' || value === null) return false
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string'
}

function validateGroupName(raw: string): string {
  const name = typeof raw === 'string' ? raw.trim() : ''
  if (name.length === 0) {
    throw new ManagedGroupsError({ code: 'invalid-request', message: 'group name must not be empty' })
  }
  if (name.length > GROUP_NAME_MAX_LENGTH) {
    throw new ManagedGroupsError({
      code: 'invalid-request',
      message: `group name must be at most ${GROUP_NAME_MAX_LENGTH} characters`,
    })
  }
  return name
}

/** Only allow navigating to regular web pages; never javascript:/data:/file:/chrome:. */
function validateNavigationUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ManagedGroupsError({ code: 'invalid-request', message: 'url must not be empty' })
  }
  if (raw === 'about:blank') return raw
  const parsed = (() => {
    try {
      return new URL(raw)
    } catch {
      throw new ManagedGroupsError({ code: 'invalid-request', message: `invalid url: ${raw}` })
    }
  })()
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ManagedGroupsError({
      code: 'invalid-request',
      message: `unsupported url scheme for managed navigation: ${parsed.protocol}`,
    })
  }
  return parsed.toString()
}

function chromeGroupColor(index: number): chrome.tabGroups.ColorEnum {
  return MANAGED_GROUP_COLORS[index % MANAGED_GROUP_COLORS.length]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export class ManagedGroups {
  private readonly deps: ManagedGroupsDeps
  private registry: ManagedResourceRegistry | null = null
  private browserEpoch = ''
  private generation = 0
  private readyPromise: Promise<void> | null = null
  private persistQueue: Promise<void> = Promise.resolve()
  private publishQueue: Promise<void> = Promise.resolve()
  private connectQueue: Promise<void> = Promise.resolve()
  private readonly internalMoves = new Map<number, number>()
  private readonly adoptingChromeTabIds = new Set<number>()
  private readonly requestTabIds = new Map<string, string>()
  private readonly inFlightRequests = new Map<string, Promise<BrowserResponse>>()

  constructor(deps: ManagedGroupsDeps) {
    this.deps = deps
  }

  /** Initialization barrier: every entry point awaits this before touching state. */
  initialize(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.loadState().catch((error: unknown) => {
        this.readyPromise = null
        throw error
      })
    }
    return this.readyPromise
  }

  private async loadState(): Promise<void> {
    await restrictSessionStorageToTrustedContexts()
    // Storage failures must not break the legacy extension: fall back to an
    // in-memory epoch/profile and keep running in needs-rebind style isolation.
    const epoch = await ensureBrowserEpoch().catch((error: unknown) => {
      this.deps.logger.error('Managed registry: session storage unavailable, using volatile epoch:', error)
      return { browserEpoch: createOpaqueId('epoch'), restarted: false }
    })
    const profileId = await this.deps.getProfileId().catch((error: unknown) => {
      this.deps.logger.error('Managed registry: could not read the install id:', error)
      return 'profile-unavailable'
    })
    this.browserEpoch = epoch.browserEpoch

    const stored = await loadRegistry().catch((error: unknown) => {
      this.deps.logger.error('Managed registry: could not read persisted ownership:', error)
      return null
    })
    if (!stored) {
      this.registry = createEmptyRegistry({ profileId, browserEpoch: this.browserEpoch })
      await this.persist()
      return
    }

    this.registry = stored
    if (epoch.restarted) {
      this.deps.logger.warn(
        `Managed registry: Chrome restarted (new browserEpoch), ${stored.groups.length} group(s) / ${stored.tabs.length} tab(s) will be reconciled against a fresh browser`,
      )
    }
  }

  private getRegistry(): ManagedResourceRegistry {
    if (!this.registry) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'managed registry is not initialized' })
    }
    return this.registry
  }

  private mutate(updater: (registry: ManagedResourceRegistry) => ManagedResourceRegistry): ManagedResourceRegistry {
    const next = updater(this.getRegistry())
    this.registry = next
    return next
  }

  private async persist(): Promise<void> {
    const snapshot = this.getRegistry()
    this.persistQueue = this.persistQueue
      .then(() => {
        return saveRegistry(snapshot)
      })
      .catch((error: unknown) => {
        this.deps.logger.error('Failed to persist managed registry:', error)
      })
    await this.persistQueue
  }

  async publishInventory(): Promise<void> {
    const snapshot = this.getRegistry()
    this.publishQueue = this.publishQueue
      .then(() => {
        this.deps.sendMessage({
          method: 'browserInventory',
          params: buildInventory(snapshot),
        })
      })
      .catch((error: unknown) => {
        this.deps.logger.error('Failed to publish managed inventory:', error)
      })
    await this.publishQueue
  }

  getManagedChromeGroupIds(): number[] {
    if (!this.registry) return []
    return this.registry.groups
      .filter((group) => group.state !== 'released' && group.chromeGroupId !== undefined)
      .map((group) => group.chromeGroupId as number)
  }

  getManagedChromeTabIds(): number[] {
    if (!this.registry) return []
    return this.registry.tabs.filter((tab) => tab.state !== 'released').map((tab) => tab.chromeTabId)
  }

  isManagedChromeTabId(chromeTabId: number): boolean {
    if (!this.registry) return false
    const tab = findTabByChromeTabId(this.registry, chromeTabId)
    return tab !== undefined && tab.state !== 'released'
  }

  findManagedTabByChromeTabId(chromeTabId: number): BrowserTab | undefined {
    if (!this.registry) return undefined
    const tab = findTabByChromeTabId(this.registry, chromeTabId)
    if (!tab || tab.state === 'released') return undefined
    return tab
  }

  /** Called after every WS (re)connect: restore bindings before any CDP routing. */
  handleWsConnected(): Promise<void> {
    this.connectQueue = this.connectQueue
      .then(() => {
        return this.restoreOnConnect()
      })
      .catch((error: unknown) => {
        this.deps.logger.error('Managed restore failed:', error)
      })
    return this.connectQueue
  }

  private async restoreOnConnect(): Promise<void> {
    await this.initialize()
    this.generation += 1
    const generation = this.generation

    const observed = await this.observeChromeState()
    const result = reconcileRegistry(this.getRegistry(), {
      browserEpoch: this.browserEpoch,
      observedTabs: observed.observedTabs,
      observedChromeGroupIds: observed.observedChromeGroupIds,
    })
    this.registry = result.registry
    await this.persist()
    await this.reattachTabs(result.reattachTabIds, generation)
    await this.publishInventory()
  }

  private async observeChromeState(): Promise<{
    observedTabs: ObservedChromeTab[]
    observedChromeGroupIds: number[]
  }> {
    const chromeTabs = await chrome.tabs.query({})
    const observedTabs: ObservedChromeTab[] = chromeTabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => {
        return {
          chromeTabId: tab.id as number,
          chromeGroupId: tab.groupId ?? -1,
          windowId: tab.windowId,
          url: tab.url ?? '',
          title: tab.title ?? '',
        }
      })
    const chromeGroups = await chrome.tabGroups.query({})
    return { observedTabs, observedChromeGroupIds: chromeGroups.map((group) => group.id) }
  }

  private async reattachTabs(chromeTabIds: number[], generation: number): Promise<void> {
    for (const chromeTabId of chromeTabIds) {
      if (generation !== this.generation) return
      const tab = findTabByChromeTabId(this.getRegistry(), chromeTabId)
      if (!tab || tab.state === 'released' || tab.state !== 'disconnected') continue
      if (isChromeTabTombstoned(this.getRegistry(), chromeTabId)) continue

      const exists = await this.chromeTabExists(chromeTabId)
      if (!exists) {
        await this.releaseManagedTab({ tabId: tab.tabId, reason: 'tab-disappeared-before-reattach' })
        continue
      }
      try {
        const attached = await this.deps.attachTab(chromeTabId)
        if (generation !== this.generation) return
        const current = findTab(this.getRegistry(), tab.tabId)
        if (!current || current.state === 'released') continue
        this.mutate((registry) => {
          return setTabAttachment(registry, {
            tabId: tab.tabId,
            targetId: attached.targetInfo.targetId,
            cdpSessionId: attached.sessionId,
          })
        })
        this.mutate((registry) => {
          return setTabPageInfo(registry, {
            tabId: tab.tabId,
            url: attached.targetInfo.url ?? current.url,
            title: attached.targetInfo.title ?? current.title,
          })
        })
        this.deps.logger.debug(`Managed tab re-attached after reconnect: chromeTabId=${chromeTabId}`)
      } catch (error: unknown) {
        this.deps.logger.warn(`Failed to re-attach managed tab ${chromeTabId}, keeping ownership:`, error)
        await sleep(50)
      }
    }
    await this.persist()
  }

  // ---------------------------------------------------------------------------
  // WS protocol entry point
  // ---------------------------------------------------------------------------

  async handleBrowserRequest(request: BrowserRequest): Promise<BrowserResponse> {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : ''
    try {
      await this.initialize()
      // Wait for an in-flight restore so requests never observe a half-reconciled registry.
      await this.connectQueue
      if (!requestId) {
        throw new ManagedGroupsError({ code: 'invalid-request', message: 'requestId must not be empty' })
      }
      if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
        throw new ManagedGroupsError({ code: 'invalid-request', message: 'sessionId must not be empty' })
      }
      if (!isBrowserOperation(request.operation)) {
        throw new ManagedGroupsError({ code: 'invalid-request', message: 'operation.kind is required' })
      }

      const existing = this.inFlightRequests.get(requestId)
      if (existing) return existing

      const promise = this.dispatchRequest(request)
      this.inFlightRequests.set(requestId, promise)
      try {
        return await promise
      } finally {
        this.inFlightRequests.delete(requestId)
      }
    } catch (error: unknown) {
      return this.errorResponse(requestId, error)
    }
  }

  private async dispatchRequest(request: BrowserRequest): Promise<BrowserResponse> {
    const operation = request.operation
    switch (operation.kind) {
      case 'groups.list':
        return this.handleGroupsList(request)
      case 'groups.create':
        return this.handleGroupsCreate(request, operation)
      case 'groups.rename':
        return this.handleGroupsRename(request, operation)
      case 'groups.close':
        return this.handleGroupsClose(request, operation)
      case 'tabs.list':
        return this.handleTabsList(request, operation)
      case 'tabs.create':
        return this.handleTabsCreate(request, operation)
      case 'tabs.close':
        return this.handleTabsClose(request, operation)
      case 'tabs.release':
        return this.handleTabsRelease(request, operation)
      case 'tab.resolve':
        return this.handleTabResolve(request, operation)
      default:
        return fail(request.requestId, {
          code: 'unsupported-capability',
          message: `operation ${operation.kind} is not handled by the extension`,
        })
    }
  }

  private errorResponse(requestId: string, error: unknown): BrowserResponse {
    if (error instanceof ManagedGroupsError) {
      return fail(requestId, { code: error.code, message: error.message, outcome: error.outcome })
    }
    const message = error instanceof Error ? error.message : String(error)
    this.deps.logger.error('Managed request failed:', error)
    return fail(requestId, { code: 'internal-error', message, outcome: 'unknown' })
  }

  private requireGroup(options: { groupId: string; sessionId: string }): BrowserGroup {
    const group = findGroup(this.getRegistry(), options.groupId)
    if (!group) {
      throw new ManagedGroupsError({ code: 'resource-not-found', message: `group not found: ${options.groupId}` })
    }
    if (group.sessionId !== options.sessionId) {
      throw new ManagedGroupsError({
        code: 'ownership-mismatch',
        message: `group ${options.groupId} belongs to another session`,
      })
    }
    return group
  }

  private requireTab(options: { tabId: string; sessionId: string }): BrowserTab {
    const tab = findTab(this.getRegistry(), options.tabId)
    if (!tab || tab.state === 'released') {
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab not found or released: ${options.tabId}`,
      })
    }
    if (tab.sessionId !== options.sessionId) {
      throw new ManagedGroupsError({
        code: 'ownership-mismatch',
        message: `tab ${options.tabId} belongs to another session`,
      })
    }
    return tab
  }

  // ---------------------------------------------------------------------------
  // groups.*
  // ---------------------------------------------------------------------------

  private async handleGroupsList(request: BrowserRequest): Promise<BrowserResponse> {
    const groups = listSessionGroups(this.getRegistry(), request.sessionId)
    return ok(request.requestId, { groups })
  }

  private async handleGroupsCreate(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'groups.create' }>,
  ): Promise<BrowserResponse> {
    const name = validateGroupName(operation.name)
    const groupId = createOpaqueId('pgrp')
    this.mutate((registry) => {
      return addGroup(registry, {
        groupId,
        sessionId: request.sessionId,
        name,
        browserEpoch: this.browserEpoch,
      })
    })
    await this.persist()
    await this.publishInventory()
    const group = findGroup(this.getRegistry(), groupId)
    if (!group) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'group disappeared right after creation' })
    }
    return ok(request.requestId, { group })
  }

  private async handleGroupsRename(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'groups.rename' }>,
  ): Promise<BrowserResponse> {
    const name = validateGroupName(operation.name)
    const group = this.requireGroup({ groupId: operation.groupId, sessionId: request.sessionId })
    if (group.state === 'released') {
      throw new ManagedGroupsError({ code: 'resource-released', message: `group ${group.groupId} is released` })
    }
    if (group.state === 'needs-rebind') {
      throw new ManagedGroupsError({
        code: 'needs-rebind',
        message: `group ${group.groupId} needs to be rebound after a browser restart`,
      })
    }

    if (group.chromeGroupId !== undefined) {
      const bound = group.chromeGroupId
      const exists = await this.chromeGroupExists(bound)
      if (exists) {
        await chrome.tabGroups.update(bound, { title: name })
      } else {
        this.mutate((registry) => {
          return clearGroupChromeBinding(registry, { groupId: group.groupId })
        })
      }
    }

    this.mutate((registry) => {
      return renameGroup(registry, { groupId: group.groupId, name })
    })
    await this.persist()
    await this.publishInventory()
    const updated = findGroup(this.getRegistry(), group.groupId)
    if (!updated) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'group disappeared during rename' })
    }
    return ok(request.requestId, { group: updated })
  }

  private async handleGroupsClose(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'groups.close' }>,
  ): Promise<BrowserResponse> {
    const group = this.requireGroup({ groupId: operation.groupId, sessionId: request.sessionId })
    if (group.state === 'released') {
      return ok(request.requestId, { group })
    }

    for (const tab of activeTabsForGroup(this.getRegistry(), group.groupId)) {
      await this.closeManagedTab(tab.tabId)
    }

    this.mutate((registry) => {
      return setGroupState(registry, { groupId: group.groupId, state: 'released' })
    })
    await this.persist()
    await this.publishInventory()
    const closed = findGroup(this.getRegistry(), group.groupId)
    if (!closed) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'group disappeared during close' })
    }
    return ok(request.requestId, { group: closed })
  }

  // ---------------------------------------------------------------------------
  // tabs.*
  // ---------------------------------------------------------------------------

  private async handleTabsList(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.list' }>,
  ): Promise<BrowserResponse> {
    if (operation.groupId !== undefined) {
      const group = this.requireGroup({ groupId: operation.groupId, sessionId: request.sessionId })
      const tabs = listSessionTabs(this.getRegistry(), request.sessionId, group.groupId)
      return ok(request.requestId, { tabs })
    }
    const tabs = listSessionTabs(this.getRegistry(), request.sessionId)
    return ok(request.requestId, { tabs })
  }

  private async handleTabsCreate(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.create' }>,
  ): Promise<BrowserResponse> {
    const cachedTabId = this.requestTabIds.get(request.requestId)
    if (cachedTabId) {
      const cached = findTab(this.getRegistry(), cachedTabId)
      if (cached && cached.state !== 'released') {
        return ok(request.requestId, { tab: cached })
      }
      this.requestTabIds.delete(request.requestId)
    }

    const group = this.requireGroup({ groupId: operation.groupId, sessionId: request.sessionId })
    if (group.state === 'released') {
      throw new ManagedGroupsError({ code: 'resource-released', message: `group ${group.groupId} is released` })
    }
    if (group.state === 'needs-rebind') {
      throw new ManagedGroupsError({
        code: 'needs-rebind',
        message: `group ${group.groupId} needs to be rebound after a browser restart`,
      })
    }
    const url = validateNavigationUrl(operation.url)

    const windowId = await this.resolveGroupWindow(group)
    const created = await chrome.tabs.create({
      url: 'about:blank',
      active: false,
      ...(windowId !== undefined ? { windowId } : {}),
    })
    const chromeTabId = created.id
    if (chromeTabId === undefined) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'Chrome did not return a tab id' })
    }
    this.markInternalMove(chromeTabId)

    let tabId: string | undefined
    try {
      const chromeGroupId = await this.ensureTabInManagedGroup({ chromeTabId, group, windowId: created.windowId })

      // Record persisted before attach: even if attach/navigate fail the tab is
      // tracked (and tombstoned on cleanup) instead of leaking as a fake ready tab.
      tabId = createOpaqueId('ptab')
      const newTabId = tabId
      this.mutate((registry) => {
        return addTab(registry, {
          tabId: newTabId,
          groupId: group.groupId,
          sessionId: request.sessionId,
          chromeTabId,
          url: 'about:blank',
          title: '',
          browserEpoch: this.browserEpoch,
        })
      })
      this.mutate((registry) => {
        return setGroupChromeBinding(registry, {
          groupId: group.groupId,
          chromeGroupId,
          windowId: created.windowId,
        })
      })
      await this.persist()

      const attached = await this.deps.attachTab(chromeTabId)
      await chrome.tabs.update(chromeTabId, { url })

      // Verify the tab is still owned by this group before declaring it ready.
      const verified = await chrome.tabs.get(chromeTabId).catch(() => {
        return null
      })
      if (!verified || verified.groupId !== chromeGroupId) {
        throw new ManagedGroupsError({
          code: 'internal-error',
          message: 'new tab left its managed group before the request completed',
          outcome: 'unknown',
        })
      }

      this.mutate((registry) => {
        return setTabAttachment(registry, {
          tabId: newTabId,
          targetId: attached.targetInfo.targetId,
          cdpSessionId: attached.sessionId,
        })
      })
      this.mutate((registry) => {
        return setTabPageInfo(registry, {
          tabId: newTabId,
          url: verified.url && verified.url !== 'about:blank' ? verified.url : url,
          title: verified.title ?? '',
        })
      })
      await this.persist()
      await this.publishInventory()

      const tab = findTab(this.getRegistry(), newTabId)
      if (!tab) {
        throw new ManagedGroupsError({ code: 'internal-error', message: 'created tab vanished from the registry' })
      }
      this.rememberRequest(request.requestId, newTabId)
      return ok(request.requestId, { tab })
    } catch (error: unknown) {
      await this.cleanupFailedCreate({ chromeTabId, tabId })
      throw error
    }
  }

  private async cleanupFailedCreate(options: { chromeTabId: number; tabId?: string }): Promise<void> {
    const failedTabId = options.tabId
    if (failedTabId) {
      this.mutate((registry) => {
        return releaseTab(registry, failedTabId)
      })
    }
    this.deps.detachManagedTab(options.chromeTabId)
    const removed = await chrome.tabs.remove(options.chromeTabId).then(
      () => {
        return true
      },
      () => {
        return false
      },
    )
    this.deps.logger.warn(`Cleaned up failed tabs.create (chromeTabId=${options.chromeTabId}, removed=${removed})`)
    if (failedTabId) {
      await this.persist()
      await this.publishInventory()
    }
  }

  private async handleTabsClose(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.close' }>,
  ): Promise<BrowserResponse> {
    const tab = this.requireTab({ tabId: operation.tabId, sessionId: request.sessionId })
    const closed = await this.closeManagedTab(tab.tabId)
    return ok(request.requestId, { tab: closed })
  }

  private async handleTabsRelease(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.release' }>,
  ): Promise<BrowserResponse> {
    const tab = this.requireTab({ tabId: operation.tabId, sessionId: request.sessionId })
    await this.releaseManagedTab({ tabId: tab.tabId, reason: 'requested-by-session', ungroup: true })
    const released = findTab(this.getRegistry(), tab.tabId)
    if (!released) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'tab disappeared during release' })
    }
    return ok(request.requestId, { tab: released })
  }

  private async handleTabResolve(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tab.resolve' }>,
  ): Promise<BrowserResponse> {
    const tab = this.requireTab({ tabId: operation.tabId, sessionId: request.sessionId })
    if (tab.state === 'needs-rebind') {
      return ok(request.requestId, { tab })
    }

    const chromeTab = await chrome.tabs.get(tab.chromeTabId).catch(() => {
      return null
    })
    if (!chromeTab) {
      await this.releaseManagedTab({ tabId: tab.tabId, reason: 'resolved-tab-missing' })
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab ${tab.tabId} no longer exists in Chrome`,
      })
    }
    this.mutate((registry) => {
      return setTabPageInfo(registry, {
        tabId: tab.tabId,
        url: chromeTab.url ?? '',
        title: chromeTab.title ?? '',
      })
    })
    const resolved = findTab(this.getRegistry(), tab.tabId)
    if (!resolved) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'tab disappeared during resolve' })
    }
    return ok(request.requestId, { tab: resolved })
  }

  // ---------------------------------------------------------------------------
  // Chrome tab operations
  // ---------------------------------------------------------------------------

  private async resolveGroupWindow(group: BrowserGroup): Promise<number | undefined> {
    if (group.windowId !== undefined) {
      const exists = await chrome.windows.get(group.windowId).then(
        () => {
          return true
        },
        () => {
          return false
        },
      )
      if (exists) return group.windowId
    }

    const groupTabs = activeTabsForGroup(this.getRegistry(), group.groupId)
    for (const tab of groupTabs) {
      const chromeTab = await chrome.tabs.get(tab.chromeTabId).catch(() => {
        return null
      })
      if (chromeTab) return chromeTab.windowId
    }

    return this.deps.getPreferredWindowId()
  }

  private async ensureTabInManagedGroup(options: {
    chromeTabId: number
    group: BrowserGroup
    windowId?: number
  }): Promise<number> {
    const boundGroupId = options.group.chromeGroupId
    if (boundGroupId !== undefined) {
      const stillExists = await this.chromeGroupExists(boundGroupId)
      if (stillExists) {
        this.markInternalMove(options.chromeTabId)
        await chrome.tabs.group({ tabIds: [options.chromeTabId], groupId: boundGroupId })
        return boundGroupId
      }
    }

    this.markInternalMove(options.chromeTabId)
    const groupCount = this.getRegistry().groups.filter((group) => group.state !== 'released').length
    const chromeGroupId = await chrome.tabs.group({
      tabIds: [options.chromeTabId],
      createProperties: {
        ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
      },
    })
    await chrome.tabGroups.update(chromeGroupId, {
      title: options.group.name,
      color: chromeGroupColor(groupCount),
    })
    return chromeGroupId
  }

  private async closeManagedTab(tabId: string): Promise<BrowserTab> {
    const tab = findTab(this.getRegistry(), tabId)
    if (!tab || tab.state === 'released') {
      throw new ManagedGroupsError({ code: 'resource-released', message: `tab ${tabId} is already released` })
    }

    // Tombstone before removing in Chrome so the onRemoved listener cannot
    // mistake this explicit close for a user-side release.
    this.mutate((registry) => {
      return releaseTab(registry, tabId)
    })

    if (tab.state !== 'needs-rebind') {
      this.deps.detachManagedTab(tab.chromeTabId)
      await chrome.tabs.remove(tab.chromeTabId).catch((error: unknown) => {
        this.deps.logger.debug(`Tab ${tab.chromeTabId} was already gone during close:`, error)
      })
    }

    await this.clearGroupBindingIfEmpty(tab.groupId)
    await this.persist()
    await this.publishInventory()
    const released = findTab(this.getRegistry(), tabId)
    if (!released) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'tab disappeared during close' })
    }
    return released
  }

  private async releaseManagedTab(options: { tabId: string; reason: string; ungroup?: boolean }): Promise<void> {
    const tab = findTab(this.getRegistry(), options.tabId)
    if (!tab || tab.state === 'released') return
    const group = findGroup(this.getRegistry(), tab.groupId)

    this.deps.detachManagedTab(tab.chromeTabId)

    if (options.ungroup !== false && group?.chromeGroupId !== undefined && tab.state !== 'needs-rebind') {
      const stillInGroup = await this.isTabInChromeGroup({
        chromeTabId: tab.chromeTabId,
        chromeGroupId: group.chromeGroupId,
      })
      if (stillInGroup) {
        this.markInternalMove(tab.chromeTabId)
        await chrome.tabs.ungroup(tab.chromeTabId).catch((error: unknown) => {
          this.deps.logger.debug(`Failed to ungroup released tab ${tab.chromeTabId}:`, error)
        })
      }
    }

    this.mutate((registry) => {
      return releaseTab(registry, options.tabId)
    })
    this.deps.logger.debug(`Released managed tab ${tab.tabId} (${options.reason})`)
    await this.clearGroupBindingIfEmpty(tab.groupId)
    await this.persist()
    await this.publishInventory()
  }

  private async clearGroupBindingIfEmpty(groupId: string): Promise<void> {
    const group = findGroup(this.getRegistry(), groupId)
    if (!group) return
    if (activeTabsForGroup(this.getRegistry(), groupId).length > 0) return
    if (group.chromeGroupId === undefined) return
    const stillHasChromeGroup = await this.chromeGroupExists(group.chromeGroupId)
    if (stillHasChromeGroup) return
    this.mutate((registry) => {
      return clearGroupChromeBinding(registry, { groupId })
    })
  }

  private async isTabInChromeGroup(options: { chromeTabId: number; chromeGroupId: number }): Promise<boolean> {
    const chromeTab = await chrome.tabs.get(options.chromeTabId).catch(() => {
      return null
    })
    return chromeTab?.groupId === options.chromeGroupId
  }

  private async chromeGroupExists(chromeGroupId: number): Promise<boolean> {
    const groups = await chrome.tabGroups.query({})
    return groups.some((group) => group.id === chromeGroupId)
  }

  private async chromeTabExists(chromeTabId: number): Promise<boolean> {
    const tab = await chrome.tabs.get(chromeTabId).catch(() => {
      return null
    })
    return tab !== null
  }

  private markInternalMove(chromeTabId: number): void {
    this.internalMoves.set(chromeTabId, Date.now() + INTERNAL_MOVE_TTL_MS)
  }

  private consumeInternalMove(chromeTabId: number): boolean {
    const expiresAt = this.internalMoves.get(chromeTabId)
    if (expiresAt === undefined) return false
    this.internalMoves.delete(chromeTabId)
    return expiresAt > Date.now()
  }

  private rememberRequest(requestId: string, tabId: string): void {
    this.requestTabIds.set(requestId, tabId)
    if (this.requestTabIds.size > MAX_REQUEST_CACHE_ENTRIES) {
      const oldest = this.requestTabIds.keys().next().value
      if (oldest !== undefined) this.requestTabIds.delete(oldest)
    }
  }

  // ---------------------------------------------------------------------------
  // Chrome event handlers
  // ---------------------------------------------------------------------------

  /** A Chrome tab we own was closed by the user/Chrome while the worker was alive. */
  async handleChromeTabRemoved(chromeTabId: number): Promise<void> {
    try {
      await this.initialize()
      const tab = this.findManagedTabByChromeTabId(chromeTabId)
      if (!tab) return
      this.mutate((registry) => {
        return releaseTab(registry, tab.tabId)
      })
      this.deps.logger.debug(`Managed tab removed in Chrome: ${tab.tabId}`)
      await this.clearGroupBindingIfEmpty(tab.groupId)
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      this.deps.logger.error('Failed to handle managed tab removal:', error)
    }
  }

  /**
   * Chrome emptied/removed a managed tab group (last tab moved out or closed).
   * Logical groups are session-owned: only groups.close releases them, so here
   * we just drop the now-meaningless physical binding.
   */
  async handleChromeGroupRemoved(chromeGroupId: number): Promise<void> {
    try {
      await this.initialize()
      const group = this.getRegistry().groups.find((candidate) => candidate.chromeGroupId === chromeGroupId)
      if (!group || group.state === 'released') return
      if (activeTabsForGroup(this.getRegistry(), group.groupId).length > 0) return
      this.mutate((registry) => {
        return clearGroupChromeBinding(registry, { groupId: group.groupId })
      })
      this.deps.logger.debug(`Managed Chrome group ${chromeGroupId} disappeared, binding cleared`)
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      this.deps.logger.error('Failed to handle managed group removal:', error)
    }
  }

  /**
   * chrome.tabs.onUpdated with a groupId change. Our own grouping operations are
   * marked internal; any other move out of the managed group means the user took
   * the tab back and it becomes a release tombstone.
   */
  async handleChromeTabUpdatedGroup(options: {
    chromeTabId: number
    chromeGroupId: number
    url: string
    title: string
  }): Promise<void> {
    try {
      await this.initialize()
      if (this.consumeInternalMove(options.chromeTabId)) return
      const tab = this.findManagedTabByChromeTabId(options.chromeTabId)
      if (!tab) return
      const group = findGroup(this.getRegistry(), tab.groupId)
      if (!group) return

      if (group.chromeGroupId !== undefined && options.chromeGroupId === group.chromeGroupId) {
        // Moved (back) into the managed group - keep ownership.
        return
      }

      await this.releaseManagedTab({ tabId: tab.tabId, reason: 'user-moved-tab-out', ungroup: false })
    } catch (error: unknown) {
      this.deps.logger.error('Failed to handle managed tab group change:', error)
    }
  }

  /** Best-effort url/title cache refresh; never persists or publishes on its own. */
  noteChromeTabPageInfo(chromeTabId: number, url: string, title: string): void {
    if (!this.registry) return
    const tab = this.findManagedTabByChromeTabId(chromeTabId)
    if (!tab) return
    this.mutate((registry) => {
      return setTabPageInfo(registry, { tabId: tab.tabId, url, title })
    })
  }

  /**
   * Debugger detach. Only CANCELED_BY_USER (the Chrome infobar "Cancel") is a
   * user release; everything else keeps ownership and re-attaches later.
   */
  async handleDebuggerDetached(
    chromeTabId: number,
    reason: string,
    options: { releaseAllReady?: boolean } = {},
  ): Promise<void> {
    try {
      await this.initialize()
      const tab = this.findManagedTabByChromeTabId(chromeTabId)
      if (!tab) return
      if (reason === 'canceled_by_user') {
        await this.releaseManagedTab({ tabId: tab.tabId, reason: 'debugger-canceled-by-user', ungroup: true })
        if (options.releaseAllReady) {
          // Chrome cancels every debugger session of this extension at once, so the
          // remaining ready tabs are no longer attached. Ownership is kept (only a
          // reconnect restores the attachment); they are not tombstones.
          this.disconnectOtherReadyTabs(tab.tabId)
          await this.persist()
          await this.publishInventory()
        }
        return
      }
      this.mutate((registry) => {
        return clearTabAttachment(registry, tab.tabId)
      })
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      this.deps.logger.error('Failed to handle debugger detach for managed tab:', error)
    }
  }

  private disconnectOtherReadyTabs(exceptTabId: string): void {
    const readyTabs = this.getRegistry().tabs.filter((tab) => {
      return tab.state === 'ready' && tab.tabId !== exceptTabId
    })
    if (readyTabs.length === 0) return
    let registry = this.getRegistry()
    for (const tab of readyTabs) {
      registry = clearTabAttachment(registry, tab.tabId)
    }
    this.registry = registry
  }

  /** Re-attaches a managed tab without changing ownership (used by the icon click). */
  async restoreChromeTab(chromeTabId: number): Promise<void> {
    try {
      await this.initialize()
      const tab = this.findManagedTabByChromeTabId(chromeTabId)
      if (!tab || tab.state === 'released' || tab.state === 'needs-rebind') return
      const attached = await this.deps.attachTab(chromeTabId)
      this.mutate((registry) => {
        return setTabAttachment(registry, {
          tabId: tab.tabId,
          targetId: attached.targetInfo.targetId,
          cdpSessionId: attached.sessionId,
        })
      })
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      this.deps.logger.warn(`Failed to restore managed tab ${chromeTabId}:`, error)
    }
  }

  /**
   * A new tab/window was opened from a managed tab (target=_blank, window.open,
   * OAuth popup). It inherits the source tab's group; unrelated user popups are
   * ignored because only a managed source tab triggers adoption.
   */
  async adoptInheritedTab(options: { chromeTabId: number; sourceChromeTabId: number }): Promise<void> {
    try {
      await this.initialize()
      if (this.adoptingChromeTabIds.has(options.chromeTabId)) return
      const sourceTab = this.findManagedTabByChromeTabId(options.sourceChromeTabId)
      if (!sourceTab || sourceTab.state !== 'ready') return
      const group = findGroup(this.getRegistry(), sourceTab.groupId)
      if (!group || group.state !== 'ready') return
      if (findTabByChromeTabId(this.getRegistry(), options.chromeTabId)) return
      if (isChromeTabTombstoned(this.getRegistry(), options.chromeTabId)) return

      this.adoptingChromeTabIds.add(options.chromeTabId)
      try {
        const chromeTab = await this.waitForChromeTab(options.chromeTabId)
        if (!chromeTab) return
        if (this.deps.isRestrictedUrl(chromeTab.url)) return

        const attached = await this.deps.attachTab(options.chromeTabId)
        let registered = false
        try {
          if (isChromeTabTombstoned(this.getRegistry(), options.chromeTabId)) return

          const chromeGroupId = await this.ensureTabInManagedGroup({
            chromeTabId: options.chromeTabId,
            group,
            windowId: chromeTab.windowId,
          })
          const tabId = createOpaqueId('ptab')
          this.mutate((registry) => {
            return addTab(registry, {
              tabId,
              groupId: group.groupId,
              sessionId: sourceTab.sessionId,
              chromeTabId: options.chromeTabId,
              url: chromeTab.url ?? '',
              title: chromeTab.title ?? '',
              browserEpoch: this.browserEpoch,
            })
          })
          this.mutate((registry) => {
            return setTabAttachment(registry, {
              tabId,
              targetId: attached.targetInfo.targetId,
              cdpSessionId: attached.sessionId,
            })
          })
          this.mutate((registry) => {
            return setGroupChromeBindingIfMissing(registry, {
              groupId: group.groupId,
              chromeGroupId,
              windowId: chromeTab.windowId,
            })
          })
          registered = true
          this.deps.logger.debug(
            `Adopted inherited tab ${options.chromeTabId} into managed group ${group.groupId} (source=${options.sourceChromeTabId})`,
          )
          await this.persist()
          await this.publishInventory()
        } finally {
          // Never keep controlling a tab that we could not register as owned.
          if (!registered) {
            this.deps.detachManagedTab(options.chromeTabId)
          }
        }
      } finally {
        this.adoptingChromeTabIds.delete(options.chromeTabId)
      }
    } catch (error: unknown) {
      this.deps.logger.warn(`Failed to adopt inherited tab ${options.chromeTabId}:`, error)
    }
  }

  private async waitForChromeTab(chromeTabId: number): Promise<chrome.tabs.Tab | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const tab = await chrome.tabs.get(chromeTabId).catch(() => {
        return null
      })
      if (tab) return tab
      await sleep(30)
    }
    return null
  }

  /** Explicit user/API release through legacy paths (icon click, disconnect all). */
  async releaseChromeTab(chromeTabId: number, reason: string): Promise<void> {
    await this.initialize()
    const tab = this.findManagedTabByChromeTabId(chromeTabId)
    if (!tab) return
    await this.releaseManagedTab({ tabId: tab.tabId, reason, ungroup: true })
  }

  /** Releases every managed tab (explicit disconnect-everything, not a transport drop). */
  async releaseAllChromeTabs(reason: string): Promise<void> {
    try {
      await this.initialize()
      const chromeTabIds = this.getManagedChromeTabIds()
      for (const chromeTabId of chromeTabIds) {
        await this.releaseChromeTab(chromeTabId, reason)
      }
    } catch (error: unknown) {
      this.deps.logger.error('Failed to release all managed tabs:', error)
    }
  }
}

function setGroupChromeBindingIfMissing(
  registry: ManagedResourceRegistry,
  options: { groupId: string; chromeGroupId: number; windowId: number },
): ManagedResourceRegistry {
  const group = findGroup(registry, options.groupId)
  if (group?.chromeGroupId !== undefined) return registry
  return setGroupChromeBinding(registry, options)
}
