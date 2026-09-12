import {
  BROWSER_PROTOCOL_VERSION,
  BROWSER_RUNTIME_PORT,
  buildFirefoxTabCandidateId,
  parseBrowserTabCandidateId,
} from 'playwriter/src/browser-protocol'
import type {
  BrowserDomCommand,
  BrowserDomLocator,
  BrowserDomRequest,
  BrowserGroup,
  BrowserRequest,
  BrowserResponse,
  BrowserResultData,
  BrowserTab,
  BrowserTabCandidate,
} from 'playwriter/src/browser-protocol'
import { parseBrowserDomRequest } from 'playwriter/src/browser-dom-validation'
import { getFirefoxApi } from './firefox-api'
import type { FirefoxApi, FirefoxTab } from './firefox-api'
import { keepFirefoxBackgroundActive } from './firefox-keepalive'
import { KeyedSerialQueue } from './keyed-queue'
import { FirefoxNetwork } from './firefox-network'
import { parseFirefoxBrowserRequest } from './firefox-request-validation'
import {
  FIREFOX_CAPABILITIES,
  FirefoxResourceError,
  activeFirefoxTab,
  emptyFirefoxRegistry,
  firefoxFailure,
  firefoxId,
  firefoxInventory,
  firefoxPageSupported,
  firefoxRequestFingerprint,
  firefoxScreenshotCleanupRequest,
  isFirefoxRecord,
  ownedFirefoxTab,
  parseFirefoxRegistry,
  reconcileFirefoxRegistry,
  releaseFirefoxTabs,
} from './firefox-resources'
import type { FirefoxRegistry } from './firefox-resources'

const STORAGE_KEY = 'piFirefoxRegistry'
const PROFILE_KEY = 'piFirefoxProfileId'
const EPOCH_KEY = 'piFirefoxBrowserEpoch'
const LEDGER_LIMIT = 200
const MAX_RESPONSE_BYTES = 65536
declare const process: { env: { PI_BROWSER_HOST?: string; PI_BROWSER_PORT?: string } }
const RAW_HOST = process.env.PI_BROWSER_HOST || '127.0.0.1'
const HOST = RAW_HOST === '::1' ? '[::1]' : RAW_HOST
const PORT = Number(process.env.PI_BROWSER_PORT) || BROWSER_RUNTIME_PORT
const REQUEST_TIMEOUT = 30000
const DOM_TIMEOUT = 5000
const RECONNECT_ALARM = 'pi-firefox-runtime-reconnect'

interface FirefoxDomGlobal {
  __piFirefoxDom?: {
    run(
      request: BrowserDomRequest,
      evaluator?: undefined,
      frameIdForElement?: (element: Element) => number,
    ): Promise<BrowserResponse>
    cancel(requestId: string): void
  }
}

interface RequestContext {
  requestId: string
  sessionId: string
  cancelled: boolean
  timedOut: boolean
  started: boolean
  browserTabId?: number
  tabId?: string
  frameId?: number
}

interface FrameAncestor {
  parentFrameId: number
  childFrameId: number
  locator: BrowserDomLocator
}

const FRAME_ACTIONS = new Set([
  'click',
  'dblclick',
  'fill',
  'type',
  'press',
  'check',
  'uncheck',
  'setChecked',
  'selectOption',
  'hover',
])

interface ActiveRequest {
  context: RequestContext
  fingerprint: string
  promise: Promise<BrowserResponse>
}

class FirefoxBackground {
  private readonly api: FirefoxApi
  private registry!: FirefoxRegistry
  private readonly queue = new KeyedSerialQueue()
  private readonly active = new Map<string, ActiveRequest>()
  private readonly revoked = new Set<number>()
  private readonly network: FirefoxNetwork
  private readonly initialized: Promise<void>
  private socket: WebSocket | null = null
  private unavailable?: string
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private connecting = false
  private capabilities = FIREFOX_CAPABILITIES
  private browserName = 'Firefox'
  private token?: string

  constructor(api: FirefoxApi) {
    this.api = api
    this.network = new FirefoxNetwork({
      api,
      lookup: (browserTabId) => {
        return this.registry && !this.revoked.has(browserTabId)
          ? activeFirefoxTab({ registry: this.registry, browserTabId })
          : undefined
      },
    })
    this.bindEvents()
    this.initialized = this.initialize()
  }

  private async initialize(): Promise<void> {
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(HOST) || !Number.isSafeInteger(PORT) || PORT < 1 || PORT > 65535)
      throw new Error('Firefox runtime endpoint must be a valid loopback host and port')
    const profileStored = await this.api.storage.local.get(PROFILE_KEY)
    const profileId =
      typeof profileStored[PROFILE_KEY] === 'string' && profileStored[PROFILE_KEY]
        ? String(profileStored[PROFILE_KEY])
        : firefoxId('profile')
    await this.api.storage.local.set({ [PROFILE_KEY]: profileId })
    const epochStored = await this.api.storage.session.get(EPOCH_KEY)
    const browserEpoch =
      typeof epochStored[EPOCH_KEY] === 'string' && epochStored[EPOCH_KEY]
        ? String(epochStored[EPOCH_KEY])
        : firefoxId('epoch')
    await this.api.storage.session.set({ [EPOCH_KEY]: browserEpoch })
    const stored = await this.api.storage.local.get(STORAGE_KEY)
    const registry =
      stored[STORAGE_KEY] === undefined
        ? emptyFirefoxRegistry({ profileId, browserEpoch })
        : parseFirefoxRegistry(stored[STORAGE_KEY])
    if (!registry || registry.profileId !== profileId)
      throw new Error('Persisted Firefox ownership is malformed; refusing to overwrite it')
    this.registry = registry
    await this.commit(reconcileFirefoxRegistry({ registry, browserEpoch, observedTabs: await this.api.tabs.query({}) }))
    const tokenStored = await this.api.storage.local.get('piBrowserToken')
    this.token = typeof tokenStored.piBrowserToken === 'string' ? tokenStored.piBrowserToken : undefined
    this.browserName = (await this.api.runtime.getBrowserInfo()).name || 'Firefox'
    await this.updateCapabilities()
    if (!(await this.api.alarms.get(RECONNECT_ALARM))) {
      await this.api.alarms.create(RECONNECT_ALARM, { delayInMinutes: 1, periodInMinutes: 1 })
    }
  }

  async start(): Promise<void> {
    await this.initialized
    await this.connect()
    for (const tab of this.registry.tabs) {
      if (tab.state !== 'ready') continue
      this.event(async () => {
        const current = activeFirefoxTab({ registry: this.registry, browserTabId: tab.browserTabId! })
        if (!current || this.revoked.has(tab.browserTabId!)) return
        await this.badge({ tab: current, controlled: true })
      })
    }
  }

  private bindEvents(): void {
    this.api.permissions.onAdded.addListener(() => {
      this.event(() => {
        return this.updateCapabilities()
      })
    })
    this.api.permissions.onRemoved.addListener(() => {
      this.event(() => {
        return this.updateCapabilities()
      })
    })
    this.api.runtime.onMessage.addListener((message, sender) => {
      if (
        sender.id !== this.api.runtime.id ||
        sender.url !== this.api.runtime.getURL('firefox-popup.html') ||
        !isFirefoxRecord(message) ||
        message.type !== 'piFirefoxReleaseTab' ||
        !Number.isSafeInteger(message.browserTabId) ||
        Number(message.browserTabId) < 0
      )
        return
      const browserTabId = Number(message.browserTabId)
      this.revoked.add(browserTabId)
      return this.queue.run('resources', async () => {
        try {
          await this.initialized
          const tab = activeFirefoxTab({ registry: this.registry, browserTabId })
          if (!tab) {
            this.revoked.delete(browserTabId)
            return { ok: true, released: false }
          }
          await this.release({ tabs: [tab] })
          return { ok: true, released: true }
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      })
    })
    this.api.tabs.onCreated.addListener((tab) => {
      this.event(() => {
        return this.inheritTab(tab)
      })
    })
    this.api.tabs.onUpdated.addListener((id, change, tab) => {
      if (this.registry) {
        const owned = activeFirefoxTab({ registry: this.registry, browserTabId: id })
        const group = this.registry.groups.find((candidate) => {
          return candidate.groupId === owned?.groupId
        })
        if (
          change.groupId !== undefined &&
          group?.browserGroupId !== undefined &&
          change.groupId !== group.browserGroupId
        )
          this.revoked.add(id)
      }
      this.event(async () => {
        const current = activeFirefoxTab({ registry: this.registry, browserTabId: id })
        if (!current) return
        const group = this.registry.groups.find((candidate) => {
          return candidate.groupId === current.groupId
        })
        if (
          change.groupId !== undefined &&
          group?.browserGroupId !== undefined &&
          change.groupId !== group.browserGroupId
        )
          this.revoked.add(id)
        if (this.revoked.has(id)) {
          await this.release({ tabs: [current] })
          return
        }
        const revision = this.registry.revision + 1
        await this.commit({
          ...this.registry,
          revision,
          tabs: this.registry.tabs.map((candidate) => {
            return candidate.tabId === current.tabId
              ? { ...candidate, url: tab.url ?? '', title: tab.title ?? '', revision }
              : candidate
          }),
        })
        if (change.status === 'complete' && firefoxPageSupported(tab.url))
          await this.inject({ tab: current }).catch((error: unknown) => {
            console.warn('Firefox page instrumentation failed:', String(error))
          })
      })
    })
    this.api.tabs.onRemoved.addListener((id) => {
      this.revoked.add(id)
      this.event(async () => {
        const tab = activeFirefoxTab({ registry: this.registry, browserTabId: id })
        if (tab) await this.release({ tabs: [tab] })
      })
    })
    this.api.action.onClicked.addListener((tab) => {
      const browserTabId = tab.id
      if (browserTabId === undefined) return
      if (this.registry && activeFirefoxTab({ registry: this.registry, browserTabId })) this.revoked.add(browserTabId)
      this.event(async () => {
        const owned = activeFirefoxTab({ registry: this.registry, browserTabId })
        if (!owned) {
          await this.connect()
          return
        }
        this.revoked.add(browserTabId)
        await this.release({ tabs: [owned] })
      })
    })
    this.api.runtime.onStartup.addListener(() => {
      this.wakeConnection()
    })
    this.api.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === RECONNECT_ALARM) this.wakeConnection()
    })
  }

  private wakeConnection(): void {
    void this.initialized
      .then(() => {
        return this.connect()
      })
      .catch((error: unknown) => {
        console.error('Firefox runtime wakeup failed:', error instanceof Error ? error.message : String(error))
      })
  }

  private event(task: () => Promise<void>): void {
    void this.queue
      .run('resources', async () => {
        await this.initialized
        await task()
      })
      .catch((error: unknown) => {
        console.error('Firefox resource event failed:', String(error))
      })
  }

  private async commit(next: FirefoxRegistry): Promise<void> {
    try {
      await this.api.storage.local.set({ [STORAGE_KEY]: next })
    } catch (error) {
      this.unavailable = `Firefox ownership persistence failed: ${String(error)}`
      this.disconnect()
      throw new FirefoxResourceError({ code: 'internal-error', message: this.unavailable, outcome: 'unknown' })
    }
    this.registry = next
    this.publish()
  }

  private publish(): void {
    if (this.socket?.readyState === WebSocket.OPEN && !this.unavailable)
      this.socket.send(
        JSON.stringify({
          method: 'browserInventory',
          params: { ...firefoxInventory(this.registry), capabilities: this.capabilities },
        }),
      )
  }

  private disconnect(): void {
    for (const active of this.active.values()) {
      active.context.cancelled = true
      this.cancelDom(active.context)
    }
    this.network.interrupt()
    const socket = this.socket
    this.socket = null
    socket?.close()
  }

  private async connect(): Promise<void> {
    if (this.unavailable || this.socket || this.connecting) return
    this.connecting = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.token) headers.Authorization = `Bearer ${this.token}`
      const handshake = await fetch(`http://${HOST}:${PORT}/extension/firefox-handshake`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ installId: this.registry.profileId }),
        signal: AbortSignal.timeout(5000),
      })
      if (!handshake.ok)
        throw new Error(
          `Firefox handshake failed (${handshake.status}); check the runtime and piBrowserToken when authentication is configured`,
        )
      const result: unknown = await handshake.json()
      if (
        !isFirefoxRecord(result) ||
        typeof result.ticket !== 'string' ||
        !result.ticket ||
        result.ticket.length > 4096
      )
        throw new Error('Firefox handshake returned an invalid ticket')
      const url = new URL(`ws://${HOST}:${PORT}/extension`)
      url.searchParams.set('backend', 'webextension')
      url.searchParams.set('ticket', result.ticket)
      url.searchParams.set('installId', this.registry.profileId)
      url.searchParams.set('browser', this.browserName)
      url.searchParams.set('v', this.api.runtime.getManifest().version)
      const socket = new WebSocket(url)
      this.socket = socket
      const connectTimer = setTimeout(() => {
        if (socket.readyState !== WebSocket.OPEN) socket.close()
      }, 5000)
      socket.onopen = () => {
        clearTimeout(connectTimer)
        if (this.socket !== socket) return
        this.publish()
      }
      socket.onmessage = (event: MessageEvent<unknown>) => {
        void this.receive({ socket, data: event.data })
      }
      socket.onclose = () => {
        clearTimeout(connectTimer)
        if (this.socket !== socket) return
        this.disconnect()
        this.reconnectTimer = setTimeout(() => {
          void this.connect()
        }, 3000)
      }
      socket.onerror = () => {
        socket.close()
      }
    } catch (error) {
      console.debug('Firefox runtime connection unavailable:', error instanceof Error ? error.message : String(error))
      this.reconnectTimer = setTimeout(() => {
        void this.connect()
      }, 3000)
    } finally {
      this.connecting = false
    }
  }

  private async updateCapabilities(): Promise<void> {
    let available = false
    try {
      available =
        (await this.api.permissions.contains({ permissions: ['userScripts'] })) &&
        typeof this.api.userScripts?.execute === 'function'
    } catch {
      /* Optional API is absent on older Firefox. */
    }
    this.capabilities = {
      ...FIREFOX_CAPABILITIES,
      limitations: [
        ...(FIREFOX_CAPABILITIES.limitations ?? []),
        available
          ? 'Evaluate uses a USER_SCRIPT sandbox without extension APIs.'
          : 'Evaluate requires Firefox 153+ and optional userScripts permission from the extension popup; other tools are available.',
      ],
    }
    this.publish()
  }

  private async receive(options: { socket: WebSocket; data: unknown }): Promise<void> {
    if (options.socket !== this.socket || typeof options.data !== 'string' || options.data.length > 2 * 1024 * 1024)
      return
    let message: unknown
    try {
      message = JSON.parse(options.data)
    } catch {
      return
    }
    if (!isFirefoxRecord(message)) return
    if (message.method === 'ping') {
      void keepFirefoxBackgroundActive(this.api)
      if (options.socket === this.socket && options.socket.readyState === WebSocket.OPEN)
        options.socket.send(JSON.stringify({ method: 'pong' }))
      return
    }
    if (!Number.isSafeInteger(message.id) || Number(message.id) < 0) return
    let response: BrowserResponse
    if (message.method === 'browserRequest') {
      const request = parseFirefoxBrowserRequest(message.params)
      response = request
        ? await this.handle(request)
        : firefoxFailure({
            requestId: this.rawRequestId(message.params),
            error: new FirefoxResourceError({ code: 'invalid-request', message: 'Malformed Firefox browser request' }),
          })
    } else if (message.method === 'browserDomRequest') {
      const request = parseBrowserDomRequest(message.params)
      response = request
        ? await this.handleDom(request)
        : firefoxFailure({
            requestId: this.rawRequestId(message.params),
            error: new FirefoxResourceError({ code: 'invalid-request', message: 'Malformed Firefox DOM request' }),
          })
    } else {
      options.socket.send(
        JSON.stringify({ id: message.id, error: 'Firefox ordinary extension does not implement CDP commands' }),
      )
      return
    }
    if (this.socket === options.socket && options.socket.readyState === WebSocket.OPEN)
      options.socket.send(JSON.stringify({ id: message.id, result: response }))
  }

  private rawRequestId(raw: unknown): string {
    return isFirefoxRecord(raw) && typeof raw.requestId === 'string' ? raw.requestId.slice(0, 256) : 'invalid-request'
  }

  private key(options: { sessionId: string; requestId: string }): string {
    return `${options.sessionId}\0${options.requestId}`
  }

  private assertContinue(context: RequestContext): void {
    if (this.unavailable) throw new FirefoxResourceError({ code: 'internal-error', message: this.unavailable })
    if (context.cancelled)
      throw new FirefoxResourceError({
        code: context.timedOut ? 'timeout' : 'cancelled',
        message: context.timedOut ? 'Firefox operation timed out' : 'Firefox operation was cancelled',
        outcome: context.started ? 'unknown' : 'not-started',
      })
    if (context.browserTabId !== undefined && this.revoked.has(context.browserTabId))
      throw new FirefoxResourceError({
        code: 'resource-released',
        message: 'The user released or closed this tab',
        outcome: context.started ? 'unknown' : 'not-started',
      })
  }

  private cancelDom(context: RequestContext): void {
    if (context.browserTabId === undefined) return
    void this.api.scripting
      .executeScript({
        target: { tabId: context.browserTabId, frameIds: [context.frameId ?? 0] },
        func: (requestId: string) => {
          ;(globalThis as FirefoxDomGlobal).__piFirefoxDom?.cancel(requestId)
        },
        args: [context.requestId],
        injectImmediately: true,
      })
      .catch(() => {})
    try {
      if (context.tabId && this.api.userScripts?.execute)
        void this.api.userScripts
          .execute({
            target: { tabId: context.browserTabId, frameIds: [context.frameId ?? 0] },
            world: 'USER_SCRIPT',
            worldId: `pi-browser-evaluate-${context.tabId}`,
            injectImmediately: true,
            js: [{ code: `globalThis.__piFirefoxDom?.cancel(${JSON.stringify(context.requestId)})` }],
          })
          .catch(() => {})
    } catch {
      /* Optional userScripts permission is not granted. */
    }
  }

  private runTracked(options: {
    request: BrowserRequest | BrowserDomRequest
    action: (context: RequestContext) => Promise<BrowserResultData>
  }): Promise<BrowserResponse> {
    const { request } = options
    const fingerprint = firefoxRequestFingerprint(request)
    const key = this.key(request)
    const active = this.active.get(key)
    if (active)
      return active.fingerprint === fingerprint
        ? active.promise
        : Promise.resolve(
            firefoxFailure({
              requestId: request.requestId,
              error: new FirefoxResourceError({
                code: 'invalid-request',
                message: 'requestId was reused with a different payload',
              }),
            }),
          )
    const context: RequestContext = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      cancelled: false,
      timedOut: false,
      started: false,
    }
    const timeout = setTimeout(
      () => {
        context.cancelled = true
        context.timedOut = true
        this.cancelDom(context)
      },
      Math.min(request.timeoutMs ?? REQUEST_TIMEOUT, 300000),
    )
    const promise = this.queue
      .run('resources', async (): Promise<BrowserResponse> => {
        let response: BrowserResponse
        let recorded = false
        try {
          this.assertContinue(context)
          const entry = this.registry.ledger.find((candidate) => {
            return candidate.requestId === request.requestId && candidate.sessionId === request.sessionId
          })
          if (entry) {
            if (entry.fingerprint !== fingerprint)
              throw new FirefoxResourceError({
                code: 'invalid-request',
                message: 'requestId was reused with a different payload',
              })
            if (entry.response) return entry.response
            throw new FirefoxResourceError({
              code: 'outcome-unknown',
              message: 'This request was already started; it will not be replayed',
              outcome: 'unknown',
            })
          }
          const ledger = this.registry.ledger.slice(-(LEDGER_LIMIT - 1))
          ledger.push({
            requestId: request.requestId,
            sessionId: request.sessionId,
            fingerprint,
            phase: 'pending',
            createdAt: Date.now(),
          })
          await this.commit({ ...this.registry, ledger })
          recorded = true
          this.assertContinue(context)
          const data = await options.action(context)
          this.assertContinue(context)
          response = { requestId: request.requestId, ok: true, data }
        } catch (error) {
          if (error instanceof FirefoxResourceError && error.code === 'timeout') {
            context.cancelled = true
            context.timedOut = true
            this.cancelDom(context)
          }
          response = firefoxFailure({
            requestId: request.requestId,
            error,
            outcome: context.started ? 'unknown' : 'not-started',
          })
        }
        if (!this.unavailable && recorded) {
          const retained =
            JSON.stringify(response).length <= MAX_RESPONSE_BYTES
              ? response
              : firefoxFailure({
                  requestId: request.requestId,
                  error: new FirefoxResourceError({
                    code: 'outcome-unknown',
                    message:
                      'Request already completed; its large result was not retained and the action will not be replayed',
                    outcome: 'unknown',
                  }),
                })
          await this.commit({
            ...this.registry,
            ledger: this.registry.ledger.map((entry) => {
              return entry.requestId === request.requestId && entry.sessionId === request.sessionId
                ? { ...entry, phase: 'completed', response: retained }
                : entry
            }),
          }).catch((error: unknown) => {
            response = firefoxFailure({ requestId: request.requestId, error, outcome: 'unknown' })
          })
        }
        return response
      })
      .finally(() => {
        clearTimeout(timeout)
        this.active.delete(key)
      })
    this.active.set(key, { context, fingerprint, promise })
    return promise
  }

  private handle(request: BrowserRequest): Promise<BrowserResponse> {
    if (request.operation.kind === 'request.cancel') {
      const active = this.active.get(
        this.key({ sessionId: request.sessionId, requestId: request.operation.targetRequestId }),
      )
      if (active) {
        active.context.cancelled = true
        this.cancelDom(active.context)
      }
      return Promise.resolve({
        requestId: request.requestId,
        ok: true,
        data: { value: { cancelled: Boolean(active), outcome: active?.context.started ? 'unknown' : 'not-started' } },
      })
    }
    if (request.operation.kind === 'session.release') {
      for (const active of this.active.values()) {
        if (active.context.sessionId === request.sessionId) {
          active.context.cancelled = true
          this.cancelDom(active.context)
        }
      }
    }
    return this.runTracked({
      request,
      action: (context) => {
        return this.operation({ request, context })
      },
    })
  }

  private handleDom(request: BrowserDomRequest): Promise<BrowserResponse> {
    return this.runTracked({
      request,
      action: async (context) => {
        if (request.command.method === 'operation') {
          if (request.command.operation.tabId !== request.tabId)
            throw new FirefoxResourceError({
              code: 'ownership-mismatch',
              message: 'Nested operation tabId does not match its execution lease',
            })
          await this.resolve({
            sessionId: request.sessionId,
            tabId: request.tabId,
            browserEpoch: request.browserEpoch,
            context,
          })
          return this.operation({
            request: {
              requestId: request.requestId,
              sessionId: request.sessionId,
              operation: request.command.operation,
              timeoutMs: request.timeoutMs,
            },
            context,
          })
        }
        const tab = await this.resolve({
          sessionId: request.sessionId,
          tabId: request.tabId,
          browserEpoch: request.browserEpoch,
          context,
        })
        return this.dom({ request, tab, context })
      },
    })
  }

  private group(options: { sessionId: string; groupId: string; allowInactive?: boolean }): BrowserGroup {
    const group = this.registry.groups.find((candidate) => {
      return candidate.groupId === options.groupId
    })
    if (!group)
      throw new FirefoxResourceError({ code: 'resource-not-found', message: `Unknown group ${options.groupId}` })
    if (group.sessionId !== options.sessionId)
      throw new FirefoxResourceError({
        code: 'ownership-mismatch',
        message: 'This group belongs to another Pi session',
      })
    if (group.state === 'released')
      throw new FirefoxResourceError({ code: 'resource-released', message: 'This group was released' })
    if (!options.allowInactive && (group.state !== 'ready' || group.browserEpoch !== this.registry.browserEpoch))
      throw new FirefoxResourceError({
        code: 'needs-rebind',
        message: 'This group belongs to an earlier Firefox run; create a new group',
      })
    return group
  }

  private async resolve(options: {
    sessionId: string
    tabId: string
    browserEpoch?: string
    context: RequestContext
  }): Promise<BrowserTab> {
    this.assertContinue(options.context)
    let tab = ownedFirefoxTab({ registry: this.registry, ...options })
    options.context.browserTabId = tab.browserTabId
    options.context.tabId = tab.tabId
    this.assertContinue(options.context)
    const actual = await this.api.tabs.get(tab.browserTabId!).catch(() => {
      return null
    })
    this.assertContinue(options.context)
    tab = ownedFirefoxTab({ registry: this.registry, ...options })
    const group = this.group({ sessionId: options.sessionId, groupId: tab.groupId })
    if (!actual || (group.browserGroupId !== undefined && actual.groupId !== group.browserGroupId)) {
      await this.release({ tabs: [tab] })
      throw new FirefoxResourceError({
        code: 'resource-released',
        message: 'The Firefox tab was closed or moved out of its managed group',
      })
    }
    if (tab.url !== (actual.url ?? '') || tab.title !== (actual.title ?? '')) {
      const revision = this.registry.revision + 1
      tab = { ...tab, url: actual.url ?? '', title: actual.title ?? '', revision }
      const updated = tab
      await this.commit({
        ...this.registry,
        revision,
        tabs: this.registry.tabs.map((candidate) => {
          return candidate.tabId === updated.tabId ? updated : candidate
        }),
      })
    }
    return tab
  }

  private async operation(options: { request: BrowserRequest; context: RequestContext }): Promise<BrowserResultData> {
    const { request, context } = options
    const op = request.operation
    switch (op.kind) {
      case 'profiles.list':
        return {
          profiles: [
            {
              profileId: this.registry.profileId,
              browser: this.browserName,
              label: this.browserName,
              connected: true,
              browserEpoch: this.registry.browserEpoch,
              capabilities: this.capabilities,
            },
          ],
        }
      case 'groups.list':
        return {
          groups: this.registry.groups.filter((group) => {
            return (
              group.sessionId === request.sessionId &&
              group.state !== 'released' &&
              (!op.profileId || op.profileId === group.profileId)
            )
          }),
        }
      case 'groups.create': {
        if (op.profileId !== this.registry.profileId)
          throw new FirefoxResourceError({
            code: 'ownership-mismatch',
            message: 'This Firefox profile does not match profileId',
          })
        context.started = true
        const group = this.makeGroup({ sessionId: request.sessionId, name: op.name.trim(), origin: 'task' })
        await this.commit({ ...this.registry, revision: group.revision, groups: [...this.registry.groups, group] })
        return { group }
      }
      case 'groups.rename': {
        const group = this.group({ sessionId: request.sessionId, groupId: op.groupId })
        context.started = true
        if (group.browserGroupId !== undefined && this.api.tabGroups)
          await this.api.tabGroups.update(group.browserGroupId, { title: op.name.trim() })
        this.assertContinue(context)
        const renamed = { ...group, name: op.name.trim(), revision: this.registry.revision + 1 }
        await this.commit({
          ...this.registry,
          revision: renamed.revision,
          groups: this.registry.groups.map((candidate) => {
            return candidate.groupId === group.groupId ? renamed : candidate
          }),
        })
        return { group: renamed }
      }
      case 'groups.close': {
        const group = this.group({ sessionId: request.sessionId, groupId: op.groupId, allowInactive: true })
        const tabs = this.registry.tabs.filter((tab) => {
          return tab.groupId === group.groupId && tab.state !== 'released'
        })
        context.started = true
        const physical = tabs.filter((tab) => {
          return (
            tab.state === 'ready' &&
            tab.browserEpoch === this.registry.browserEpoch &&
            !this.revoked.has(tab.browserTabId!)
          )
        })
        for (const tab of physical) {
          this.assertContinue(context)
          const live = await this.resolve({ sessionId: request.sessionId, tabId: tab.tabId, context })
          await this.api.tabs.remove(live.browserTabId!)
          context.browserTabId = undefined
        }
        await this.release({ tabs, groupIds: [group.groupId] })
        return {
          text: 'Group closed',
          group: this.registry.groups.find((candidate) => {
            return candidate.groupId === group.groupId
          }),
        }
      }
      case 'tabs.list': {
        if (op.groupId) this.group({ sessionId: request.sessionId, groupId: op.groupId, allowInactive: true })
        if (op.sourceTabId) {
          const source = this.registry.tabs.find((tab) => {
            return tab.tabId === op.sourceTabId
          })
          if (!source || source.sessionId !== request.sessionId)
            throw new FirefoxResourceError({
              code: 'ownership-mismatch',
              message: 'sourceTabId does not belong to this session',
            })
        }
        return {
          tabs: this.registry.tabs.filter((tab) => {
            return (
              tab.sessionId === request.sessionId &&
              tab.state !== 'released' &&
              (!op.groupId || tab.groupId === op.groupId) &&
              (!op.sourceTabId || tab.sourceTabId === op.sourceTabId)
            )
          }),
        }
      }
      case 'tabs.discover':
        return this.discover({ request, operation: op })
      case 'tabs.attach':
        return this.attach({ request, candidateId: op.candidateId, context })
      case 'tabs.create': {
        const group = this.group({ sessionId: request.sessionId, groupId: op.groupId })
        this.requirePage(op.url)
        context.started = true
        const actual = await this.api.tabs.create({
          url: op.url,
          active: false,
          ...(group.windowId !== undefined ? { windowId: group.windowId } : {}),
        })
        if (actual.id === undefined) throw new Error('Firefox did not return the created tab ID')
        // Persist the exact physical result even if cancellation arrived during create.
        let tab = this.makeTab({ actual, group, origin: 'task' })
        await this.commit({ ...this.registry, revision: tab.revision, tabs: [...this.registry.tabs, tab] })
        this.assertContinue(context)
        tab = await this.bindTaskGroup({ tab, group, context })
        await this.badge({ tab, controlled: true })
        if (actual.status === 'complete') await this.inject({ tab })
        return { tab }
      }
      case 'session.release': {
        // A Pi disconnect releases execution/capture state, preserving durable ownership.
        const tabs = this.registry.tabs.filter((tab) => {
          return tab.sessionId === request.sessionId && tab.state === 'ready'
        })
        for (const tab of tabs) {
          this.network.stopTab({ tabId: tab.tabId, reason: 'Pi session execution was released' })
          await this.invalidate(tab)
        }
        return { text: 'Firefox execution state released; owned groups and tabs remain available' }
      }
      case 'request.cancel':
        return { text: 'No active request' }
      default:
        break
    }
    if (op.kind === 'tabs.release' || op.kind === 'tabs.close') {
      const tab = this.registry.tabs.find((candidate) => {
        return candidate.tabId === op.tabId
      })
      if (!tab) throw new FirefoxResourceError({ code: 'resource-not-found', message: 'Unknown tab' })
      if (tab.sessionId !== request.sessionId)
        throw new FirefoxResourceError({ code: 'ownership-mismatch', message: 'This tab belongs to another session' })
      if (tab.state === 'released') return { tab }
      context.started = true
      if (
        op.kind === 'tabs.close' &&
        tab.state === 'ready' &&
        tab.browserEpoch === this.registry.browserEpoch &&
        !this.revoked.has(tab.browserTabId!)
      ) {
        const live = await this.resolve({ sessionId: request.sessionId, tabId: tab.tabId, context })
        await this.api.tabs.remove(live.browserTabId!)
        context.browserTabId = undefined
      }
      await this.release({ tabs: [tab] })
      return {
        tab: this.registry.tabs.find((candidate) => {
          return candidate.tabId === tab.tabId
        }),
      }
    }
    if (!('tabId' in op))
      throw new FirefoxResourceError({
        code: 'invalid-request',
        message: 'A page operation requires an explicit tabId',
      })
    const tab = await this.resolve({ sessionId: request.sessionId, tabId: op.tabId, context })
    if (op.kind === 'tab.resolve') return { tab }
    if (op.kind === 'tabs.activate') {
      context.started = true
      const actual = await this.api.tabs.update(tab.browserTabId!, { active: true })
      this.assertContinue(context)
      await this.api.windows.update(actual.windowId, { focused: true })
      return { tab, pageInfo: { tabId: tab.tabId, url: actual.url ?? tab.url, title: actual.title } }
    }
    if (op.kind === 'page.navigate' || op.kind === 'page.back') {
      if (op.kind === 'page.navigate') this.requirePage(op.url)
      else this.requirePage(tab.url)
      context.started = true
      await this.invalidate(tab)
      this.assertContinue(context)
      if (op.kind === 'page.navigate') await this.api.tabs.update(tab.browserTabId!, { url: op.url })
      else await this.api.tabs.goBack(tab.browserTabId!)
      const actual = await this.waitNavigation({ tab, context })
      return {
        text: op.kind === 'page.navigate' ? 'Navigated' : 'Went back in Firefox history',
        pageInfo: { tabId: tab.tabId, url: actual.url ?? '', title: actual.title },
      }
    }
    if (op.kind === 'page.network') {
      if (op.action !== 'list') context.started = true
      return {
        ...this.network.handle({ tab, action: op.action, filter: op.filter }),
        pageInfo: { tabId: tab.tabId, url: tab.url, title: tab.title },
      }
    }
    if (op.kind === 'page.screenshot')
      return this.screenshot({ request, tab, context, fullPage: op.fullPage, labels: op.labels })
    if (op.kind === 'page.execute')
      throw new FirefoxResourceError({
        code: 'unsupported-capability',
        message: 'Firefox execute must run in the isolated local runtime worker',
      })
    this.requirePage(tab.url)
    let command: BrowserDomCommand
    switch (op.kind) {
      case 'page.snapshot':
        command = {
          method: 'snapshot',
          selector: op.selector,
          search: op.search,
          full: op.full,
          interactiveOnly: op.interactiveOnly,
        }
        break
      case 'page.click':
        command = { method: 'click', selector: op.selector, snapshotId: op.snapshotId }
        break
      case 'page.fill':
        command = { method: 'fill', selector: op.selector, snapshotId: op.snapshotId, value: op.value }
        break
      case 'page.evaluate':
        command = { method: 'evaluate', code: op.code }
        break
      case 'page.logs':
        command = { method: 'logs', limit: op.limit }
        break
      default:
        throw new FirefoxResourceError({
          code: 'unsupported-capability',
          message: 'This Firefox operation is unavailable',
        })
    }
    return this.dom({
      request: {
        requestId: request.requestId,
        sessionId: request.sessionId,
        tabId: tab.tabId,
        browserEpoch: this.registry.browserEpoch,
        command,
        timeoutMs: request.timeoutMs,
      },
      tab,
      context,
    })
  }

  private makeGroup(options: { sessionId: string; name: string; origin: 'task' | 'existing' }): BrowserGroup {
    return {
      groupId: firefoxId('group'),
      sessionId: options.sessionId,
      profileId: this.registry.profileId,
      name: options.name.slice(0, 200) || 'Existing tab',
      state: 'ready',
      browserEpoch: this.registry.browserEpoch,
      revision: this.registry.revision + 1,
      origin: options.origin,
    }
  }

  private makeTab(options: {
    actual: FirefoxTab
    group: BrowserGroup
    origin: 'task' | 'existing'
    sourceTabId?: string
  }): BrowserTab {
    if (options.actual.id === undefined) throw new Error('Firefox tab ID is missing')
    return {
      tabId: firefoxId('tab'),
      groupId: options.group.groupId,
      sessionId: options.group.sessionId,
      profileId: this.registry.profileId,
      url: options.actual.url ?? '',
      title: options.actual.title ?? '',
      state: 'ready',
      browserEpoch: this.registry.browserEpoch,
      revision: this.registry.revision + 1,
      chromeTabId: -1,
      browserTabId: options.actual.id,
      origin: options.origin,
      ...(options.sourceTabId ? { sourceTabId: options.sourceTabId } : {}),
    }
  }

  private requirePage(url: string): void {
    if (!firefoxPageSupported(url))
      throw new FirefoxResourceError({
        code: 'unsupported-capability',
        message:
          'Firefox extensions cannot control this URL. Use an HTTP(S) page outside privileged browser/Mozilla pages; Firefox may restrict additional domains.',
      })
  }

  private async discover(options: {
    request: BrowserRequest
    operation: Extract<BrowserRequest['operation'], { kind: 'tabs.discover' }>
  }): Promise<BrowserResultData> {
    const op = options.operation
    if (op.profileId && op.profileId !== this.registry.profileId) return { candidates: [] }
    const actualTabs = await this.api.tabs.query(op.windowId === undefined ? {} : { windowId: op.windowId })
    const windows = new Map(
      (await this.api.windows.getAll()).map((window) => {
        return [window.id, window]
      }),
    )
    const candidates: BrowserTabCandidate[] = []
    for (const actual of actualTabs) {
      if (actual.id === undefined) continue
      const owner = activeFirefoxTab({ registry: this.registry, browserTabId: actual.id })
      if (op.includeManaged === false && owner) continue
      if (op.query && !`${actual.title ?? ''}\n${actual.url ?? ''}`.toLowerCase().includes(op.query.toLowerCase()))
        continue
      const supported = firefoxPageSupported(actual.url)
      const ours = owner?.sessionId === options.request.sessionId
      candidates.push({
        candidateId: buildFirefoxTabCandidateId({
          profileId: this.registry.profileId,
          browserEpoch: this.registry.browserEpoch,
          browserTabId: actual.id,
        }),
        profileId: this.registry.profileId,
        profileLabel: this.browserName,
        browser: this.browserName,
        browserEpoch: this.registry.browserEpoch,
        windowId: actual.windowId,
        active: actual.active,
        windowFocused: windows.get(actual.windowId)?.focused ?? false,
        chromeTabId: -1,
        browserTabId: actual.id,
        backend: 'webextension',
        url: actual.url ?? '',
        title: actual.title ?? '',
        managed: Boolean(owner),
        ownedByThisSession: ours,
        ...(ours ? { tabId: owner.tabId } : {}),
        attachable: supported && (!owner || ours),
        ...(!supported
          ? { reason: 'restricted-url' as const }
          : owner && !ours
            ? { reason: 'owned-by-other-session' as const }
            : {}),
      })
    }
    return { candidates }
  }

  private async attach(options: {
    request: BrowserRequest
    candidateId: string
    context: RequestContext
  }): Promise<BrowserResultData> {
    const candidate = parseBrowserTabCandidateId(options.candidateId)
    if (!candidate || candidate.backend !== 'webextension')
      throw new FirefoxResourceError({
        code: 'invalid-request',
        message: 'Run tabs.discover to obtain a Firefox candidateId',
      })
    if (candidate.profileId !== this.registry.profileId)
      throw new FirefoxResourceError({
        code: 'ownership-mismatch',
        message: 'This candidate belongs to another Firefox profile',
      })
    if (candidate.browserEpoch !== this.registry.browserEpoch)
      throw new FirefoxResourceError({
        code: 'needs-rebind',
        message: 'This candidate is from an earlier Firefox run; discover again',
      })
    this.assertContinue(options.context)
    const actual = await this.api.tabs.get(candidate.browserTabId)
    this.requirePage(actual.url ?? '')
    const owner = activeFirefoxTab({ registry: this.registry, browserTabId: candidate.browserTabId })
    if (owner) {
      if (owner.sessionId !== options.request.sessionId)
        throw new FirefoxResourceError({
          code: 'ownership-mismatch',
          message: 'This Firefox tab is controlled by another Pi session',
        })
      return {
        tab: await this.resolve({ sessionId: options.request.sessionId, tabId: owner.tabId, context: options.context }),
      }
    }
    this.assertContinue(options.context)
    options.context.started = true
    // Injection is the capability probe. It does not navigate, scroll or regroup.
    await this.browserDeadline(
      this.api.scripting.executeScript({
        target: { tabId: candidate.browserTabId },
        files: ['firefox-dom.js'],
        injectImmediately: true,
      }),
    )
    this.assertContinue(options.context)
    const group = this.makeGroup({
      sessionId: options.request.sessionId,
      name: actual.title || 'Existing Firefox tab',
      origin: 'existing',
    })
    const tab = this.makeTab({ actual, group, origin: 'existing' })
    this.revoked.delete(candidate.browserTabId)
    await this.commit({
      ...this.registry,
      revision: tab.revision,
      groups: [...this.registry.groups, group],
      tabs: [...this.registry.tabs, tab],
    })
    await this.badge({ tab, controlled: true })
    return { group, tab, pageInfo: { tabId: tab.tabId, url: tab.url, title: tab.title } }
  }

  private async bindTaskGroup(options: {
    tab: BrowserTab
    group: BrowserGroup
    context?: RequestContext
  }): Promise<BrowserTab> {
    const { tab, group } = options
    if (!this.api.tabs.group || !this.api.tabGroups || group.origin === 'existing') return tab
    if (options.context) this.assertContinue(options.context)
    const browserGroupId = await this.api.tabs.group({
      tabIds: [tab.browserTabId!],
      ...(group.browserGroupId !== undefined ? { groupId: group.browserGroupId } : {}),
    })
    const actual = await this.api.tabs.get(tab.browserTabId!)
    const revision = this.registry.revision + 1
    await this.commit({
      ...this.registry,
      revision,
      groups: this.registry.groups.map((candidate) => {
        return candidate.groupId === group.groupId
          ? { ...candidate, browserGroupId, windowId: actual.windowId, revision }
          : candidate
      }),
    })
    if (options.context) this.assertContinue(options.context)
    await this.api.tabGroups.update(browserGroupId, { title: group.name })
    return tab
  }

  private async inheritTab(actual: FirefoxTab): Promise<void> {
    if (actual.id === undefined || actual.openerTabId === undefined || this.revoked.has(actual.openerTabId)) return
    const source = activeFirefoxTab({ registry: this.registry, browserTabId: actual.openerTabId })
    if (!source || source.state !== 'ready' || activeFirefoxTab({ registry: this.registry, browserTabId: actual.id }))
      return
    // Released physical IDs cannot be automatically re-adopted in this browser run.
    if (
      this.registry.tabs.some((tab) => {
        return (
          tab.browserTabId === actual.id && tab.browserEpoch === this.registry.browserEpoch && tab.state === 'released'
        )
      })
    )
      return
    const group = this.group({ sessionId: source.sessionId, groupId: source.groupId })
    const tab = this.makeTab({ actual, group, origin: source.origin ?? 'task', sourceTabId: source.tabId })
    await this.commit({ ...this.registry, revision: tab.revision, tabs: [...this.registry.tabs, tab] })
    await this.bindTaskGroup({ tab, group })
    await this.badge({ tab, controlled: true })
    if (firefoxPageSupported(actual.url)) await this.inject({ tab })
  }

  private async badge(options: { tab: BrowserTab; controlled: boolean }): Promise<void> {
    if (options.tab.browserTabId === undefined) return
    await Promise.allSettled([
      this.api.action.setBadgeText({ tabId: options.tab.browserTabId, text: options.controlled ? 'Pi' : '' }),
      this.api.action.setTitle({
        tabId: options.tab.browserTabId,
        title: options.controlled ? 'Pi Browser Use: click to release this tab' : 'Pi Browser Use for Firefox',
      }),
    ])
  }

  private async release(options: { tabs: BrowserTab[]; groupIds?: string[] }): Promise<void> {
    for (const tab of options.tabs) {
      if (tab.browserEpoch === this.registry.browserEpoch && tab.browserTabId !== undefined)
        this.revoked.add(tab.browserTabId)
    }
    await this.commit(
      releaseFirefoxTabs({
        registry: this.registry,
        tabIds: options.tabs.map((tab) => {
          return tab.tabId
        }),
        groupIds: options.groupIds,
      }),
    )
    for (const tab of options.tabs) {
      this.network.stopTab({ tabId: tab.tabId, release: true })
      if (tab.browserEpoch !== this.registry.browserEpoch || tab.state === 'needs-rebind') continue
      for (const active of this.active.values()) {
        if (active.context.browserTabId === tab.browserTabId) this.cancelDom(active.context)
      }
      await this.script({
        browserTabId: tab.browserTabId!,
        allFrames: true,
        request: {
          requestId: firefoxId('dispose'),
          sessionId: tab.sessionId,
          tabId: tab.tabId,
          browserEpoch: this.registry.browserEpoch,
          command: { method: 'dispose' },
        },
      }).catch(() => {})
      try {
        if (this.api.userScripts?.execute)
          await this.browserDeadline(
            this.api.userScripts.execute({
              target: { tabId: tab.browserTabId!, allFrames: true },
              world: 'USER_SCRIPT',
              worldId: `pi-browser-evaluate-${tab.tabId}`,
              injectImmediately: true,
              js: [
                {
                  code: `globalThis.__piFirefoxDom?.run(${JSON.stringify({ requestId: firefoxId('dispose'), sessionId: tab.sessionId, tabId: tab.tabId, browserEpoch: this.registry.browserEpoch, command: { method: 'dispose' } })})`,
                },
              ],
            }),
          ).catch(() => {})
      } catch {
        /* Optional userScripts permission is absent. */
      }
      await this.badge({ tab, controlled: false })
    }
  }

  private async inject(options: { tab: BrowserTab; frameId?: number }): Promise<void> {
    await this.browserDeadline(
      this.api.scripting.executeScript({
        target: { tabId: options.tab.browserTabId!, frameIds: [options.frameId ?? 0] },
        files: ['firefox-dom.js'],
        injectImmediately: true,
      }),
    )
  }

  private async invalidate(tab: BrowserTab): Promise<void> {
    await this.script({
      browserTabId: tab.browserTabId!,
      allFrames: true,
      request: {
        requestId: firefoxId('invalidate'),
        sessionId: tab.sessionId,
        tabId: tab.tabId,
        browserEpoch: this.registry.browserEpoch,
        command: { method: 'invalidate' },
      },
    }).catch(() => {})
  }

  private async dom(options: {
    request: BrowserDomRequest
    tab: BrowserTab
    context: RequestContext
  }): Promise<BrowserResultData> {
    const { request, context } = options
    const tab = await this.resolve({
      sessionId: request.sessionId,
      tabId: request.tabId,
      browserEpoch: request.browserEpoch,
      context,
    })
    this.requirePage(tab.url)
    await this.inject({ tab })
    this.assertContinue(context)
    const routed = await this.routeFrame({ request, tab, context })
    let command = routed.request.command
    if (routed.ancestors.length > 0 && command.method === 'locator' && FRAME_ACTIONS.has(command.action)) {
      command = await this.prepareFrameAction({ ...routed, command, tab, context })
    }
    context.frameId = routed.frameId
    if (
      !['snapshot', 'page', 'logs', 'screenshot.prepare', 'screenshot.cleanup', 'invalidate', 'dispose'].includes(
        command.method,
      ) &&
      !(
        command.method === 'locator' &&
        [
          'count',
          'textContent',
          'innerText',
          'innerHTML',
          'inputValue',
          'getAttribute',
          'allTextContents',
          'allInnerTexts',
          'isVisible',
          'isHidden',
          'isEnabled',
          'isDisabled',
          'isEditable',
          'isChecked',
          'boundingBox',
          'waitFor',
        ].includes(command.action)
      )
    )
      context.started = true
    const boundedRequest = {
      ...routed.request,
      command,
      timeoutMs: Math.min(request.timeoutMs ?? DOM_TIMEOUT, DOM_TIMEOUT),
    }
    const values = await this.bounded({
      context,
      timeoutMs: boundedRequest.timeoutMs,
      promise:
        command.method === 'evaluate'
          ? this.evaluate({ tab, request: boundedRequest, context, frameId: routed.frameId })
          : this.script({ browserTabId: tab.browserTabId!, request: boundedRequest, frameId: routed.frameId }),
    })
    this.assertContinue(context)
    ownedFirefoxTab({
      registry: this.registry,
      sessionId: request.sessionId,
      tabId: request.tabId,
      browserEpoch: request.browserEpoch,
    })
    const result = values[0]
    if (!isFirefoxRecord(result) || result.requestId !== request.requestId || typeof result.ok !== 'boolean')
      throw new Error('Firefox content script returned an invalid result')
    if (!result.ok) {
      const response = result as unknown as Extract<BrowserResponse, { ok: false }>
      if (!response.error || typeof response.error.message !== 'string')
        throw new Error('Firefox content script returned an invalid error')
      throw new FirefoxResourceError(response.error)
    }
    if (!isFirefoxRecord(result.data)) throw new Error('Firefox content script result has no data')
    const data = result.data as BrowserResultData
    const current = await this.resolve({
      sessionId: request.sessionId,
      tabId: request.tabId,
      browserEpoch: request.browserEpoch,
      context,
    })
    return { ...data, pageInfo: { tabId: current.tabId, url: current.url, title: current.title } }
  }

  private async routeFrame(options: {
    request: BrowserDomRequest
    tab: BrowserTab
    context: RequestContext
  }): Promise<{ request: BrowserDomRequest; frameId: number; ancestors: FrameAncestor[] }> {
    const ancestors: FrameAncestor[] = []
    const command = options.request.command
    let locator: BrowserDomLocator | undefined =
      command.method === 'locator' || command.method === 'evaluate' ? command.locator : undefined
    let frameId = 0
    while (locator) {
      const index = locator.steps.findIndex((step) => {
        return step.kind === 'frame'
      })
      if (index < 0) break
      const frame = locator.steps[index]
      if (frame.kind !== 'frame') throw new Error('Invalid frame locator')
      const prefix: BrowserDomLocator = {
        ...locator,
        steps: [...locator.steps.slice(0, index), { kind: 'selector', engine: 'css', value: frame.selector }],
      }
      options.context.frameId = frameId
      const values = await this.bounded({
        context: options.context,
        timeoutMs: DOM_TIMEOUT,
        promise: this.script({
          browserTabId: options.tab.browserTabId!,
          frameId,
          request: {
            ...options.request,
            command: { method: 'frame.resolve', locator: prefix },
            timeoutMs: DOM_TIMEOUT,
          },
        }),
      })
      this.assertContinue(options.context)
      const response = values[0]
      if (
        !isFirefoxRecord(response) ||
        response.ok !== true ||
        !isFirefoxRecord(response.data) ||
        !isFirefoxRecord(response.data.value) ||
        !Number.isSafeInteger(response.data.value.frameId) ||
        Number(response.data.value.frameId) <= 0
      ) {
        if (
          isFirefoxRecord(response) &&
          response.ok === false &&
          isFirefoxRecord(response.error) &&
          typeof response.error.message === 'string'
        )
          throw new FirefoxResourceError({ code: 'execution-failed', message: response.error.message })
        throw new FirefoxResourceError({
          code: 'execution-failed',
          message: 'Firefox could not resolve a unique live child frame',
        })
      }
      const childFrameId = Number(response.data.value.frameId)
      const actual = await this.api.webNavigation.getFrame({ tabId: options.tab.browserTabId!, frameId: childFrameId })
      this.assertContinue(options.context)
      ownedFirefoxTab({
        registry: this.registry,
        sessionId: options.request.sessionId,
        tabId: options.request.tabId,
        browserEpoch: options.request.browserEpoch,
      })
      if (!actual || actual.parentFrameId !== frameId || actual.errorOccurred)
        throw new FirefoxResourceError({
          code: 'resource-not-found',
          message: 'The selected iframe changed or is no longer part of this tab',
        })
      ancestors.push({ parentFrameId: frameId, childFrameId, locator: prefix })
      frameId = childFrameId
      options.context.frameId = frameId
      await this.inject({ tab: options.tab, frameId })
      locator = { steps: locator.steps.slice(index + 1) }
    }
    if (!locator || (command.method !== 'locator' && command.method !== 'evaluate'))
      return { request: options.request, frameId, ancestors }
    return { request: { ...options.request, command: { ...command, locator } }, frameId, ancestors }
  }

  private async frameCommand(options: {
    request: BrowserDomRequest
    frameId: number
    context: RequestContext
    command: BrowserDomCommand
  }): Promise<BrowserResultData> {
    const tab = ownedFirefoxTab({
      registry: this.registry,
      sessionId: options.request.sessionId,
      tabId: options.request.tabId,
      browserEpoch: options.request.browserEpoch,
    })
    options.context.frameId = options.frameId
    this.assertContinue(options.context)
    const request = { ...options.request, command: options.command, timeoutMs: DOM_TIMEOUT }
    const values = await this.bounded({
      context: options.context,
      timeoutMs: DOM_TIMEOUT,
      promise: this.script({ browserTabId: tab.browserTabId!, frameId: options.frameId, request }),
    })
    this.assertContinue(options.context)
    const response = values[0]
    if (!isFirefoxRecord(response) || response.requestId !== request.requestId || typeof response.ok !== 'boolean')
      throw new Error('Firefox frame command returned an invalid response')
    if (!response.ok) {
      const failed = response as unknown as Extract<BrowserResponse, { ok: false }>
      if (!failed.error || typeof failed.error.message !== 'string')
        throw new Error('Firefox frame command returned an invalid error')
      throw new FirefoxResourceError(failed.error)
    }
    if (!isFirefoxRecord(response.data)) throw new Error('Firefox frame command returned no data')
    return response.data as BrowserResultData
  }

  private async prepareFrameAction(options: {
    request: BrowserDomRequest
    frameId: number
    ancestors: FrameAncestor[]
    command: Extract<BrowserDomCommand, { method: 'locator' }>
    tab: BrowserTab
    context: RequestContext
  }): Promise<Extract<BrowserDomCommand, { method: 'locator' }>> {
    options.context.started = true
    const prepared = await this.frameCommand({
      ...options,
      command: {
        method: 'frame.actionPoint',
        locator: options.command.locator,
        action: options.command.action,
        args: options.command.args,
      },
    })
    const value = prepared.value
    if (
      !isFirefoxRecord(value) ||
      !isFirefoxRecord(value.point) ||
      !Number.isFinite(value.point.x) ||
      !Number.isFinite(value.point.y) ||
      typeof value.preparationId !== 'string' ||
      !value.preparationId
    )
      throw new Error('Firefox could not prepare a stable action point in this child frame')
    const originalPoint = { x: Number(value.point.x), y: Number(value.point.y) }
    let point = originalPoint
    options.context.started = true
    try {
      for (let index = options.ancestors.length - 1; index >= 0; index -= 1) {
        const ancestor = options.ancestors[index]
        const checked = await this.frameCommand({
          ...options,
          frameId: ancestor.parentFrameId,
          command: { method: 'frame.check', locator: ancestor.locator, point },
        })
        const mapped = checked.value
        if (
          !isFirefoxRecord(mapped) ||
          mapped.frameId !== ancestor.childFrameId ||
          !Number.isFinite(mapped.x) ||
          !Number.isFinite(mapped.y)
        )
          throw new FirefoxResourceError({
            code: 'resource-not-found',
            message: 'The ancestor iframe changed during actionability checks',
          })
        const actual = await this.api.webNavigation.getFrame({
          tabId: options.tab.browserTabId!,
          frameId: ancestor.childFrameId,
        })
        this.assertContinue(options.context)
        if (!actual || actual.parentFrameId !== ancestor.parentFrameId || actual.errorOccurred)
          throw new FirefoxResourceError({
            code: 'resource-not-found',
            message: 'The action target is no longer inside the verified ancestor frame',
          })
        point = { x: Number(mapped.x), y: Number(mapped.y) }
      }
    } catch (error) {
      if (error instanceof FirefoxResourceError)
        throw new FirefoxResourceError({ code: error.code, message: error.message, outcome: 'unknown' })
      throw error
    }
    options.context.frameId = options.frameId
    this.assertContinue(options.context)
    return { ...options.command, expectedPoint: originalPoint, preparationId: value.preparationId }
  }

  private async script(options: {
    browserTabId: number
    request: BrowserDomRequest
    frameId?: number
    allFrames?: boolean
  }): Promise<unknown[]> {
    const results = await this.browserDeadline(
      this.api.scripting.executeScript({
        target: {
          tabId: options.browserTabId,
          ...(options.allFrames ? { allFrames: true } : { frameIds: [options.frameId ?? 0] }),
        },
        injectImmediately: true,
        func: (request: BrowserDomRequest) => {
          return (globalThis as FirefoxDomGlobal).__piFirefoxDom?.run(request, undefined, (element) => {
            return (
              globalThis as unknown as { browser: { runtime: { getFrameId(target: Element): number } } }
            ).browser.runtime.getFrameId(element)
          })
        },
        args: [options.request],
      }),
    )
    return results.map((result) => {
      if (result.error) throw new Error(result.error.message)
      return result.result
    })
  }

  private async evaluate(options: {
    tab: BrowserTab
    request: BrowserDomRequest
    context: RequestContext
    frameId: number
  }): Promise<unknown[]> {
    const { request, tab } = options
    if (request.command.method !== 'evaluate') throw new Error('Expected evaluate command')
    if (!(await this.api.permissions.contains({ permissions: ['userScripts'] })) || !this.api.userScripts?.execute)
      throw new FirefoxResourceError({
        code: 'unsupported-capability',
        message:
          'Evaluate requires Firefox 153+ and the optional userScripts permission. Enable it from the Pi Browser Use extension popup; other browser tools remain available.',
      })
    await this.invalidate(tab)
    this.assertContinue(options.context)
    options.context.started = true
    try {
      const results = await this.api.userScripts.execute({
        target: { tabId: tab.browserTabId!, frameIds: [options.frameId] },
        injectImmediately: true,
        world: 'USER_SCRIPT',
        worldId: `pi-browser-evaluate-${tab.tabId}`,
        js: [
          { file: 'firefox-dom.js' },
          {
            code: `globalThis.__piFirefoxDom.run(${JSON.stringify(request)}, async function(element) {${request.command.code}\n}).then((response) => { return JSON.stringify(response) })`,
          },
        ],
      })
      return results.map((result) => {
        if (result.error) throw new Error(result.error)
        if (typeof result.result !== 'string')
          throw new Error('Firefox user-script evaluation did not return serialized JSON')
        return JSON.parse(result.result) as unknown
      })
    } finally {
      await this.invalidate(tab)
    }
  }

  private async browserDeadline<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new FirefoxResourceError({
                code: 'timeout',
                message: 'Firefox did not respond to content-script injection; the tab may be busy',
                outcome: 'unknown',
              }),
            )
          }, DOM_TIMEOUT)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async bounded<T>(options: { promise: Promise<T>; context: RequestContext; timeoutMs: number }): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        options.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            options.context.cancelled = true
            options.context.timedOut = true
            this.cancelDom(options.context)
            reject(
              new FirefoxResourceError({
                code: 'timeout',
                message: 'Firefox did not finish this operation before its deadline',
                outcome: options.context.started ? 'unknown' : 'not-started',
              }),
            )
          }, options.timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async waitNavigation(options: { tab: BrowserTab; context: RequestContext }): Promise<FirefoxTab> {
    const deadline = Date.now() + DOM_TIMEOUT
    let actual = await this.api.tabs.get(options.tab.browserTabId!)
    while (actual.status === 'loading' && Date.now() < deadline) {
      this.assertContinue(options.context)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50)
      })
      actual = await this.api.tabs.get(options.tab.browserTabId!)
    }
    this.assertContinue(options.context)
    if (actual.status === 'loading')
      throw new FirefoxResourceError({
        code: 'timeout',
        message: 'Navigation started, but Firefox has not finished loading',
        outcome: 'unknown',
      })
    if (firefoxPageSupported(actual.url)) await this.inject({ tab: { ...options.tab, url: actual.url ?? '' } })
    return actual
  }

  private async screenshot(options: {
    request: BrowserRequest
    tab: BrowserTab
    context: RequestContext
    fullPage?: boolean
    labels?: boolean
  }): Promise<BrowserResultData> {
    const request: BrowserDomRequest = {
      requestId: options.request.requestId,
      sessionId: options.request.sessionId,
      tabId: options.tab.tabId,
      browserEpoch: this.registry.browserEpoch,
      timeoutMs: options.request.timeoutMs,
      command: { method: 'screenshot.prepare', fullPage: options.fullPage, labels: options.labels },
    }
    this.requirePage(options.tab.url)
    try {
      const prepared = await this.dom({ request, tab: options.tab, context: options.context })
      const metrics = prepared.value
      if (!isFirefoxRecord(metrics)) throw new Error('Firefox screenshot metrics are missing')
      const width = Number(metrics.width)
      const height = Number(metrics.height)
      if (
        options.fullPage &&
        (!Number.isFinite(width) ||
          !Number.isFinite(height) ||
          width <= 0 ||
          height <= 0 ||
          width > 32767 ||
          height > 32767 ||
          width * height > 100000000)
      )
        throw new FirefoxResourceError({
          code: 'unsupported-capability',
          message: 'Full-page screenshot exceeds the supported image dimensions; request a viewport screenshot',
        })
      this.assertContinue(options.context)
      ownedFirefoxTab({
        registry: this.registry,
        sessionId: request.sessionId,
        tabId: request.tabId,
        browserEpoch: request.browserEpoch,
      })
      const dataUrl = await this.bounded({
        context: options.context,
        timeoutMs: DOM_TIMEOUT,
        promise: this.api.tabs.captureTab(options.tab.browserTabId!, {
          format: 'png',
          ...(options.fullPage
            ? { rect: { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height) }, scale: 1 }
            : {}),
        }),
      })
      this.assertContinue(options.context)
      if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Firefox did not return a PNG screenshot')
      return {
        text: prepared.text ?? 'Firefox screenshot captured',
        snapshotId: prepared.snapshotId,
        images: [{ mimeType: 'image/png', data: dataUrl.slice('data:image/png;base64,'.length) }],
        pageInfo: prepared.pageInfo,
      }
    } finally {
      const cleanup = firefoxScreenshotCleanupRequest(request)
      await this.script({ browserTabId: options.tab.browserTabId!, request: cleanup }).catch(() => {})
    }
  }
}

void new FirefoxBackground(getFirefoxApi()).start().catch((error: unknown) => {
  console.error(
    'Pi Browser Use for Firefox failed to initialize:',
    error instanceof Error ? error.message : String(error),
  )
})
