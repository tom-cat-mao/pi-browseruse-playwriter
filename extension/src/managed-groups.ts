import {
  buildTabCandidateId,
  parseTabCandidateId,
} from 'playwriter/src/browser-protocol'
import type {
  BrowserErrorCode,
  BrowserGroup,
  BrowserRequest,
  BrowserResponse,
  BrowserResultData,
  BrowserTab,
  BrowserTabCandidate,
  BrowserOperation,
} from 'playwriter/src/browser-protocol'
import {
  activeTabsForGroup,
  addGroup,
  addTab,
  appendRequestLedgerEntry,
  buildCreateRequestFingerprint,
  buildInventory,
  classifyCreateRequestDedupe,
  classifyFailedCreateCleanup,
  classifyPendingCreateRecovery,
  clearGroupChromeBinding,
  clearTabAttachment,
  createEmptyRegistry,
  findActiveTabByChromeTabId,
  findGroup,
  findRequestLedgerEntry,
  findTab,
  findTabByChromeTabId,
  isChromeTabTombstoned,
  listSessionGroups,
  listSessionTabs,
  reconcileRegistry,
  releaseTab,
  removeRequestLedgerEntry,
  renameGroup,
  setGroupChromeBinding,
  setGroupState,
  setGroupWindowId,
  setTabAttachment,
  setTabPageInfo,
  updateRequestLedgerPhase,
} from './resource-registry'
import type { ManagedResourceRegistry, ObservedChromeTab, RequestLedgerEntry } from './resource-registry'
import {
  createOpaqueId,
  ensureBrowserEpoch,
  loadRegistry,
  saveRegistry,
  restrictStorageToTrustedContexts,
} from './resource-storage'
import { KeyedSerialQueue } from './keyed-queue'
import { InternalMoves } from './internal-moves'
import { PersistQueue } from './persist-queue'
import { RequestTracker } from './request-tracker'

/**
 * Managed (Pi) ownership runtime.
 *
 * Wraps the pure registry with the Chrome side effects: named groups, atomic
 * tab creation, popup inheritance, user-move release tombstones and inventory
 * broadcasts. Everything here assumes background.ts wires the dependencies;
 * the module itself never guesses ownership from URLs or group titles.
 *
 * Failure policy: when the persisted registry cannot be read or written the
 * managed layer becomes unavailable (all managed requests fail with
 * internal-error, no inventory is advertised) instead of pretending success or
 * overwriting records it could not read. Legacy behaviour stays untouched.
 */

const MANAGED_GROUP_COLORS: chrome.tabGroups.ColorEnum[] = ['blue', 'red', 'yellow', 'pink', 'purple', 'cyan', 'orange']
const GROUP_NAME_MAX_LENGTH = 200
const INTERNAL_MOVE_TTL_MS = 3000
const MAX_LEDGER_ENTRIES = 200
const LEDGER_MAX_AGE_MS = 24 * 60 * 60 * 1000
const TAB_ID_NONE = -1

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

/** Logical name for the internal group that holds one tab attached in place. */
function buildExistingGroupName(title: string | undefined): string {
  const trimmed = (title ?? '').trim().slice(0, GROUP_NAME_MAX_LENGTH)
  return trimmed.length > 0 ? trimmed : 'Existing tab'
}

interface CreateDedupeContext {
  key: string
  operation: 'groups.create' | 'tabs.create'
  fingerprint: string
  ledgerEntry: RequestLedgerEntry | undefined
}

interface RequestContext {
  sessionId: string
  requestId: string
  /** Connection generation captured when the request started. */
  generation: number
}

export class ManagedGroups {
  private readonly deps: ManagedGroupsDeps
  private registry: ManagedResourceRegistry | null = null
  private browserEpoch = ''
  private generation = 0
  private readyPromise: Promise<void> | null = null
  private unavailableReason: string | null = null
  private readonly writeQueue = new PersistQueue()
  private publishQueue: Promise<void> = Promise.resolve()
  private connectQueue: Promise<void> = Promise.resolve()
  private readonly groupQueue = new KeyedSerialQueue()
  private readonly internalMoves = new InternalMoves(INTERNAL_MOVE_TTL_MS)
  private readonly requests = new RequestTracker()
  private readonly adoptingChromeTabIds = new Set<number>()
  private readonly pendingAdoptions = new Set<number>()
  private readonly inFlightRequests = new Map<string, { fingerprint?: string; promise: Promise<BrowserResponse> }>()

  constructor(deps: ManagedGroupsDeps) {
    this.deps = deps
  }

  /** Initialization barrier: every entry point awaits this before touching state. */
  initialize(): Promise<void> {
    if (!this.readyPromise) {
      this.readyPromise = this.loadState().catch((error: unknown) => {
        this.unavailableReason = error instanceof Error ? error.message : String(error)
        this.registry = null
        this.deps.logger.error('Managed registry unavailable, managed features disabled:', error)
      })
    }
    return this.readyPromise
  }

  /** Retries a failed load once (used by WS connect and requests) so transient errors recover. */
  private async retryInitialize(): Promise<void> {
    if (this.unavailableReason !== null) {
      this.readyPromise = null
      this.unavailableReason = null
      // Wait for any in-flight write to settle before re-reading authoritative
      // state; queued stale snapshots are skipped.
      await this.writeQueue.invalidate()
    }
    await this.initialize()
  }

  private isAvailable(): boolean {
    return this.registry !== null && this.unavailableReason === null
  }

  private ensureAvailable(): void {
    if (!this.isAvailable()) {
      throw new ManagedGroupsError({
        code: 'internal-error',
        message: `managed registry unavailable: ${this.unavailableReason ?? 'not initialized'}`,
      })
    }
  }

  private async loadState(): Promise<void> {
    await restrictStorageToTrustedContexts()
    const epoch = await ensureBrowserEpoch()
    const profileId = await this.deps.getProfileId()
    this.browserEpoch = epoch.browserEpoch

    const stored = await loadRegistry()
    if (!stored) {
      this.registry = createEmptyRegistry({ profileId, browserEpoch: this.browserEpoch })
      await this.persist()
      return
    }

    if (stored.profileId !== profileId) {
      // Keep the records on disk untouched; this profile must not adopt them.
      throw new Error(`persisted managed registry belongs to profile ${stored.profileId}, not ${profileId}`)
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
    try {
      await this.writeQueue.run(() => {
        return saveRegistry(snapshot)
      })
    } catch (error: unknown) {
      // Never advertise ownership that could not be persisted. A later successful
      // load re-reads storage (the authoritative copy) and discards in-memory drift.
      this.unavailableReason = error instanceof Error ? error.message : String(error)
      this.deps.logger.error('Failed to persist managed registry:', error)
      throw error
    }
  }

  async publishInventory(): Promise<void> {
    if (!this.isAvailable()) return
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
      .filter((group) => {
        return (
          group.chromeGroupId !== undefined &&
          group.browserEpoch === this.browserEpoch &&
          group.state !== 'released' &&
          group.state !== 'needs-rebind'
        )
      })
      .map((group) => group.chromeGroupId as number)
  }

  getManagedChromeTabIds(): number[] {
    const pending = Array.from(this.pendingAdoptions)
    if (!this.registry) return pending
    const active = this.registry.tabs
      .filter((tab) => {
        return tab.browserEpoch === this.browserEpoch && tab.state !== 'released' && tab.state !== 'needs-rebind'
      })
      .map((tab) => tab.chromeTabId)
    return [...active, ...pending]
  }

  isManagedChromeTabId(chromeTabId: number): boolean {
    if (this.pendingAdoptions.has(chromeTabId)) return true
    if (!this.registry) return false
    return findActiveTabByChromeTabId(this.registry, { chromeTabId, browserEpoch: this.browserEpoch }) !== undefined
  }

  findManagedTabByChromeTabId(chromeTabId: number): BrowserTab | undefined {
    if (!this.registry) return undefined
    return findActiveTabByChromeTabId(this.registry, { chromeTabId, browserEpoch: this.browserEpoch })
  }

  /**
   * True when this tab was attached in place, so its window layout and Chrome
   * groups must be left alone — including the child tabs it opens.
   */
  isInPlaceManagedChromeTab(chromeTabId: number): boolean {
    const tab = this.findManagedTabByChromeTabId(chromeTabId)
    if (!tab) return false
    const group = findGroup(this.getRegistry(), tab.groupId)
    return group?.origin === 'existing'
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
    await this.retryInitialize()
    if (!this.isAvailable()) {
      this.deps.logger.warn('Skipping managed restore: registry unavailable')
      return
    }
    this.generation += 1
    const generation = this.generation

    // Fence: any record written after this revision (a create/release that lands
    // while we are observing Chrome) is newer than the snapshot we are about to
    // take and must win over it.
    const revisionBeforeObserve = this.getRegistry().revision
    const observed = await this.observeChromeState()
    if (generation !== this.generation) return

    // Re-read after the await so releases/mutations that happened during
    // observation are applied to the freshest registry, and reconcile with the
    // revision fence so the stale snapshot cannot release newer records.
    const result = reconcileRegistry(this.getRegistry(), {
      browserEpoch: this.browserEpoch,
      observedTabs: observed.observedTabs,
      observedChromeGroupIds: observed.observedChromeGroupIds,
      ignoreRecordsNewerThan: revisionBeforeObserve,
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
          chromeGroupId: tab.groupId ?? TAB_ID_NONE,
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
      if (!tab || tab.browserEpoch !== this.browserEpoch || tab.state !== 'disconnected') continue
      if (isChromeTabTombstoned(this.getRegistry(), chromeTabId, { browserEpoch: this.browserEpoch })) continue

      const exists = await this.chromeTabExists(chromeTabId)
      if (!exists) {
        await this.releaseManagedTab({ tabId: tab.tabId, reason: 'tab-disappeared-before-reattach', ungroup: false })
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
      if (!requestId) {
        throw new ManagedGroupsError({ code: 'invalid-request', message: 'requestId must not be empty' })
      }
      if (typeof request.sessionId !== 'string' || request.sessionId.length === 0) {
        throw new ManagedGroupsError({ code: 'invalid-request', message: 'sessionId must not be empty' })
      }
      if (!isBrowserOperation(request.operation)) {
        throw new ManagedGroupsError({ code: 'invalid-request', message: 'operation.kind is required' })
      }

      // Cancel is handled before init/restore waits: it must be able to interrupt
      // a request that is still queued behind the restore or a per-group lock.
      if (request.operation.kind === 'request.cancel') {
        return this.handleRequestCancel(request)
      }

      await this.retryInitialize()
      // Wait for an in-flight restore so requests never observe a half-reconciled registry.
      await this.connectQueue
      this.ensureAvailable()

      const dedupe = this.buildCreateDedupeContext(request)
      let recoveryEntry: RequestLedgerEntry | undefined
      if (dedupe) {
        const decision = classifyCreateRequestDedupe({
          ledgerEntry: dedupe.ledgerEntry,
          operation: dedupe.operation,
          fingerprint: dedupe.fingerprint,
        })
        if (decision === 'reject-payload-mismatch') {
          throw new ManagedGroupsError({
            code: 'invalid-request',
            message: `requestId ${requestId} was already used with a different payload`,
          })
        }
        if (decision === 'replay' && dedupe.ledgerEntry) {
          return this.replayCompletedCreate(requestId, dedupe.ledgerEntry)
        }
        if (decision === 'recover-pending') {
          recoveryEntry = dedupe.ledgerEntry
        }
      }

      const inFlightKey = dedupe?.key ?? `${request.sessionId}\u0000${requestId}`
      const existing = this.inFlightRequests.get(inFlightKey)
      if (existing) {
        if (dedupe && existing.fingerprint !== undefined && existing.fingerprint !== dedupe.fingerprint) {
          throw new ManagedGroupsError({
            code: 'invalid-request',
            message: `requestId ${requestId} is in flight with a different payload`,
          })
        }
        return existing.promise
      }

      this.requests.start({ sessionId: request.sessionId, requestId })
      const context: RequestContext = {
        sessionId: request.sessionId,
        requestId,
        generation: this.generation,
      }
      const promise = recoveryEntry
        ? this.dispatchPendingRecovery(request, recoveryEntry, context)
        : this.dispatchRequest(request, context)
      this.inFlightRequests.set(inFlightKey, { fingerprint: dedupe?.fingerprint, promise })
      try {
        return await promise
      } finally {
        this.inFlightRequests.delete(inFlightKey)
        this.requests.finish({ sessionId: request.sessionId, requestId })
      }
    } catch (error: unknown) {
      return this.errorResponse(requestId, error)
    }
  }

  /**
   * Recovery of an interrupted create runs through the per-group queue and the
   * request tracker like a normal create, with the same cancellation and owner
   * fences, so a cancel can stop it before it touches Chrome.
   */
  private dispatchPendingRecovery(
    request: BrowserRequest,
    entry: RequestLedgerEntry,
    context: RequestContext,
  ): Promise<BrowserResponse> {
    const queueKey = entry.groupId ?? `pending:${entry.requestId}`
    return this.groupQueue.run(queueKey, () => {
      return this.recoverPendingCreate(request, entry, context)
    })
  }

  /**
   * Completed-create dedup is persisted in the registry, so a retry with the
   * same sessionId + requestId + payload returns the original resource instead
   * of creating a duplicate after a reconnect or service-worker restart. Reusing
   * the same requestId with a different payload is rejected.
   */
  private buildCreateDedupeContext(request: BrowserRequest): CreateDedupeContext | null {
    const operation = request.operation
    if (operation.kind !== 'groups.create' && operation.kind !== 'tabs.create') return null
    const fingerprint =
      operation.kind === 'groups.create'
        ? buildCreateRequestFingerprint({ kind: 'groups.create', name: validateGroupName(operation.name) })
        : buildCreateRequestFingerprint({
            kind: 'tabs.create',
            groupId: operation.groupId,
            url: validateNavigationUrl(operation.url),
          })

    const ledgerEntry = findRequestLedgerEntry(this.getRegistry(), {
      sessionId: request.sessionId,
      requestId: request.requestId,
    })
    return {
      key: `${request.sessionId}\u0000${request.requestId}`,
      operation: operation.kind,
      fingerprint,
      ledgerEntry,
    }
  }

  private replayCompletedCreate(requestId: string, entry: RequestLedgerEntry): BrowserResponse {
    const registry = this.getRegistry()
    if (entry.operation === 'groups.create') {
      const group = entry.groupId ? findGroup(registry, entry.groupId) : undefined
      if (!group || group.state === 'released') {
        throw new ManagedGroupsError({
          code: 'resource-released',
          message: 'the group created by this request is no longer active',
        })
      }
      return ok(requestId, { group })
    }
    const tab = entry.tabId ? findTab(registry, entry.tabId) : undefined
    if (!tab || tab.state === 'released') {
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: 'the tab created by this request is no longer active',
      })
    }
    return ok(requestId, { tab })
  }

  private rememberCreate(
    request: BrowserRequest,
    options: {
      fingerprint: string
      phase: RequestLedgerEntry['phase']
      groupId?: string
      tabId?: string
      chromeTabId?: number
      now: number
    },
  ): void {
    const operation = request.operation.kind === 'groups.create' ? 'groups.create' : 'tabs.create'
    const entry: RequestLedgerEntry = {
      sessionId: request.sessionId,
      requestId: request.requestId,
      operation,
      fingerprint: options.fingerprint,
      phase: options.phase,
      createdAt: options.now,
      ...(options.groupId !== undefined ? { groupId: options.groupId } : {}),
      ...(options.tabId !== undefined ? { tabId: options.tabId } : {}),
      ...(options.chromeTabId !== undefined ? { chromeTabId: options.chromeTabId } : {}),
    }
    this.mutate((registry) => {
      return appendRequestLedgerEntry(registry, {
        entry,
        now: options.now,
        maxEntries: MAX_LEDGER_ENTRIES,
        maxAgeMs: LEDGER_MAX_AGE_MS,
      })
    })
  }

  private forgetCreate(request: BrowserRequest): void {
    this.mutate((registry) => {
      return removeRequestLedgerEntry(registry, {
        sessionId: request.sessionId,
        requestId: request.requestId,
      })
    })
  }

  private async dispatchRequest(request: BrowserRequest, context: RequestContext): Promise<BrowserResponse> {
    const operation = request.operation
    switch (operation.kind) {
      case 'groups.list':
        return this.handleGroupsList(request)
      case 'groups.create':
        return this.handleGroupsCreate(request, operation, context)
      case 'groups.rename':
        return this.handleGroupsRename(request, operation)
      case 'groups.close':
        return this.handleGroupsClose(request, operation)
      case 'tabs.list':
        return this.handleTabsList(request, operation)
      case 'tabs.discover':
        return this.handleTabsDiscover(request, operation)
      case 'tabs.attach':
        return this.handleTabsAttach(request, operation, context)
      case 'tabs.activate':
        return this.handleTabsActivate(request, operation)
      case 'tabs.create':
        return this.groupQueue.run(operation.groupId, () => {
          return this.handleTabsCreate(request, operation, context)
        })
      case 'tabs.close':
        return this.handleTabsClose(request, operation)
      case 'tabs.release':
        return this.handleTabsRelease(request, operation)
      case 'tab.resolve':
        return this.handleTabResolve(request, operation)
      case 'request.cancel':
        // Never queued behind group mutations: a cancel must be able to stop a
        // create that currently holds the per-group lock.
        return this.handleRequestCancel(request)
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

  /**
   * Fence checked before every Chrome write in a request flow: the connection
   * generation must not have changed (a dropped socket invalidates its requests),
   * the request must not have been cancelled, and - when a tab id is given - the
   * tab must still be owned by this session and epoch, not released.
   */
  private assertCanContinue(context: RequestContext, options: { tabId?: string } = {}): void {
    if (context.generation !== this.generation) {
      throw new ManagedGroupsError({
        code: 'internal-error',
        message: 'connection generation changed while the request was running; remaining steps aborted',
        outcome: 'unknown',
      })
    }
    if (this.requests.isCancelled({ sessionId: context.sessionId, requestId: context.requestId })) {
      throw new ManagedGroupsError({
        code: 'cancelled',
        message: 'request was cancelled; remaining steps aborted',
        outcome: this.requests.outcomeForCancelled({ sessionId: context.sessionId, requestId: context.requestId }),
      })
    }
    if (options.tabId !== undefined) {
      const tab = findTab(this.getRegistry(), options.tabId)
      if (!tab || tab.state === 'released') {
        throw new ManagedGroupsError({
          code: 'resource-released',
          message: 'tab was released while the request was running; not touching Chrome further',
          outcome: 'unknown',
        })
      }
      if (tab.browserEpoch !== this.browserEpoch) {
        throw new ManagedGroupsError({
          code: 'needs-rebind',
          message: 'tab belongs to a previous browser run; its Chrome mapping is not reused',
          outcome: 'unknown',
        })
      }
    }
  }

  /** request.cancel: stops future steps of a same-session request, never queued. */
  private handleRequestCancel(request: BrowserRequest): BrowserResponse {
    const operation = request.operation
    if (operation.kind !== 'request.cancel') {
      throw new ManagedGroupsError({ code: 'invalid-request', message: 'expected request.cancel' })
    }
    const targetRequestId = operation.targetRequestId
    if (typeof targetRequestId !== 'string' || targetRequestId.length === 0) {
      throw new ManagedGroupsError({ code: 'invalid-request', message: 'targetRequestId must not be empty' })
    }
    const lookup = this.requests.cancel({ sessionId: request.sessionId, targetRequestId })
    const text =
      lookup === 'cancelled'
        ? `cancel requested for ${targetRequestId}`
        : `no active request ${targetRequestId} in this session`
    return ok(request.requestId, { text })
  }

  /**
   * The websocket connection dropped: invalidate its generation and cancel every
   * control request that belongs to it. Ownership records are untouched, so a
   * later reconnect restores bindings without replaying operations.
   */
  handleWsDisconnected(): void {
    this.generation += 1
    this.requests.cancelAll()
    this.deps.logger.debug('Managed transport disconnected: in-flight control requests invalidated')
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
    context: RequestContext,
  ): Promise<BrowserResponse> {
    const name = validateGroupName(operation.name)
    this.assertCanContinue(context)
    const groupId = createOpaqueId('pgrp')
    // Group record and completed ledger entry are written in one transaction, so
    // an interrupted group create can never leave a half-created resource.
    this.mutate((registry) => {
      return addGroup(registry, {
        groupId,
        sessionId: request.sessionId,
        name,
        browserEpoch: this.browserEpoch,
      })
    })
    this.requests.markSideEffects({ sessionId: context.sessionId, requestId: context.requestId })
    this.rememberCreate(request, {
      fingerprint: buildCreateRequestFingerprint({ kind: 'groups.create', name }),
      phase: 'completed',
      groupId,
      now: Date.now(),
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
    return this.groupQueue.run(operation.groupId, async () => {
      const name = validateGroupName(operation.name)
      // Re-read inside the per-group critical section: a concurrent first tab
      // creation may have just bound the Chrome group.
      const group = this.requireGroup({ groupId: operation.groupId, sessionId: request.sessionId })
      if (group.state === 'released') {
        throw new ManagedGroupsError({ code: 'resource-released', message: `group ${group.groupId} is released` })
      }
      if (group.state === 'needs-rebind' || group.browserEpoch !== this.browserEpoch) {
        throw new ManagedGroupsError({
          code: 'needs-rebind',
          message: `group ${group.groupId} belongs to a previous browser run: the record is kept, its old Chrome mapping is not reused, and it is not recovered automatically`,
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
    })
  }

  private async handleGroupsClose(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'groups.close' }>,
  ): Promise<BrowserResponse> {
    return this.groupQueue.run(operation.groupId, async () => {
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
    })
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
      const tabs = listSessionTabs(this.getRegistry(), request.sessionId, group.groupId).filter((tab) => {
        return operation.sourceTabId === undefined || tab.sourceTabId === operation.sourceTabId
      })
      return ok(request.requestId, { tabs })
    }
    const tabs = listSessionTabs(this.getRegistry(), request.sessionId).filter((tab) => {
      return operation.sourceTabId === undefined || tab.sourceTabId === operation.sourceTabId
    })
    return ok(request.requestId, { tabs })
  }

  /**
   * tabs.discover: metadata-only listing of the real tabs of this profile.
   *
   * Returns one entry per tab of every window so Pi can match the user's
   * description ("the one with the invoice, second window"). There is no single
   * "current tab": each window has its own active tab and the browser may have
   * no OS focus at all while the user is typing in the terminal. Listing never
   * reads page content.
   */
  private async handleTabsDiscover(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.discover' }>,
  ): Promise<BrowserResponse> {
    const [chromeTabs, windows] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getAll({ populate: false }),
    ])
    const windowTypes = new Map<number, string>()
    const focusedWindowIds = new Set<number>()
    for (const window of windows) {
      if (window.id === undefined) continue
      if (window.type !== undefined) windowTypes.set(window.id, window.type)
      if (window.focused) focusedWindowIds.add(window.id)
    }

    const query = operation.query?.trim().toLowerCase()
    const candidates = chromeTabs
      .filter((tab) => {
        if (tab.id === undefined) return false
        if (operation.windowId !== undefined && tab.windowId !== operation.windowId) return false
        if (query !== undefined && query.length > 0) {
          const haystack = `${tab.title ?? ''}\n${tab.url ?? ''}`.toLowerCase()
          if (!haystack.includes(query)) return false
        }
        return true
      })
      .sort((a, b) => {
        return a.windowId - b.windowId || a.index - b.index
      })
      .map((tab) => {
        return this.buildCandidate({
          chromeTab: tab,
          focusedWindowIds,
          windowType: windowTypes.get(tab.windowId),
          sessionId: request.sessionId,
        })
      })
      .filter((candidate) => {
        return operation.includeManaged === false ? !candidate.managed : true
      })

    const skipped = candidates.filter((candidate) => !candidate.attachable).length
    const text =
      `Discovered ${candidates.length} tab(s) in this profile across ${windows.length} window(s)` +
      (skipped > 0 ? `; ${skipped} cannot be attached (see reason on each entry)` : '') +
      `. Listing is metadata only: no page content was read. Other profiles are listed separately by the runtime.`
    return ok(request.requestId, { candidates, text })
  }

  private buildCandidate(options: {
    chromeTab: chrome.tabs.Tab
    focusedWindowIds: Set<number>
    windowType: string | undefined
    sessionId: string
  }): BrowserTabCandidate {
    const chromeTab = options.chromeTab
    const chromeTabId = chromeTab.id as number
    const url = chromeTab.url ?? ''
    const title = chromeTab.title ?? ''
    const managed = findActiveTabByChromeTabId(this.getRegistry(), {
      chromeTabId,
      browserEpoch: this.browserEpoch,
    })
    // A popup window cannot host a managed page: the debugger target lives in a
    // window the user did not ask us to control.
    const unsupported = options.windowType !== undefined && options.windowType !== 'normal'
    const restricted = this.deps.isRestrictedUrl(url)
    const ownedByOtherSession = managed !== undefined && managed.sessionId !== options.sessionId
    const attachable = !unsupported && !restricted && !ownedByOtherSession
    const base = {
      candidateId: buildTabCandidateId({
        profileId: this.getRegistry().profileId,
        browserEpoch: this.browserEpoch,
        chromeTabId,
      }),
      profileId: this.getRegistry().profileId,
      profileLabel: '',
      browser: '',
      browserEpoch: this.browserEpoch,
      windowId: chromeTab.windowId,
      active: chromeTab.active === true,
      windowFocused: options.focusedWindowIds.has(chromeTab.windowId),
      chromeTabId,
      url,
      title,
      managed: managed !== undefined,
      ownedByThisSession: managed !== undefined && !ownedByOtherSession,
    }
    if (unsupported) {
      return { ...base, attachable: false, reason: 'unsupported-page' }
    }
    if (restricted) {
      return { ...base, attachable: false, reason: 'restricted-url' }
    }
    if (managed !== undefined) {
      return {
        ...base,
        attachable,
        tabId: managed.tabId,
        ...(ownedByOtherSession ? { reason: 'owned-by-other-session' as const } : {}),
      }
    }
    return { ...base, attachable: true }
  }

  /**
   * tabs.attach: take control of an existing tab without disturbing it.
   *
   * No reload, no window move, no Chrome tab group: the tab keeps its scroll
   * position, form state and group membership. Only the tab named by the
   * candidate is attached - never the rest of its Chrome group. The internal
   * logical group this creates is marked `existing`, which is what stops
   * reconcile/tab.resolve from releasing it for "not being in a task group".
   */
  private async handleTabsAttach(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.attach' }>,
    context: RequestContext,
  ): Promise<BrowserResponse> {
    const parsed = parseTabCandidateId(operation.candidateId)
    if (!parsed) {
      throw new ManagedGroupsError({
        code: 'invalid-request',
        message: 'candidateId is not a discovery id; run tabs.discover again',
      })
    }
    const registry = this.getRegistry()
    if (parsed.profileId !== registry.profileId) {
      throw new ManagedGroupsError({
        code: 'ownership-mismatch',
        message: `discovery ${operation.candidateId} belongs to profile ${parsed.profileId}, not this one`,
      })
    }
    // Chrome numeric ids are only meaningful inside one browser run: a stale
    // discovery must never attach whatever tab reuses that id now.
    if (parsed.browserEpoch !== this.browserEpoch) {
      throw new ManagedGroupsError({
        code: 'stale-snapshot',
        message: 'this tab was discovered in an earlier browser run; discover it again before attaching',
      })
    }
    this.assertCanContinue(context)

    const chromeTab = await chrome.tabs.get(parsed.chromeTabId).catch(() => {
      return null
    })
    if (!chromeTab) {
      throw new ManagedGroupsError({
        code: 'resource-not-found',
        message: `the discovered tab no longer exists in Chrome (chromeTabId=${parsed.chromeTabId})`,
      })
    }
    if (this.deps.isRestrictedUrl(chromeTab.url)) {
      throw new ManagedGroupsError({
        code: 'unsupported-capability',
        message: 'this page cannot be controlled (browser-internal or restricted page)',
      })
    }
    const chromeTabId = parsed.chromeTabId
    const url = chromeTab.url ?? ''
    const title = chromeTab.title ?? ''

    const existing = findActiveTabByChromeTabId(this.getRegistry(), {
      chromeTabId,
      browserEpoch: this.browserEpoch,
    })
    if (existing) {
      if (existing.sessionId !== request.sessionId) {
        throw new ManagedGroupsError({
          code: 'ownership-mismatch',
          message: `tab ${existing.tabId} is already controlled by another session`,
        })
      }
      // Reuse the existing claim; only re-attach the debugger when needed.
      if (existing.state !== 'ready') {
        const attached = await this.deps.attachTab(chromeTabId)
        this.assertCanContinue(context, { tabId: existing.tabId })
        this.mutate((current) => {
          return setTabAttachment(current, {
            tabId: existing.tabId,
            targetId: attached.targetInfo.targetId,
            cdpSessionId: attached.sessionId,
          })
        })
      }
      this.mutate((current) => {
        return setTabPageInfo(current, { tabId: existing.tabId, url, title })
      })
      await this.persist()
      await this.publishInventory()
      const current = findTab(this.getRegistry(), existing.tabId)
      if (!current) {
        throw new ManagedGroupsError({ code: 'internal-error', message: 'tab vanished while re-attaching' })
      }
      return ok(request.requestId, { tab: current })
    }

    const groupId = createOpaqueId('pgrp')
    const tabId = createOpaqueId('ptab')
    this.mutate((current) => {
      return addGroup(current, {
        groupId,
        sessionId: request.sessionId,
        name: buildExistingGroupName(title),
        browserEpoch: this.browserEpoch,
        origin: 'existing',
      })
    })
    this.mutate((current) => {
      return addTab(current, {
        tabId,
        groupId,
        sessionId: request.sessionId,
        chromeTabId,
        url,
        title,
        browserEpoch: this.browserEpoch,
        origin: 'existing',
      })
    })
    await this.persist()

    try {
      this.assertCanContinue(context, { tabId })
      const attached = await this.deps.attachTab(chromeTabId)
      this.assertCanContinue(context, { tabId })
      this.mutate((current) => {
        return setTabAttachment(current, {
          tabId,
          targetId: attached.targetInfo.targetId,
          cdpSessionId: attached.sessionId,
        })
      })
      this.mutate((current) => {
        return setTabPageInfo(current, { tabId, url, title })
      })
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      // Never leave a claim on the user's tab when we could not drive it.
      this.mutate((current) => {
        return releaseTab(current, tabId)
      })
      this.mutate((current) => {
        return setGroupState(current, { groupId, state: 'released' })
      })
      await this.persist()
      await this.publishInventory()
      throw error
    }

    const tab = findTab(this.getRegistry(), tabId)
    if (!tab) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'attached tab vanished from the registry' })
    }
    return ok(request.requestId, { tab })
  }

  /**
   * tabs.activate: make the original tab the active tab of its window again
   * after reading a link elsewhere. It never navigates, recreates or closes the
   * tab, and it does not steal OS focus from the terminal.
   */
  private async handleTabsActivate(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.activate' }>,
  ): Promise<BrowserResponse> {
    const tab = this.requireTab({ tabId: operation.tabId, sessionId: request.sessionId })
    if (tab.state === 'needs-rebind' || tab.browserEpoch !== this.browserEpoch) {
      throw new ManagedGroupsError({
        code: 'needs-rebind',
        message: `tab ${tab.tabId} belongs to a previous browser run; its Chrome mapping is not reused`,
      })
    }
    const chromeTab = await chrome.tabs.update(tab.chromeTabId, { active: true }).catch(() => {
      return null
    })
    if (!chromeTab) {
      await this.releaseManagedTab({ tabId: tab.tabId, reason: 'activate-tab-missing', ungroup: false })
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab ${tab.tabId} no longer exists in Chrome`,
      })
    }
    this.mutate((registry) => {
      return setTabPageInfo(registry, {
        tabId: tab.tabId,
        url: chromeTab.url ?? tab.url,
        title: chromeTab.title ?? tab.title,
      })
    })
    await this.persist()
    const activated = findTab(this.getRegistry(), tab.tabId)
    if (!activated) {
      throw new ManagedGroupsError({ code: 'internal-error', message: 'tab vanished during activate' })
    }
    return ok(request.requestId, { tab: activated })
  }

  private async handleTabsCreate(
    request: BrowserRequest,
    operation: Extract<BrowserOperation, { kind: 'tabs.create' }>,
    context: RequestContext,
  ): Promise<BrowserResponse> {
    // Re-read the group inside the per-group critical section: concurrent first
    // creates for one group must reuse the Chrome group the first one bound.
    const group = this.requireGroup({ groupId: operation.groupId, sessionId: request.sessionId })
    if (group.state === 'released') {
      throw new ManagedGroupsError({ code: 'resource-released', message: `group ${group.groupId} is released` })
    }
    if (group.state === 'needs-rebind' || group.browserEpoch !== this.browserEpoch) {
      throw new ManagedGroupsError({
        code: 'needs-rebind',
        message: `group ${group.groupId} was created in a previous browser run: its Chrome mapping is not reused and it is kept as a needs-rebind record. It is not recovered automatically; close it explicitly or create a new group.`,
      })
    }
    const url = validateNavigationUrl(operation.url)
    this.assertCanContinue(context)

    // Preallocated logical id + pending ledger entry are persisted before any
    // Chrome side effect, so an interrupted attempt can never create a duplicate.
    const tabId = createOpaqueId('ptab')
    const fingerprint = buildCreateRequestFingerprint({ kind: 'tabs.create', groupId: operation.groupId, url })
    this.rememberCreate(request, {
      fingerprint,
      phase: 'pending',
      tabId,
      groupId: operation.groupId,
      now: Date.now(),
    })
    await this.persist()

    let chromeTabId: number | undefined
    let approvedChromeGroupId: number | undefined
    let recordPersisted = false
    try {
      this.assertCanContinue(context)
      const windowId = await this.resolveGroupWindow(group)
      this.assertCanContinue(context)
      const created = await chrome.tabs.create({
        url: 'about:blank',
        active: false,
        ...(windowId !== undefined ? { windowId } : {}),
      })
      const createdChromeTabId = created.id
      if (createdChromeTabId === undefined) {
        throw new ManagedGroupsError({ code: 'internal-error', message: 'Chrome did not return a tab id' })
      }
      chromeTabId = createdChromeTabId
      this.requests.markSideEffects({ sessionId: context.sessionId, requestId: context.requestId })

      this.assertCanContinue(context)
      const chromeGroupId = await this.ensureTabInManagedGroup({
        chromeTabId: createdChromeTabId,
        group,
        windowId: created.windowId,
      })
      approvedChromeGroupId = chromeGroupId

      // Record + pending ledger update in one transaction; the record is
      // persisted before attach so a crash resumes instead of duplicating.
      this.mutate((registry) => {
        return addTab(registry, {
          tabId,
          groupId: group.groupId,
          sessionId: request.sessionId,
          chromeTabId: createdChromeTabId,
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
      this.mutate((registry) => {
        return updateRequestLedgerPhase(registry, {
          sessionId: request.sessionId,
          requestId: request.requestId,
          phase: 'pending',
          chromeTabId: createdChromeTabId,
        })
      })
      await this.persist()
      recordPersisted = true

      // Owner fence before touching the tab again: a release during grouping must
      // win, otherwise we would attach/navigate a tab the user just took back.
      this.assertCanContinue(context, { tabId })
      const attached = await this.deps.attachTab(chromeTabId)

      // Same fence after attach: the user may have released the tab while the
      // debugger was attaching - never navigate it in that case.
      this.assertCanContinue(context, { tabId })
      const stillInGroup = await this.isTabInChromeGroup({ chromeTabId, chromeGroupId })
      if (!stillInGroup) {
        throw new ManagedGroupsError({
          code: 'internal-error',
          message: 'new tab left its managed group before the request completed',
          outcome: 'unknown',
        })
      }

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
          tabId,
          targetId: attached.targetInfo.targetId,
          cdpSessionId: attached.sessionId,
        })
      })
      this.mutate((registry) => {
        return setTabPageInfo(registry, {
          tabId,
          url: verified.url && verified.url !== 'about:blank' ? verified.url : url,
          title: verified.title ?? '',
        })
      })
      this.mutate((registry) => {
        return updateRequestLedgerPhase(registry, {
          sessionId: request.sessionId,
          requestId: request.requestId,
          phase: 'completed',
          chromeTabId: createdChromeTabId,
        })
      })
      await this.persist()
      await this.publishInventory()

      const tab = findTab(this.getRegistry(), tabId)
      if (!tab) {
        throw new ManagedGroupsError({ code: 'internal-error', message: 'created tab vanished from the registry' })
      }
      return ok(request.requestId, { tab })
    } catch (error: unknown) {
      if (
        recordPersisted &&
        this.requests.isCancelled({ sessionId: context.sessionId, requestId: context.requestId })
      ) {
        // Cancellation stops future steps but keeps the resource: the tab exists
        // and is registered, so it is re-attached on the next connection. It is
        // never deleted just because the request was cancelled.
        await this.persist()
        await this.publishInventory()
        throw error
      }
      await this.cleanupFailedCreate({
        request,
        chromeTabId,
        tabId: recordPersisted ? tabId : undefined,
        approvedChromeGroupId,
      })
      throw error
    }
  }

  /**
   * Cleans up a failed `tabs.create`. The Chrome tab is only removed while it is
   * still provably ours: same epoch, record not released, and still inside the
   * group this operation created. If the user released or moved it meanwhile we
   * stop touching Chrome and just drop control. A pending ledger entry with no
   * persisted record is dropped so a later retry can proceed cleanly.
   */
  private async cleanupFailedCreate(options: {
    request: BrowserRequest
    chromeTabId?: number
    tabId?: string
    approvedChromeGroupId?: number
  }): Promise<void> {
    const registry = this.getRegistry()
    const record = options.tabId ? findTab(registry, options.tabId) : undefined
    const observed =
      options.chromeTabId === undefined
        ? null
        : await chrome.tabs.get(options.chromeTabId).catch(() => {
            return null
          })
    const decision =
      options.chromeTabId === undefined
        ? 'leave-user-tab'
        : classifyFailedCreateCleanup({
            recordState: record ? record.state : 'missing',
            recordBrowserEpoch: record?.browserEpoch,
            browserEpoch: this.browserEpoch,
            approvedChromeGroupId: options.approvedChromeGroupId ?? TAB_ID_NONE,
            observedChromeGroupId: observed ? (observed.groupId ?? TAB_ID_NONE) : null,
          })

    const recordIsCurrent =
      record !== undefined && record.browserEpoch === this.browserEpoch && record.state !== 'released'
    if (options.tabId && recordIsCurrent) {
      const failedTabId = options.tabId
      this.mutate((current) => {
        return releaseTab(current, failedTabId)
      })
    }

    if (!options.tabId) {
      // No record was ever persisted: the intent ledger entry is void.
      this.forgetCreate(options.request)
    }

    if (options.chromeTabId !== undefined) {
      this.deps.detachManagedTab(options.chromeTabId)
      if (decision === 'remove-chrome-tab') {
        await chrome.tabs.remove(options.chromeTabId).catch((error: unknown) => {
          this.deps.logger.debug(`Failed create cleanup: tab ${options.chromeTabId} already gone:`, error)
        })
        this.deps.logger.warn(`Cleaned up failed tabs.create (chromeTabId=${options.chromeTabId})`)
      } else {
        this.deps.logger.warn(
          `tabs.create failed after tab ${options.chromeTabId} was taken over by the user; leaving it open`,
        )
      }
    }

    await this.persist()
    await this.publishInventory()
  }

  /**
   * Retry of an interrupted (pending) create. Only a verifiably owned tab is
   * resumed by re-attaching the debugger; navigation is never replayed because we
   * cannot know whether it was already sent.
   */
  private async recoverPendingCreate(
    request: BrowserRequest,
    entry: RequestLedgerEntry,
    context: RequestContext,
  ): Promise<BrowserResponse> {
    if (entry.operation !== 'tabs.create') {
      throw new ManagedGroupsError({
        code: 'outcome-unknown',
        outcome: 'unknown',
        message:
          'a previous groups.create was interrupted; the group is either fully written or absent, so it is not resumed automatically',
      })
    }
    // The earlier attempt already had Chrome side effects; a cancel now must
    // report unknown rather than claiming nothing happened.
    this.requests.markSideEffects({ sessionId: context.sessionId, requestId: context.requestId })
    this.assertCanContinue(context)

    const registry = this.getRegistry()
    const tab = entry.tabId ? findTab(registry, entry.tabId) : undefined
    const group = tab ? findGroup(registry, tab.groupId) : undefined
    const chromeTab = tab
      ? await chrome.tabs.get(tab.chromeTabId).catch(() => {
          return null
        })
      : null
    const decision = classifyPendingCreateRecovery({
      hasRecord: tab !== undefined,
      recordState: tab ? tab.state : 'missing',
      recordBrowserEpoch: tab?.browserEpoch,
      browserEpoch: this.browserEpoch,
      chromeTabExists: chromeTab !== null,
      observedChromeGroupId: chromeTab ? (chromeTab.groupId ?? TAB_ID_NONE) : null,
      expectedChromeGroupId: group?.chromeGroupId,
    })

    // Cancellation/generation/ownership fence after the Chrome read and before
    // the resume attaches anything.
    this.assertCanContinue(context, tab ? { tabId: tab.tabId } : {})

    if (decision === 'released') {
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: 'the tab from the interrupted create was released and is not resumed',
      })
    }
    if (decision !== 'resume-attach' || !tab) {
      throw new ManagedGroupsError({
        code: 'outcome-unknown',
        outcome: 'unknown',
        message:
          'the interrupted create cannot be verified against Chrome; its previous navigation is not replayed and the request outcome is unknown',
      })
    }

    try {
      const attached = await this.deps.attachTab(tab.chromeTabId)
      // The user may have released the tab while the debugger was attaching.
      this.assertCanContinue(context, { tabId: tab.tabId })
      this.mutate((current) => {
        return setTabAttachment(current, {
          tabId: tab.tabId,
          targetId: attached.targetInfo.targetId,
          cdpSessionId: attached.sessionId,
        })
      })
      this.mutate((current) => {
        return setTabPageInfo(current, {
          tabId: tab.tabId,
          url: chromeTab?.url ?? tab.url,
          title: chromeTab?.title ?? tab.title,
        })
      })
      this.mutate((current) => {
        return updateRequestLedgerPhase(current, {
          sessionId: entry.sessionId,
          requestId: entry.requestId,
          phase: 'completed',
          chromeTabId: tab.chromeTabId,
        })
      })
      const resumed = findTab(this.getRegistry(), tab.tabId)
      if (!resumed || resumed.state === 'released') {
        throw new ManagedGroupsError({
          code: 'resource-released',
          message: 'the tab was released while the interrupted create was being resumed',
        })
      }
      await this.persist()
      await this.publishInventory()
      this.deps.logger.warn(
        `Resumed interrupted tabs.create (${entry.requestId}): debugger re-attached, navigation not replayed`,
      )
      return ok(request.requestId, { tab: resumed })
    } catch (error: unknown) {
      if (error instanceof ManagedGroupsError) throw error
      throw new ManagedGroupsError({
        code: 'outcome-unknown',
        outcome: 'unknown',
        message: `failed to resume the interrupted create: ${error instanceof Error ? error.message : String(error)}`,
      })
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
    if (tab.state === 'needs-rebind' || tab.browserEpoch !== this.browserEpoch) {
      return ok(request.requestId, { tab })
    }

    const chromeTab = await chrome.tabs.get(tab.chromeTabId).catch(() => {
      return null
    })

    // Re-read after the await: the user may have released or moved the tab while
    // we were resolving it. This response is authoritative for the relay, so a
    // stale "ready" must never be returned.
    const current = findTab(this.getRegistry(), tab.tabId)
    if (!current || current.state === 'released') {
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab ${tab.tabId} was released while it was being resolved`,
      })
    }
    if (!chromeTab) {
      await this.releaseManagedTab({ tabId: current.tabId, reason: 'resolved-tab-missing', ungroup: false })
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab ${current.tabId} no longer exists in Chrome`,
      })
    }
    if (current.browserEpoch !== this.browserEpoch || current.state === 'needs-rebind') {
      throw new ManagedGroupsError({
        code: 'needs-rebind',
        message: `tab ${current.tabId} belongs to a previous browser run; its Chrome mapping is not reused`,
      })
    }
    const group = findGroup(this.getRegistry(), current.groupId)
    if (group?.chromeGroupId !== undefined && chromeTab.groupId !== group.chromeGroupId) {
      // The user moved the tab out of its managed group mid-resolve: tombstone it
      // immediately instead of reporting it as ready.
      await this.releaseManagedTab({ tabId: current.tabId, reason: 'resolved-tab-moved-out', ungroup: false })
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab ${current.tabId} is no longer inside its managed group`,
      })
    }

    this.mutate((registry) => {
      return setTabPageInfo(registry, {
        tabId: current.tabId,
        url: chromeTab.url ?? '',
        title: chromeTab.title ?? '',
      })
    })
    const resolved = findTab(this.getRegistry(), current.tabId)
    if (!resolved || resolved.state === 'released') {
      throw new ManagedGroupsError({
        code: 'resource-released',
        message: `tab ${current.tabId} was released while it was being resolved`,
      })
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
        this.internalMoves.register(options.chromeTabId, {
          expectedChromeGroupId: boundGroupId,
          ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
        })
        await chrome.tabs.group({ tabIds: [options.chromeTabId], groupId: boundGroupId })
        return boundGroupId
      }
    }

    const groupCount = this.getRegistry().groups.filter((group) => group.state !== 'released').length
    const chromeGroupId = await chrome.tabs.group({
      tabIds: [options.chromeTabId],
      createProperties: {
        ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
      },
    })
    // Registered right after the call resolves, before the onUpdated event task
    // runs, so the resulting move is recognised as ours.
    this.internalMoves.register(options.chromeTabId, {
      expectedChromeGroupId: chromeGroupId,
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
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

    if (tab.state !== 'needs-rebind' && tab.browserEpoch === this.browserEpoch) {
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

    // Old-epoch records point at numeric Chrome ids that may now belong to
    // unrelated tabs; never touch Chrome for them.
    const canTouchChrome = tab.browserEpoch === this.browserEpoch && tab.state !== 'needs-rebind'
    if (canTouchChrome) {
      this.deps.detachManagedTab(tab.chromeTabId)
      if (options.ungroup !== false && group?.chromeGroupId !== undefined) {
        const stillInGroup = await this.isTabInChromeGroup({
          chromeTabId: tab.chromeTabId,
          chromeGroupId: group.chromeGroupId,
        })
        if (stillInGroup) {
          this.internalMoves.register(tab.chromeTabId, { expectedChromeGroupId: TAB_ID_NONE })
          await chrome.tabs.ungroup(tab.chromeTabId).catch((error: unknown) => {
            this.deps.logger.debug(`Failed to ungroup released tab ${tab.chromeTabId}:`, error)
          })
        }
      }
    } else {
      this.deps.logger.debug(`Skipping Chrome for stale record ${tab.tabId} (${options.reason})`)
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
    if (group.state === 'needs-rebind' || group.browserEpoch !== this.browserEpoch) return
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

  // ---------------------------------------------------------------------------
  // Chrome event handlers
  // ---------------------------------------------------------------------------

  /** A Chrome tab we own was closed by the user/Chrome while the worker was alive. */
  async handleChromeTabRemoved(chromeTabId: number): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
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
      if (!this.isAvailable()) return
      const group = this.getRegistry().groups.find((candidate) => candidate.chromeGroupId === chromeGroupId)
      if (!group || group.state === 'released' || group.state === 'needs-rebind') return
      if (group.browserEpoch !== this.browserEpoch) return
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
   * The user renamed or moved a managed Chrome group. Identity is the Chrome
   * group id, never the title: the manual rename is recorded as the new logical
   * name (so later operations do not fight it) and window moves update the
   * stored window binding.
   */
  async handleChromeGroupUpdated(options: { chromeGroupId: number; title?: string; windowId?: number }): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
      const group = this.getRegistry().groups.find((candidate) => candidate.chromeGroupId === options.chromeGroupId)
      if (!group || group.state === 'released' || group.state === 'needs-rebind') return
      if (group.browserEpoch !== this.browserEpoch) return

      let changed = false
      const nextTitle = options.title?.trim()
      // Never let a cleared Chrome title erase the required logical name.
      if (nextTitle !== undefined && nextTitle.length > 0 && nextTitle !== group.name) {
        this.mutate((registry) => {
          return renameGroup(registry, { groupId: group.groupId, name: nextTitle })
        })
        changed = true
      }
      const nextWindowId = options.windowId
      if (nextWindowId !== undefined && nextWindowId !== group.windowId) {
        this.mutate((registry) => {
          return setGroupWindowId(registry, { groupId: group.groupId, windowId: nextWindowId })
        })
        changed = true
      }
      if (!changed) return
      this.deps.logger.debug(`Managed group ${options.chromeGroupId} updated in Chrome, registry synced`)
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      this.deps.logger.error('Failed to handle managed group update:', error)
    }
  }

  /**
   * chrome.tabs.onUpdated with a groupId change. Only a move that matches an
   * operation we just started is treated as internal; any other move out of the
   * managed group means the user took the tab back and becomes a tombstone.
   */
  async handleChromeTabUpdatedGroup(options: {
    chromeTabId: number
    chromeGroupId: number
    windowId?: number
    url: string
    title: string
  }): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
      if (
        this.internalMoves.matches(options.chromeTabId, {
          chromeGroupId: options.chromeGroupId,
          ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
        })
      ) {
        return
      }
      const tab = this.findManagedTabByChromeTabId(options.chromeTabId)
      if (!tab) return
      const group = findGroup(this.getRegistry(), tab.groupId)
      if (!group) return
      // A tab attached in place was never put into a Chrome group by us, so a
      // group change is the user's own business and must not release it.
      if (group.origin === 'existing') return

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
   * Debugger detach. The Chrome infobar cancel is extension-wide: it stops all
   * automation, so every managed tab becomes a released record (no auto
   * re-attach on reconnect) while logical groups and the Chrome tab layout are
   * left intact. Other detach reasons keep ownership and re-attach later.
   */
  async handleDebuggerDetached(
    chromeTabId: number,
    reason: string,
    options: { userCanceledAll?: boolean } = {},
  ): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
      if (reason === 'canceled_by_user') {
        if (options.userCanceledAll) {
          await this.releaseAllForUserCancel()
          return
        }
        const tab = this.findManagedTabByChromeTabId(chromeTabId)
        if (!tab) return
        await this.releaseManagedTab({ tabId: tab.tabId, reason: 'debugger-canceled-by-user', ungroup: true })
        return
      }
      const tab = this.findManagedTabByChromeTabId(chromeTabId)
      if (!tab) return
      this.mutate((registry) => {
        return clearTabAttachment(registry, tab.tabId)
      })
      await this.persist()
      await this.publishInventory()
    } catch (error: unknown) {
      this.deps.logger.error('Failed to handle debugger detach for managed tab:', error)
    }
  }

  private async releaseAllForUserCancel(): Promise<void> {
    const tabs = this.getRegistry().tabs.filter((tab) => {
      return tab.browserEpoch === this.browserEpoch && tab.state !== 'released' && tab.state !== 'needs-rebind'
    })
    for (const tab of tabs) {
      this.deps.detachManagedTab(tab.chromeTabId)
    }
    for (const tab of tabs) {
      this.mutate((registry) => {
        return releaseTab(registry, tab.tabId)
      })
    }
    this.deps.logger.warn(`User canceled automation in Chrome: released ${tabs.length} managed tab(s), groups kept`)
    await this.persist()
    await this.publishInventory()
  }

  /** Re-attaches a managed tab without changing ownership (used by the icon click). */
  async restoreChromeTab(chromeTabId: number): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
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
   *
   * Order is deliberate: pre-register the tab so the legacy sync cannot claim it,
   * move it into the target group window, group it, persist the record, and only
   * then attach. Every await re-checks that the source tab is still owned; on
   * failure the tab is left open (never a controlled, unregistered tab).
   */
  async adoptInheritedTab(options: { chromeTabId: number; sourceChromeTabId: number }): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
      if (this.adoptingChromeTabIds.has(options.chromeTabId)) return
      const initialSource = this.findManagedTabByChromeTabId(options.sourceChromeTabId)
      if (!initialSource || initialSource.state !== 'ready') return
      const initialGroup = findGroup(this.getRegistry(), initialSource.groupId)
      if (!initialGroup || initialGroup.state !== 'ready') return
      if (
        findActiveTabByChromeTabId(this.getRegistry(), {
          chromeTabId: options.chromeTabId,
          browserEpoch: this.browserEpoch,
        })
      ) {
        return
      }
      if (isChromeTabTombstoned(this.getRegistry(), options.chromeTabId, { browserEpoch: this.browserEpoch })) {
        return
      }

      this.adoptingChromeTabIds.add(options.chromeTabId)
      this.pendingAdoptions.add(options.chromeTabId)
      try {
        await this.groupQueue.run(initialGroup.groupId, async () => {
          // Re-read under the per-group lock: a concurrent close/release may have
          // changed ownership while we waited.
          const sourceTab = this.findManagedTabByChromeTabId(options.sourceChromeTabId)
          if (!sourceTab || sourceTab.state !== 'ready') return
          const group = findGroup(this.getRegistry(), sourceTab.groupId)
          if (!group || group.state !== 'ready') return

          const chromeTab = await this.waitForChromeTab(options.chromeTabId)
          if (!chromeTab) return
          if (this.deps.isRestrictedUrl(chromeTab.url)) return
          if (isChromeTabTombstoned(this.getRegistry(), options.chromeTabId, { browserEpoch: this.browserEpoch })) {
            return
          }

          // A tab attached in place is adopted in place too: the user's window
          // layout and Chrome groups stay exactly as they were. Task groups keep
          // their existing "popup joins the group" behaviour.
          const inPlace = group.origin === 'existing'
          // The window the tab actually ends up in: chromeTab was read before the
          // move, so its windowId is stale once we relocate the tab.
          let finalWindowId = chromeTab.windowId

          if (!inPlace) {
            const targetWindowId = await this.resolveAdoptionWindow(group, sourceTab)
            if (targetWindowId !== undefined && chromeTab.windowId !== targetWindowId) {
              this.internalMoves.register(options.chromeTabId, {
                expectedChromeGroupId: TAB_ID_NONE,
                windowId: targetWindowId,
              })
              await chrome.tabs
                .move(options.chromeTabId, { windowId: targetWindowId, index: -1 })
                .catch((error: unknown) => {
                  this.deps.logger.warn(
                    `Failed to move inherited tab ${options.chromeTabId} to the group window:`,
                    error,
                  )
                })
              const afterMove = await chrome.tabs.get(options.chromeTabId).catch(() => {
                return null
              })
              if (afterMove?.windowId !== undefined) {
                finalWindowId = afterMove.windowId
              } else if (targetWindowId !== undefined) {
                finalWindowId = targetWindowId
              }
            }
          }

          const sourceStillOwned = this.findManagedTabByChromeTabId(options.sourceChromeTabId)
          if (!sourceStillOwned || sourceStillOwned.state !== 'ready') return

          const chromeGroupId = inPlace
            ? undefined
            : await this.ensureTabInManagedGroup({
                chromeTabId: options.chromeTabId,
                group,
                windowId: finalWindowId,
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
              origin: inPlace ? 'existing' : 'task',
              sourceTabId: sourceTab.tabId,
            })
          })
          if (chromeGroupId !== undefined) {
            this.mutate((registry) => {
              return setGroupChromeBindingMissing(registry, {
                groupId: group.groupId,
                chromeGroupId,
                windowId: finalWindowId,
              })
            })
          }
          await this.persist()

          const sourceAfterPersist = this.findManagedTabByChromeTabId(options.sourceChromeTabId)
          if (!sourceAfterPersist || sourceAfterPersist.state !== 'ready') {
            await this.dropAdoptedTab({ tabId, chromeTabId: options.chromeTabId, chromeGroupId })
            return
          }

          try {
            const attached = await this.deps.attachTab(options.chromeTabId)
            this.mutate((registry) => {
              return setTabAttachment(registry, {
                tabId,
                targetId: attached.targetInfo.targetId,
                cdpSessionId: attached.sessionId,
              })
            })
            this.deps.logger.debug(
              `Adopted inherited tab ${options.chromeTabId} into managed group ${group.groupId} (source=${options.sourceChromeTabId})`,
            )
            await this.persist()
            await this.publishInventory()
          } catch (error: unknown) {
            // Attach failed: never keep a grouped-but-uncontrolled claim on the
            // user's tab. Tombstone the record and ungroup it, leaving it open.
            await this.dropAdoptedTab({ tabId, chromeTabId: options.chromeTabId, chromeGroupId })
            throw error
          }
        })
      } finally {
        this.pendingAdoptions.delete(options.chromeTabId)
        this.adoptingChromeTabIds.delete(options.chromeTabId)
      }
    } catch (error: unknown) {
      this.deps.logger.warn(`Failed to adopt inherited tab ${options.chromeTabId}:`, error)
    }
  }

  private async dropAdoptedTab(options: {
    tabId: string
    chromeTabId: number
    chromeGroupId?: number
  }): Promise<void> {
    const stillOurs = this.findManagedTabByChromeTabId(options.chromeTabId)
    if (stillOurs && stillOurs.tabId === options.tabId) {
      const releasedTabId = options.tabId
      this.mutate((registry) => {
        return releaseTab(registry, releasedTabId)
      })
    }
    if (options.chromeGroupId !== undefined) {
      const chromeTab = await chrome.tabs.get(options.chromeTabId).catch(() => {
        return null
      })
      if (chromeTab && chromeTab.groupId === options.chromeGroupId) {
        this.internalMoves.register(options.chromeTabId, { expectedChromeGroupId: TAB_ID_NONE })
        await chrome.tabs.ungroup(options.chromeTabId).catch((error: unknown) => {
          this.deps.logger.debug(`Failed to ungroup dropped adopted tab ${options.chromeTabId}:`, error)
        })
      }
    }
    await this.persist()
    await this.publishInventory()
  }

  private async resolveAdoptionWindow(group: BrowserGroup, sourceTab: BrowserTab): Promise<number | undefined> {
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
    const sourceChromeTab = await chrome.tabs.get(sourceTab.chromeTabId).catch(() => {
      return null
    })
    return sourceChromeTab?.windowId
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
    if (!this.isAvailable()) return
    const tab = this.findManagedTabByChromeTabId(chromeTabId)
    if (!tab) return
    await this.releaseManagedTab({ tabId: tab.tabId, reason, ungroup: true })
  }

  /**
   * Releases every managed tab without touching the Chrome side beyond detaching
   * (explicit disconnect-everything, not a transport drop). Group layout is kept.
   */
  async releaseAllChromeTabs(reason: string): Promise<void> {
    try {
      await this.initialize()
      if (!this.isAvailable()) return
      const tabs = this.getRegistry().tabs.filter((tab) => {
        return (
          tab.browserEpoch === this.browserEpoch &&
          tab.state !== 'released' &&
          tab.state !== 'needs-rebind' &&
          !this.pendingAdoptions.has(tab.chromeTabId)
        )
      })
      for (const tab of tabs) {
        await this.releaseManagedTab({ tabId: tab.tabId, reason, ungroup: false })
      }
    } catch (error: unknown) {
      this.deps.logger.error('Failed to release all managed tabs:', error)
    }
  }
}

function setGroupChromeBindingMissing(
  registry: ManagedResourceRegistry,
  options: { groupId: string; chromeGroupId: number; windowId: number },
): ManagedResourceRegistry {
  const group = findGroup(registry, options.groupId)
  if (group?.chromeGroupId !== undefined) return registry
  return setGroupChromeBinding(registry, options)
}
