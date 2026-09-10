/**
 * Managed relay tests (owner B).
 *
 * These tests exercise the real HTTP routes and the real websocket protocol:
 * a real relay server is started on a random port, a fake extension peer speaks
 * the legacy /extension protocol (browserInventory + {id, result} envelope) and
 * managed/legacy CDP clients connect to /cdp. No browser is started.
 *
 * The isolated executor (owner C) is replaced through the documented
 * `managedExecutorPoolFactory` test seam so dispatch, serialization, timeout and
 * cancel semantics of the relay can be verified without spawning Chrome. The
 * relay itself is never mocked.
 */
import { afterEach, describe, expect, test } from 'vitest'
import net from 'node:net'
import WebSocket from 'ws'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import {
  MANAGED_REQUEST_BODY_LIMIT_BYTES,
  ManagedRelay,
  applyBrowserInventory,
  createManagedRelayState,
  findManagedGroup,
  findManagedTab,
  listManagedGroups,
  listManagedTabs,
  noteManagedConnectionOpened,
  parseBrowserInventory,
  parseBrowserRequest,
  type ManagedProfileSnapshot,
  type ManagedRelayState,
} from './managed-relay.js'
import {
  buildTabCandidateId,
  type BrowserGroup,
  type BrowserInventory,
  type BrowserRequest,
  type BrowserResponse,
  type BrowserResultData,
  type BrowserTab,
  type BrowserTabCandidate,
  type ManagedExecutorPoolContract,
} from './browser-protocol.js'

const EXTENSION_ORIGIN = 'chrome-extension://pebbngnfojnignonigcnkdilknapkgid'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        resolve(port)
      })
    })
  })
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; message: string },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 3000)
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error(`timed out waiting for ${options.message}`)
}

type HttpResult = { status: number; body: unknown }

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return null
  }
  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('json')) {
    return text
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function getJson({ port, path, token }: { port: number; path: string; token?: string }): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  })
  return { status: response.status, body: await readResponseBody(response) }
}

async function postJson({
  port,
  path,
  body,
  token,
  contentType = 'application/json',
}: {
  port: number
  path: string
  body: unknown
  token?: string
  contentType?: string | null
}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      ...(contentType === null ? {} : { 'content-type': contentType }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: response.status, body: await readResponseBody(response) }
}

async function browserRequest({
  port,
  request,
  token,
}: {
  port: number
  request: BrowserRequest
  token?: string
}): Promise<HttpResult> {
  return await postJson({ port, path: '/browser/v1/request', body: request, token })
}

const nullCdpLogger = {
  log: () => {},
  flush: async () => {},
  logFilePath: '',
}

function makeGroup(overrides: Partial<BrowserGroup> & { groupId: string; sessionId: string }): BrowserGroup {
  return {
    profileId: 'profile-1',
    name: `group ${overrides.groupId}`,
    state: 'ready',
    browserEpoch: 'epoch-1',
    revision: 1,
    chromeGroupId: 100,
    windowId: 10,
    ...overrides,
  }
}

function makeTab(
  overrides: Partial<BrowserTab> & { tabId: string; groupId: string; sessionId: string },
): BrowserTab {
  return {
    profileId: 'profile-1',
    url: 'https://example.com/',
    title: 'Example',
    state: 'ready',
    browserEpoch: 'epoch-1',
    revision: 1,
    chromeTabId: 200,
    targetId: `target-${overrides.tabId}`,
    cdpSessionId: `pw-${overrides.tabId}`,
    ...overrides,
  }
}

function makeInventory({
  profileId = 'profile-1',
  browserEpoch = 'epoch-1',
  revision = 1,
  groups,
  tabs,
}: {
  profileId?: string
  browserEpoch?: string
  revision?: number
  groups: BrowserGroup[]
  tabs: BrowserTab[]
}): BrowserInventory {
  return { protocolVersion: 1, profileId, browserEpoch, revision, groups, tabs }
}

type TestPool = ManagedExecutorPoolContract & {
  executions: Array<{ request: BrowserRequest; tab: BrowserTab; cdpUrl: string; connectionEpoch: string }>
  cancels: Array<{ sessionId: string; requestId: string }>
  releasedSessions: string[]
  disconnectedProfiles: string[]
  hold: boolean
  /** Executions currently parked by the verifier pool (handshake for releaseAll). */
  held: () => number
  releaseAll: () => void
  maxConcurrent: () => number
  resolveAll: () => Promise<void>
}

function createTestPool(): TestPool {
  const executions: TestPool['executions'] = []
  const cancels: TestPool['cancels'] = []
  const releasedSessions: string[] = []
  const disconnectedProfiles: string[] = []
  let concurrent = 0
  let maxConcurrent = 0
  let pending: Array<() => void> = []
  const pool: TestPool = {
    executions,
    cancels,
    releasedSessions,
    disconnectedProfiles,
    hold: false,
    held: () => {
      return pending.length
    },
    releaseAll: () => {
      const resolvers = pending
      pending = []
      for (const resolve of resolvers) {
        resolve()
      }
    },
    resolveAll: async () => {
      while (pending.length > 0) {
        pool.releaseAll()
        await new Promise((resolve) => {
          setTimeout(resolve, 0)
        })
      }
    },
    maxConcurrent: () => {
      return maxConcurrent
    },
    async execute({ request, tab, cdpUrl, connectionEpoch, signal }) {
      executions.push({ request, tab, cdpUrl, connectionEpoch })
      concurrent += 1
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      try {
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const settle = (fn: () => void) => {
            if (settled) {
              return
            }
            settled = true
            signal?.removeEventListener('abort', onAbort)
            fn()
          }
          const release = () => {
            settle(() => {
              resolve()
            })
          }
          const onAbort = () => {
            const index = pending.indexOf(release)
            if (index >= 0) {
              pending.splice(index, 1)
            }
            settle(() => {
              reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
            })
          }
          if (signal?.aborted) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
          if (pool.hold) {
            pending.push(release)
            return
          }
          setTimeout(release, 20)
        })
        return { requestId: request.requestId, ok: true, data: { text: `executed ${request.operation.kind}` } }
      } finally {
        concurrent -= 1
      }
    },
    async cancel({ sessionId, requestId }) {
      cancels.push({ sessionId, requestId })
    },
    async releaseSession({ sessionId }) {
      releasedSessions.push(sessionId)
    },
    async disconnectProfile({ profileId }) {
      disconnectedProfiles.push(profileId)
    },
    async dispose() {},
  }
  return pool
}

type FakeExtensionOptions = {
  port: number
  installId: string
  browser?: string
  email?: string
  origin?: string
}

class FakeExtension {
  readonly received: BrowserRequest[] = []
  readonly forwardCommands: Array<{ method: string; params?: unknown; sessionId?: string }> = []
  readonly closed: Promise<{ code: number; reason: string }>
  readonly inventoryByGroup = new Map<string, BrowserGroup>()
  readonly inventoryByTab = new Map<string, BrowserTab>()
  holdResponses = false
  onRequest?: (request: BrowserRequest) => BrowserResponse | Promise<BrowserResponse>
  private readonly ws: WebSocket
  private readonly held: Array<() => void> = []
  private readonly closeResolvers: Array<(value: { code: number; reason: string }) => void> = []
  private closedState: { code: number; reason: string } | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.closed = new Promise((resolve) => {
      this.closeResolvers.push(resolve)
    })
  }

  static async connect(options: FakeExtensionOptions): Promise<FakeExtension> {
    const query = new URLSearchParams({
      browser: options.browser ?? 'Chrome',
      installId: options.installId,
      ...(options.email ? { email: options.email } : {}),
      v: 'test',
    })
    const ws = new WebSocket(`ws://127.0.0.1:${options.port}/extension?${query.toString()}`, {
      origin: options.origin ?? EXTENSION_ORIGIN,
    })
    const extension = new FakeExtension(ws)
    ws.on('message', (data) => {
      void extension.handleMessage(data.toString())
    })
    ws.on('close', (code, reason) => {
      extension.closedState = { code, reason: reason.toString() }
      for (const resolve of extension.closeResolvers) {
        resolve(extension.closedState)
      }
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    return extension
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: { id?: number; method?: string; params?: unknown }
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id === undefined) {
      return
    }
    if (message.method === 'browserRequest') {
      const request = message.params as BrowserRequest
      this.received.push(request)
      const respond = async () => {
        const response = this.onRequest
          ? await this.onRequest(request)
          : defaultExtensionResponse({
              request,
              inventoryByGroup: this.inventoryByGroup,
              inventoryByTab: this.inventoryByTab,
            })
        this.ws.send(JSON.stringify({ id: message.id, result: response }))
      }
      if (this.holdResponses) {
        this.held.push(() => {
          void respond()
        })
        return
      }
      await respond()
      return
    }
    if (message.method === 'forwardCDPCommand') {
      this.forwardCommands.push(message.params as { method: string; params?: unknown; sessionId?: string })
      this.ws.send(JSON.stringify({ id: message.id, result: {} }))
      return
    }
    this.ws.send(JSON.stringify({ id: message.id, result: {} }))
  }

  releaseHeldResponses(): void {
    const held = this.held.splice(0)
    for (const release of held) {
      release()
    }
  }

  sendInventory(inventory: BrowserInventory): void {
    for (const group of inventory.groups) {
      this.inventoryByGroup.set(group.groupId, group)
    }
    for (const tab of inventory.tabs) {
      this.inventoryByTab.set(tab.tabId, tab)
    }
    this.ws.send(JSON.stringify({ method: 'browserInventory', params: inventory }))
  }

  sendRaw(value: unknown): void {
    this.ws.send(JSON.stringify(value))
  }

  sendForwardCdpEvent({
    method,
    sessionId,
    params,
  }: {
    method: string
    sessionId?: string
    params?: unknown
  }): void {
    this.ws.send(JSON.stringify({ method: 'forwardCDPEvent', params: { method, sessionId, params } }))
  }

  close(): void {
    this.ws.close()
  }
}

function defaultExtensionResponse({
  request,
  inventoryByGroup,
  inventoryByTab,
}: {
  request: BrowserRequest
  inventoryByGroup: Map<string, BrowserGroup>
  inventoryByTab: Map<string, BrowserTab>
}): BrowserResponse {
  const operation = request.operation
  if (operation.kind === 'tab.resolve') {
    const tab = inventoryByTab.get(operation.tabId)
    if (!tab || tab.sessionId !== request.sessionId) {
      return {
        requestId: request.requestId,
        ok: false,
        error: { code: 'resource-not-found', message: `tab ${operation.tabId} not found`, outcome: 'not-started' },
      }
    }
    return { requestId: request.requestId, ok: true, data: { tab } }
  }
  if (operation.kind === 'groups.create') {
    return {
      requestId: request.requestId,
      ok: true,
      data: {
        group: {
          groupId: `group-${operation.name}`,
          sessionId: request.sessionId,
          profileId: operation.profileId,
          name: operation.name,
          state: 'ready',
          browserEpoch: 'epoch-1',
          revision: 2,
        },
      },
    }
  }
  if (operation.kind === 'tabs.create') {
    const group = inventoryByGroup.get(operation.groupId)
    return {
      requestId: request.requestId,
      ok: true,
      data: {
        tab: {
          tabId: `tab-${request.requestId}`,
          groupId: operation.groupId,
          sessionId: request.sessionId,
          profileId: group?.profileId ?? 'profile-1',
          url: operation.url,
          title: '',
          state: 'ready',
          browserEpoch: 'epoch-1',
          revision: 3,
          chromeTabId: 999,
          targetId: `target-${request.requestId}`,
          cdpSessionId: `pw-tab-${request.requestId}`,
        },
      },
    }
  }
  return { requestId: request.requestId, ok: true, data: { text: `extension handled ${operation.kind}` } }
}

type RelayHandle = {
  port: number
  close: () => Promise<void>
  logs: string[]
  errors: string[]
}

async function startRelay({
  token,
  poolFactory,
}: {
  token?: string
  poolFactory?: () => Promise<ManagedExecutorPoolContract>
} = {}): Promise<RelayHandle> {
  const port = await getFreePort()
  const logs: string[] = []
  const errors: string[] = []
  const server = await startPlayWriterCDPRelayServer({
    port,
    logger: {
      log: (...args: unknown[]) => {
        logs.push(args.map((arg) => String(arg)).join(' '))
      },
      error: (...args: unknown[]) => {
        errors.push(args.map((arg) => String(arg)).join(' '))
      },
    },
    cdpLogger: nullCdpLogger,
    token,
    managedExecutorPoolFactory: poolFactory,
  })
  return {
    port,
    logs,
    errors,
    close: async () => {
      server.close()
      await new Promise((resolve) => {
        setTimeout(resolve, 20)
      })
    },
  }
}

async function waitForExtensionRegistered({
  port,
  count = 1,
  token,
}: {
  port: number
  count?: number
  token?: string
}): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const status = (await getJson({ port, path: '/extensions/status', token })) as {
      body: { extensions?: unknown[] }
    }
    if ((status.body.extensions?.length ?? 0) >= count) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error('timed out waiting for extension registration')
}

async function waitForExtensionCount({ port, count }: { port: number; count: number }): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const status = (await getJson({ port, path: '/extensions/status' })) as {
      body: { extensions?: unknown[] }
    }
    if ((status.body.extensions?.length ?? 0) === count) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10)
    })
  }
  throw new Error(`timed out waiting for ${count} connected extensions`)
}

class FakeCdpClient {
  readonly messages: Array<Record<string, unknown>> = []
  private readonly ws: WebSocket
  private readonly closePromise: Promise<{ code: number; reason: string }>
  private closedState: { code: number; reason: string } | null = null

  private constructor(ws: WebSocket) {
    this.ws = ws
    this.closePromise = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        this.closedState = { code, reason: reason.toString() }
        resolve(this.closedState)
      })
    })
  }

  static async connect({ port, query }: { port: number; query: string }): Promise<FakeCdpClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/cdp/test-${Math.random().toString(36).slice(2, 8)}?${query}`)
    const client = new FakeCdpClient(ws)
    ws.on('message', (data) => {
      try {
        client.messages.push(JSON.parse(data.toString()))
      } catch {
        // ignore non-JSON frames
      }
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    return client
  }

  send(command: { id: number; method: string; params?: unknown; sessionId?: string }): void {
    this.ws.send(JSON.stringify(command))
  }

  async waitForResponse(id: number, timeoutMs = 3000): Promise<Record<string, unknown>> {
    await waitForCondition(
      () => {
        return this.messages.some((message) => {
          return message.id === id
        })
      },
      { timeoutMs, message: `response ${id}` },
    )
    const response = this.messages.find((message) => {
      return message.id === id
    })
    if (!response) {
      throw new Error(`missing response ${id}`)
    }
    return response
  }

  async waitForClose(timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    if (this.closedState) {
      return this.closedState
    }
    const timeout = new Promise<never>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error('timed out waiting for close'))
      }, timeoutMs)
    })
    return await Promise.race([this.closePromise, timeout])
  }

  attachedTargets(): string[] {
    return this.messages
      .filter((message) => {
        return message.method === 'Target.attachedToTarget'
      })
      .map((message) => {
        const params = message.params as { targetInfo?: { targetId?: string } } | undefined
        return params?.targetInfo?.targetId ?? ''
      })
  }

  close(): void {
    this.ws.close()
  }
}

const relays: RelayHandle[] = []
const extensions: FakeExtension[] = []
const cdpClients: FakeCdpClient[] = []

afterEach(async () => {
  for (const client of cdpClients.splice(0)) {
    client.close()
  }
  for (const extension of extensions.splice(0)) {
    extension.close()
  }
  for (const relay of relays.splice(0)) {
    await relay.close()
  }
})

async function startTrackedRelay(options: Parameters<typeof startRelay>[0] = {}): Promise<RelayHandle> {
  const relay = await startRelay(options)
  relays.push(relay)
  return relay
}

async function connectTrackedExtension(options: FakeExtensionOptions & { token?: string }): Promise<FakeExtension> {
  const extension = await FakeExtension.connect(options)
  extensions.push(extension)
  await waitForExtensionRegistered({ port: options.port, token: options.token })
  return extension
}

async function connectTrackedCdpClient(options: { port: number; query: string }): Promise<FakeCdpClient> {
  const client = await FakeCdpClient.connect(options)
  cdpClients.push(client)
  return client
}

// ---------------------------------------------------------------------------
// HTTP surface
// ---------------------------------------------------------------------------

describe('managed /browser/v1 HTTP surface', () => {
  test('capabilities are static, profiles require auth when a token is configured', async () => {
    const relay = await startTrackedRelay({ token: 'sekret', poolFactory: async () => createTestPool() })

    const unauthorizedCapabilities = await getJson({ port: relay.port, path: '/browser/v1/capabilities' })
    expect(unauthorizedCapabilities.status).toBe(401)
    const unauthorizedProfiles = await getJson({ port: relay.port, path: '/browser/v1/profiles' })
    expect(unauthorizedProfiles.status).toBe(401)
    const unauthorizedRequest = await postJson({
      port: relay.port,
      path: '/browser/v1/request',
      body: {},
    })
    expect(unauthorizedRequest.status).toBe(401)

    const capabilities = await getJson({ port: relay.port, path: '/browser/v1/capabilities', token: 'sekret' })
    expect(capabilities).toMatchInlineSnapshot(`
      {
        "body": {
          "existingTabControl": true,
          "explicitTabs": true,
          "isolatedExecution": true,
          "managedGroups": true,
          "persistentOwnership": true,
          "protocolVersion": 1,
        },
        "status": 200,
      }
    `)
    const profiles = await getJson({ port: relay.port, path: '/browser/v1/profiles', token: 'sekret' })
    expect(profiles).toMatchInlineSnapshot(`
      {
        "body": {
          "profiles": [],
        },
        "status": 200,
      }
    `)
  })

  test('isolatedExecution is advertised from the statically linked executor', async () => {
    const relay = await startTrackedRelay()
    const withoutInjectedPool = await getJson({ port: relay.port, path: '/browser/v1/capabilities' })
    expect(withoutInjectedPool.body).toMatchObject({ isolatedExecution: true })

    const poolRelay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const withPool = await getJson({ port: poolRelay.port, path: '/browser/v1/capabilities' })
    expect(withPool.body).toMatchObject({
      explicitTabs: true,
      isolatedExecution: true,
      managedGroups: true,
      persistentOwnership: true,
      protocolVersion: 1,
    })
  })

  test('malformed bodies are rejected with 400 before any protocol work', async () => {
    const relay = await startTrackedRelay()

    const notJson = await postJson({ port: relay.port, path: '/browser/v1/request', body: '{oops' })
    expect(notJson.status).toBe(400)
    const wrongContentType = await postJson({
      port: relay.port,
      path: '/browser/v1/request',
      body: { hello: true },
      contentType: null,
    })
    expect(wrongContentType.status).toBe(400)
    const arrayBody = await postJson({ port: relay.port, path: '/browser/v1/request', body: [1, 2, 3] })
    expect(arrayBody.status).toBe(400)

    const missingFields = await browserRequest({
      port: relay.port,
      request: { requestId: 'r1', sessionId: 's1' } as BrowserRequest,
    })
    expect(missingFields.status).toBe(400)

    const unknownKind = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r1',
        sessionId: 's1',
        operation: { kind: 'groups.explode' } as never,
      },
    })
    expect(unknownKind.status).toBe(400)

    const unknownTopField = await browserRequest({
      port: relay.port,
      request: { requestId: 'r1', sessionId: 's1', operation: { kind: 'profiles.list' }, extra: 1 } as never,
    })
    expect(unknownTopField.status).toBe(400)

    const unknownOperationField = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r1',
        sessionId: 's1',
        operation: { kind: 'tabs.close', tabId: 't1', force: true } as never,
      },
    })
    expect(unknownOperationField.status).toBe(400)

    const dangerousUrl = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r1',
        sessionId: 's1',
        operation: { kind: 'tabs.create', groupId: 'g1', url: 'javascript:alert(1)' },
      },
    })
    expect(dangerousUrl.status).toBe(400)

    const badTimeout = await browserRequest({
      port: relay.port,
      request: { requestId: 'r1', sessionId: 's1', operation: { kind: 'profiles.list' }, timeoutMs: 500_000 },
    })
    expect(badTimeout.status).toBe(400)

    const oversized = await postJson({
      port: relay.port,
      path: '/browser/v1/request',
      body: 'x'.repeat(MANAGED_REQUEST_BODY_LIMIT_BYTES + 16),
    })
    expect(oversized.status).toBe(400)
  })

  test('protocol failures are 200 with ok:false and never fall back to the legacy relay', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const unknownTab = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-unknown',
        sessionId: 's1',
        operation: { kind: 'tabs.close', tabId: 'missing-tab' },
      },
    })
    expect(unknownTab).toMatchInlineSnapshot(`
      {
        "body": {
          "error": {
            "code": "resource-not-found",
            "message": "tab missing-tab not found",
            "outcome": "not-started",
          },
          "ok": false,
          "requestId": "r-unknown",
        },
        "status": 200,
      }
    `)
    expect(extension.received).toHaveLength(0)

    const unknownProfile = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-legacy',
        sessionId: 's1',
        operation: { kind: 'groups.create', profileId: 'not-a-profile', name: 'x' },
      },
    })
    expect(unknownProfile.status).toBe(200)
    expect(unknownProfile.body).toMatchObject({
      ok: false,
      error: { code: 'unsupported-capability', outcome: 'not-started' },
    })

    extension.close()
    await waitForExtensionCount({ port: relay.port, count: 0 })
    const offline = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-offline',
        sessionId: 's1',
        operation: { kind: 'groups.create', profileId: 'profile-1', name: 'x' },
      },
    })
    expect(offline.status).toBe(200)
    expect(offline.body).toMatchObject({
      ok: false,
      error: { code: 'profile-disconnected', outcome: 'not-started' },
    })
  })
})

// ---------------------------------------------------------------------------
// Extension origin allowlist
// ---------------------------------------------------------------------------

describe('extension origin allowlist', () => {
  test('accepts the fork extension identity and rejects unknown origins', async () => {
    const relay = await startTrackedRelay()
    const forkExtension = await FakeExtension.connect({
      port: relay.port,
      installId: 'profile-1',
      origin: 'chrome-extension://eeklahpecooapnailfaebkjjembkjhhg',
    })
    extensions.push(forkExtension)
    await waitForExtensionRegistered({ port: relay.port })
    forkExtension.sendInventory(makeInventory({ groups: [], tabs: [] }))
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'fork extension inventory accepted' },
    )

    await expect(
      FakeExtension.connect({
        port: relay.port,
        installId: 'install-unknown',
        origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    ).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Inventory registry
// ---------------------------------------------------------------------------

describe('managed inventory registry', () => {
  test('profiles, groups and tabs come from the extension inventory and are session filtered', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1', email: 'a@b.c' })
    extension.sendInventory(
      makeInventory({
        revision: 5,
        groups: [
          makeGroup({ groupId: 'g1', sessionId: 'session-a', name: 'alpha' }),
          makeGroup({ groupId: 'g2', sessionId: 'session-a', name: 'beta' }),
          makeGroup({ groupId: 'g3', sessionId: 'session-b', name: 'other' }),
        ],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' }),
          makeTab({ tabId: 't2', groupId: 'g2', sessionId: 'session-a' }),
          makeTab({ tabId: 't3', groupId: 'g3', sessionId: 'session-b' }),
        ],
      }),
    )

    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const profiles = await getJson({ port: relay.port, path: '/browser/v1/profiles' })
    expect(profiles.body).toMatchInlineSnapshot(`
      {
        "profiles": [
          {
            "browser": "Chrome",
            "browserEpoch": "epoch-1",
            "capabilities": {
              "existingTabControl": true,
              "explicitTabs": true,
              "isolatedExecution": true,
              "managedGroups": true,
              "persistentOwnership": true,
              "protocolVersion": 1,
            },
            "connected": true,
            "label": "a@b.c",
            "profileId": "profile-1",
          },
        ],
      }
    `)

    const groupsA = await browserRequest({
      port: relay.port,
      request: { requestId: 'list-a', sessionId: 'session-a', operation: { kind: 'groups.list' } },
    })
    expect(groupsA.body).toMatchInlineSnapshot(`
      {
        "data": {
          "groups": [
            {
              "browserEpoch": "epoch-1",
              "chromeGroupId": 100,
              "groupId": "g1",
              "name": "alpha",
              "profileId": "profile-1",
              "revision": 1,
              "sessionId": "session-a",
              "state": "ready",
              "windowId": 10,
            },
            {
              "browserEpoch": "epoch-1",
              "chromeGroupId": 100,
              "groupId": "g2",
              "name": "beta",
              "profileId": "profile-1",
              "revision": 1,
              "sessionId": "session-a",
              "state": "ready",
              "windowId": 10,
            },
          ],
        },
        "ok": true,
        "requestId": "list-a",
      }
    `)

    const groupsB = await browserRequest({
      port: relay.port,
      request: { requestId: 'list-b', sessionId: 'session-b', operation: { kind: 'groups.list' } },
    })
    expect((groupsB.body as { data: { groups: unknown[] } }).data.groups).toHaveLength(1)

    const tabsA = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'tabs-a',
        sessionId: 'session-a',
        operation: { kind: 'tabs.list', groupId: 'g2' },
      },
    })
    expect(tabsA.body).toMatchObject({
      ok: true,
      data: { tabs: [{ tabId: 't2', groupId: 'g2', state: 'ready' }] },
    })
  })

  test('stale revisions and disconnected profiles never lose cached ownership', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        revision: 7,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=7')
        })
      },
      { message: 'revision 7 accepted' },
    )

    // Stale snapshot from the same connection: lower revision must be rejected.
    extension.sendInventory(
      makeInventory({
        revision: 6,
        groups: [],
        tabs: [],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('stale-inventory revision')
        })
      },
      { message: 'stale revision rejected' },
    )
    const afterStale = await browserRequest({
      port: relay.port,
      request: { requestId: 'r1', sessionId: 's1', operation: { kind: 'groups.list' } },
    })
    expect((afterStale.body as { data: { groups: unknown[] } }).data.groups).toHaveLength(1)

    // Disconnect: cache is kept, profile is offline, resources report disconnected.
    extension.close()
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('offline, keeping cached ownership')
        })
      },
      { message: 'profile marked offline' },
    )
    const offlineProfiles = await getJson({ port: relay.port, path: '/browser/v1/profiles' })
    expect(offlineProfiles.body).toMatchObject({ profiles: [{ connected: false, browserEpoch: 'epoch-1' }] })
    const offlineGroups = await browserRequest({
      port: relay.port,
      request: { requestId: 'r2', sessionId: 's1', operation: { kind: 'groups.list' } },
    })
    expect(offlineGroups.body).toMatchObject({
      ok: true,
      data: { groups: [{ groupId: 'g1', state: 'disconnected' }] },
    })

    // Reconnect with a newer revision: ownership is restored from the extension.
    const reconnected = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    reconnected.sendInventory(
      makeInventory({
        revision: 8,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1', state: 'disconnected' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', state: 'disconnected' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=8')
        })
      },
      { message: 'revision 8 accepted after reconnect' },
    )
    const reconnectedProfiles = await getJson({ port: relay.port, path: '/browser/v1/profiles' })
    expect(reconnectedProfiles.body).toMatchObject({ profiles: [{ connected: true, browserEpoch: 'epoch-1' }] })
  })

  test('internally contradictory inventory snapshots are rejected, not cached', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    const baseline = makeInventory({
      revision: 1,
      groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
      tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
    })
    extension.sendInventory(baseline)
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=1')
        })
      },
      { message: 'baseline inventory accepted' },
    )

    const variants: Array<{ reason: string; inventory: BrowserInventory }> = [
      {
        reason: 'duplicate tabId',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [
            makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
            makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
          ],
        }),
      },
      {
        reason: 'references unknown group',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'missing-group', sessionId: 's1' })],
        }),
      },
      {
        reason: 'owner differs from its group owner',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's2' })],
        }),
      },
      {
        reason: 'belongs to another profile',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', profileId: 'other-profile' })],
        }),
      },
      {
        reason: 'missing cdpSessionId',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', cdpSessionId: undefined })],
        }),
      },
      {
        reason: 'missing chromeTabId',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', chromeTabId: undefined })],
        }),
      },
      {
        reason: 'ready tab t1 has a different browserEpoch',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', browserEpoch: 'epoch-0' })],
        }),
      },
      {
        reason: 'ready group g1 has a different browserEpoch',
        inventory: makeInventory({
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1', browserEpoch: 'epoch-0' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
        }),
      },
      {
        reason: 'duplicate groupId',
        inventory: makeInventory({
          revision: 2,
          groups: [
            makeGroup({ groupId: 'g1', sessionId: 's1' }),
            makeGroup({ groupId: 'g1', sessionId: 's1', name: 'second' }),
          ],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
        }),
      },
      {
        reason: 'does not match the extension install identity',
        inventory: makeInventory({
          profileId: 'other-profile',
          revision: 2,
          groups: [makeGroup({ groupId: 'g1', sessionId: 's1', profileId: 'other-profile' })],
          tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', profileId: 'other-profile' })],
        }),
      },
    ]

    for (const [index, variant] of variants.entries()) {
      extension.sendInventory(variant.inventory)
      await waitForCondition(
        () => {
          return relay.logs.some((line) => {
            return line.includes('rejected inventory') && line.includes(variant.reason)
          })
        },
        { message: `rejection ${index}: ${variant.reason}` },
      )
      const groups = await browserRequest({
        port: relay.port,
        request: { requestId: `list-${index}`, sessionId: 's1', operation: { kind: 'groups.list' } },
      })
      expect((groups.body as { data: { groups: unknown[] } }).data.groups).toHaveLength(1)
    }

    // needs-rebind resources may keep the old browser epoch and are accepted.
    extension.sendInventory(
      makeInventory({
        revision: 2,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', state: 'needs-rebind', browserEpoch: 'epoch-0' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=2')
        })
      },
      { message: 'needs-rebind inventory accepted' },
    )
    const tabs = await browserRequest({
      port: relay.port,
      request: { requestId: 'list-rebind', sessionId: 's1', operation: { kind: 'tabs.list' } },
    })
    expect(tabs.body).toMatchObject({
      ok: true,
      data: { tabs: [{ tabId: 't1', state: 'needs-rebind' }] },
    })
  })

  test('groups with the same name in one session stay independent', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [
          makeGroup({ groupId: 'g1', sessionId: 's1', name: 'same' }),
          makeGroup({ groupId: 'g2', sessionId: 's1', name: 'same' }),
        ],
        tabs: [],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )
    const groups = await browserRequest({
      port: relay.port,
      request: { requestId: 'list-same', sessionId: 's1', operation: { kind: 'groups.list' } },
    })
    const listed = (groups.body as { data: { groups: Array<{ groupId: string; name: string }> } }).data.groups
    expect(listed.map((group) => group.groupId).sort()).toEqual(['g1', 'g2'])
    expect(listed.every((group) => group.name === 'same')).toBe(true)
  })

  test('older connections cannot overwrite a newer snapshot (connection ordering)', () => {
    let state: ManagedRelayState = noteManagedConnectionOpened(createManagedRelayState(), {
      connectionId: 'connection-1',
    })
    state = noteManagedConnectionOpened(state, { connectionId: 'connection-2' })

    const first = applyBrowserInventory(state, {
      connectionId: 'connection-1',
      info: { browser: 'Chrome', installId: 'profile-1', stableKey: 'install:Chrome:profile-1' },
      inventory: makeInventory({
        browserEpoch: 'epoch-1',
        revision: 10,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [],
      }),
    })
    expect(first.result).toMatchObject({ accepted: true, epochChanged: false })
    state = first.state

    const newer = applyBrowserInventory(state, {
      connectionId: 'connection-2',
      info: { browser: 'Chrome', installId: 'profile-1', stableKey: 'install:Chrome:profile-1' },
      inventory: makeInventory({
        browserEpoch: 'epoch-2',
        revision: 1,
        groups: [],
        tabs: [],
      }),
    })
    expect(newer.result).toMatchObject({ accepted: true, epochChanged: true })
    state = newer.state

    const stale = applyBrowserInventory(state, {
      connectionId: 'connection-1',
      info: { browser: 'Chrome', installId: 'profile-1', stableKey: 'install:Chrome:profile-1' },
      inventory: makeInventory({
        browserEpoch: 'epoch-1',
        revision: 99,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [],
      }),
    })
    expect(stale.result).toMatchObject({ accepted: false })
    expect(stale.state.profiles.get('profile-1')?.browserEpoch).toBe('epoch-2')
    expect(stale.state.profiles.get('profile-1')?.groups.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Control routing
// ---------------------------------------------------------------------------

describe('managed control routing', () => {
  test('resource operations are forwarded as browserRequest and deduped by requestId', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const request: BrowserRequest = {
      requestId: 'req-create-1',
      sessionId: 's1',
      operation: { kind: 'tabs.create', groupId: 'g1', url: 'https://example.com/new' },
    }
    const [first, second] = await Promise.all([
      browserRequest({ port: relay.port, request }),
      browserRequest({ port: relay.port, request }),
    ])

    expect(extension.received).toHaveLength(1)
    expect(extension.received[0]).toMatchInlineSnapshot(`
      {
        "operation": {
          "groupId": "g1",
          "kind": "tabs.create",
          "url": "https://example.com/new",
        },
        "requestId": "req-create-1",
        "sessionId": "s1",
      }
    `)
    expect(first.body).toEqual(second.body)
    expect(first.body).toMatchObject({
      ok: true,
      data: { tab: { groupId: 'g1', sessionId: 's1', profileId: 'profile-1' } },
    })

    const groupsCreate = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'req-group-1',
        sessionId: 's1',
        operation: { kind: 'groups.create', profileId: 'profile-1', name: 'work' },
      },
    })
    expect(groupsCreate.body).toMatchObject({
      ok: true,
      data: { group: { sessionId: 's1', profileId: 'profile-1', name: 'work' } },
    })

    // A reused requestId with a different payload is rejected instead of being
    // answered with the stale response or forwarded to the extension.
    const differentPayload = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'req-create-1',
        sessionId: 's1',
        operation: { kind: 'tabs.create', groupId: 'g1', url: 'https://example.com/other' },
      },
    })
    expect(differentPayload.status).toBe(200)
    expect(differentPayload.body).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', outcome: 'not-started' },
    })
    expect(extension.received).toHaveLength(2)

    // Reusing a requestId for a different operation kind is rejected, not replayed.
    const conflicting = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'req-create-1',
        sessionId: 's1',
        operation: { kind: 'groups.rename', groupId: 'g1', name: 'renamed' },
      },
    })
    expect(conflicting.status).toBe(200)
    expect(conflicting.body).toMatchObject({
      ok: false,
      error: { code: 'invalid-request', outcome: 'not-started' },
    })
    expect(extension.received).toHaveLength(2)
  })

  test('cross-session resources are rejected before reaching the extension', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 'session-a' })],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' }),
          makeTab({ tabId: 't-released', groupId: 'g1', sessionId: 'session-a', state: 'released' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const rename = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-rename',
        sessionId: 'session-b',
        operation: { kind: 'groups.rename', groupId: 'g1', name: 'hijack' },
      },
    })
    expect(rename.body).toMatchObject({
      ok: false,
      error: { code: 'ownership-mismatch', outcome: 'not-started' },
    })

    const closeTab = await browserRequest({
      port: relay.port,
      request: { requestId: 'r-close', sessionId: 'session-b', operation: { kind: 'tabs.close', tabId: 't1' } },
    })
    expect(closeTab.body).toMatchObject({
      ok: false,
      error: { code: 'ownership-mismatch', outcome: 'not-started' },
    })

    const released = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-released',
        sessionId: 'session-a',
        operation: { kind: 'tabs.release', tabId: 't-released' },
      },
    })
    expect(released.body).toMatchObject({
      ok: false,
      error: { code: 'resource-released', outcome: 'not-started' },
    })

    expect(extension.received).toHaveLength(0)
  })

  test('session.release keeps resources and request.cancel never touches other sessions', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 'session-a' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const release = await browserRequest({
      port: relay.port,
      request: { requestId: 'r-release', sessionId: 'session-a', operation: { kind: 'session.release' } },
    })
    expect(release.body).toMatchObject({ ok: true })
    const groupsAfterRelease = await browserRequest({
      port: relay.port,
      request: { requestId: 'r-list-after-release', sessionId: 'session-a', operation: { kind: 'groups.list' } },
    })
    expect((groupsAfterRelease.body as { data: { groups: unknown[] } }).data.groups).toHaveLength(1)
    expect(extension.received).toHaveLength(0)

    // In-flight control request: only the owning session may cancel it.
    extension.holdResponses = true
    const inFlight = browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-slow',
        sessionId: 'session-a',
        operation: { kind: 'tabs.create', groupId: 'g1', url: 'https://example.com/slow' },
      },
    })
    await waitForCondition(
      () => {
        return extension.received.length === 1
      },
      { message: 'extension received slow request' },
    )
    const foreignCancel = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-cancel-foreign',
        sessionId: 'session-b',
        operation: { kind: 'request.cancel', targetRequestId: 'r-slow' },
      },
    })
    expect(foreignCancel.body).toMatchObject({
      ok: false,
      error: { code: 'ownership-mismatch', outcome: 'not-started' },
    })

    const ownCancel = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'r-cancel-own',
        sessionId: 'session-a',
        operation: { kind: 'request.cancel', targetRequestId: 'r-slow' },
      },
    })
    expect(ownCancel.body).toMatchObject({ ok: true })
    const inFlightResult = await inFlight
    expect(inFlightResult.body).toMatchObject({
      ok: false,
      error: { code: 'cancelled', outcome: 'unknown' },
    })
    extension.releaseHeldResponses()
  })

  test('request.cancel notifies the extension for in-flight control commands', async () => {
    const pool = createTestPool()
    pool.hold = true
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        revision: 1,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=1')
        })
      },
      { message: 'inventory accepted' },
    )

    // Occupy the per-profile queue with a page operation; cancels must not wait for it.
    const pageOperation = browserRequest({
      port: relay.port,
      request: {
        requestId: 'busy-page',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/busy' },
      },
    })
    await waitForCondition(
      () => {
        return pool.executions.length === 1 && pool.held() === 1
      },
      { message: 'page operation is running and held by the verifier pool' },
    )

    extension.holdResponses = true
    const control = browserRequest({
      port: relay.port,
      request: {
        requestId: 'slow-control',
        sessionId: 's1',
        operation: { kind: 'tabs.create', groupId: 'g1', url: 'https://example.com/slow' },
      },
    })
    await waitForCondition(
      () => {
        return extension.received.some((entry) => {
          return entry.requestId === 'slow-control'
        })
      },
      { message: 'control command reached the extension' },
    )

    const cancel = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'cancel-slow-control',
        sessionId: 's1',
        operation: { kind: 'request.cancel', targetRequestId: 'slow-control' },
      },
    })
    expect(cancel.body).toMatchObject({ ok: true })
    await waitForCondition(
      () => {
        return extension.received.some((entry) => {
          return entry.operation.kind === 'request.cancel' && entry.operation.targetRequestId === 'slow-control'
        })
      },
      { message: 'extension cancel notice forwarded while the queue is busy' },
    )
    const notice = extension.received.find((entry) => {
      return entry.operation.kind === 'request.cancel' && entry.operation.targetRequestId === 'slow-control'
    })
    expect(notice).toMatchObject({
      sessionId: 's1',
      operation: { kind: 'request.cancel', targetRequestId: 'slow-control' },
    })

    const controlResult = await control
    expect(controlResult.body).toMatchObject({
      ok: false,
      error: { code: 'cancelled', outcome: 'unknown' },
    })

    extension.holdResponses = false
    extension.releaseHeldResponses()
    pool.releaseAll()
    const pageResult = await pageOperation
    expect(pageResult.body).toMatchObject({ ok: true })
  })

  test('control command timeouts notify the extension and report unknown', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    extension.holdResponses = true
    const response = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'slow-timeout',
        sessionId: 's1',
        operation: { kind: 'tabs.create', groupId: 'g1', url: 'https://example.com/timeout' },
        timeoutMs: 60,
      },
    })
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'timeout', outcome: 'unknown' },
    })
    await waitForCondition(
      () => {
        return extension.received.some((entry) => {
          return entry.operation.kind === 'request.cancel' && entry.operation.targetRequestId === 'slow-timeout'
        })
      },
      { message: 'extension cancel notice after timeout' },
    )
    extension.holdResponses = false
    extension.releaseHeldResponses()
  })

  test('a dropped client notifies the extension for control commands', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    extension.holdResponses = true
    const controller = new AbortController()
    const responsePromise = fetch(`http://127.0.0.1:${relay.port}/browser/v1/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'slow-drop',
        sessionId: 's1',
        operation: { kind: 'tabs.create', groupId: 'g1', url: 'https://example.com/drop' },
      }),
      signal: controller.signal,
    })
    await waitForCondition(
      () => {
        return extension.received.some((entry) => {
          return entry.requestId === 'slow-drop'
        })
      },
      { message: 'control command reached the extension' },
    )
    controller.abort()
    await expect(responsePromise).rejects.toThrow()
    await waitForCondition(
      () => {
        return extension.received.some((entry) => {
          return entry.operation.kind === 'request.cancel' && entry.operation.targetRequestId === 'slow-drop'
        })
      },
      { message: 'extension cancel notice after client disconnect' },
    )
    extension.holdResponses = false
    extension.releaseHeldResponses()
  })
})

// ---------------------------------------------------------------------------
// Page execution through the isolated executor pool
// ---------------------------------------------------------------------------

describe('managed page execution', () => {
  test('page operations resolve the tab, pass the scoped cdp url and serialize per profile', async () => {
    const pool = createTestPool()
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
          makeTab({ tabId: 't2', groupId: 'g1', sessionId: 's1' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const first = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'page-1',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/a' },
      },
    })
    expect(first.body).toMatchObject({ ok: true, data: { text: 'executed page.navigate' } })
    expect(pool.executions).toHaveLength(1)
    const execution = pool.executions[0]
    expect(execution.tab).toMatchObject({ tabId: 't1', targetId: 'target-t1' })
    const cdpUrl = new URL(execution.cdpUrl)
    expect(cdpUrl.pathname.startsWith('/cdp/managed-')).toBe(true)
    expect(cdpUrl.searchParams.get('extensionId')).toBe('install:Chrome:profile-1')
    expect(cdpUrl.searchParams.get('browserSessionId')).toBe('s1')
    expect(cdpUrl.searchParams.get('profileId')).toBe('profile-1')
    expect(cdpUrl.searchParams.get('browserEpoch')).toBe('epoch-1')
    expect(cdpUrl.searchParams.get('connectionEpoch')).toBe(execution.connectionEpoch)

    // Two page ops on the same profile must not overlap (shared Chrome focus).
    pool.hold = true
    const slowAPromise = browserRequest({
      port: relay.port,
      request: { requestId: 'page-2', sessionId: 's1', operation: { kind: 'page.logs', tabId: 't1' } },
    })
    const slowBPromise = browserRequest({
      port: relay.port,
      request: { requestId: 'page-3', sessionId: 's1', operation: { kind: 'page.logs', tabId: 't2' } },
    })
    await waitForCondition(
      () => {
        return pool.executions.length === 2 && pool.held() === 1
      },
      { message: 'first held execution started' },
    )
    // The second op is queued behind the first, not executed concurrently.
    expect(pool.executions).toHaveLength(2)
    pool.releaseAll()
    await waitForCondition(
      () => {
        return pool.executions.length === 3 && pool.held() === 1
      },
      { message: 'second held execution started' },
    )
    pool.releaseAll()
    const [slowA, slowB] = await Promise.all([slowAPromise, slowBPromise])
    expect(slowA.body).toMatchObject({ ok: true })
    expect(slowB.body).toMatchObject({ ok: true })
    expect(pool.maxConcurrent()).toBe(1)
    expect(pool.executions).toHaveLength(3)
  })

  test('timeout and cancel report outcome unknown and never replay the action', async () => {
    const pool = createTestPool()
    pool.hold = true
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const timedOut = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'page-timeout',
        sessionId: 's1',
        operation: { kind: 'page.click', tabId: 't1', selector: 'button' },
        timeoutMs: 40,
      },
    })
    expect(timedOut.body).toMatchObject({
      ok: false,
      error: { code: 'timeout', outcome: 'unknown' },
    })
    expect(pool.executions).toHaveLength(1)

    const cancelledRequest = browserRequest({
      port: relay.port,
      request: {
        requestId: 'page-cancel',
        sessionId: 's1',
        operation: { kind: 'page.fill', tabId: 't1', selector: 'input', value: 'hi' },
      },
    })
    await waitForCondition(
      () => {
        return pool.executions.length === 2
      },
      { message: 'second execution started' },
    )
    const cancel = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'cancel-page',
        sessionId: 's1',
        operation: { kind: 'request.cancel', targetRequestId: 'page-cancel' },
      },
    })
    expect(cancel.body).toMatchObject({ ok: true })
    const cancelledResult = await cancelledRequest
    expect(cancelledResult.body).toMatchObject({
      ok: false,
      error: { code: 'cancelled', outcome: 'unknown' },
    })
    await waitForCondition(
      () => {
        return pool.cancels.some((entry) => {
          return entry.requestId === 'page-cancel'
        })
      },
      { message: 'pool cancel called' },
    )
    expect(pool.cancels).toContainEqual({ sessionId: 's1', requestId: 'page-cancel' })
    // The earlier timeout also revoked its worker request.
    expect(pool.cancels).toContainEqual({ sessionId: 's1', requestId: 'page-timeout' })
    // The action is never replayed: exactly one execution per request.
    expect(pool.executions).toHaveLength(2)
  })

  test('page execution re-checks the tab with the extension before running (release race)', async () => {
    const pool = createTestPool()
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    // The cached inventory still says ready, but the extension has authoritative
    // knowledge that the tab was released while the request was in flight.
    extension.onRequest = (request) => {
      if (request.operation.kind === 'tab.resolve') {
        return {
          requestId: request.requestId,
          ok: false,
          error: { code: 'resource-released', message: 'tab was released', outcome: 'not-started' },
        }
      }
      return defaultExtensionResponse({
        request,
        inventoryByGroup: extension.inventoryByGroup,
        inventoryByTab: extension.inventoryByTab,
      })
    }

    const response = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'page-race',
        sessionId: 's1',
        operation: { kind: 'page.click', tabId: 't1', selector: 'button' },
      },
    })
    expect(response.body).toMatchObject({
      ok: false,
      error: { code: 'resource-released', outcome: 'not-started' },
    })
    expect(pool.executions).toHaveLength(0)
    expect(extension.received.map((entry) => entry.operation.kind)).toEqual(['tab.resolve'])
  })

  test('managed cdp urls carry the runtime token and unauthenticated managed connections are rejected', async () => {
    const pool = createTestPool()
    const relay = await startTrackedRelay({ token: 'sekret', poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1', token: 'sekret' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    await expect(
      FakeCdpClient.connect({
        port: relay.port,
        query: new URLSearchParams({
          browserSessionId: 's1',
          profileId: 'profile-1',
          browserEpoch: 'epoch-1',
        }).toString(),
      }),
    ).rejects.toThrow()

    const managed = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 's1',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
        token: 'sekret',
      }).toString(),
    })
    managed.send({ id: 1, method: 'Target.getTargets' })
    const targets = await managed.waitForResponse(1)
    expect(targets.result).toMatchObject({ targetInfos: [] })

    const response = await browserRequest({
      port: relay.port,
      token: 'sekret',
      request: {
        requestId: 'page-token',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/' },
      },
    })
    expect(response.body).toMatchObject({ ok: true })
    expect(pool.executions).toHaveLength(1)
    const cdpUrl = new URL(pool.executions[0].cdpUrl)
    expect(cdpUrl.searchParams.get('token')).toBe('sekret')
    expect(relay.logs.join('\n')).not.toContain('sekret')
  })

  test('page execution re-validates release state after waiting in the profile queue', async () => {
    const pool = createTestPool()
    pool.hold = true
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        revision: 1,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
          makeTab({ tabId: 't2', groupId: 'g1', sessionId: 's1' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=1')
        })
      },
      { message: 'inventory accepted' },
    )

    // Send the first request alone and wait until it actually occupies the profile
    // queue (parked in the verifier pool). Only then send the second one, otherwise
    // undici may deliver them in either order and the second could be the parked one.
    const first = browserRequest({
      port: relay.port,
      request: {
        requestId: 'queue-a',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/a' },
      },
    })
    await waitForCondition(
      () => {
        return (
          pool.executions.length === 1 &&
          pool.held() === 1 &&
          pool.executions[0]?.request.requestId === 'queue-a'
        )
      },
      { message: 'first request occupies the profile queue' },
    )
    const second = browserRequest({
      port: relay.port,
      request: {
        requestId: 'queue-b',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't2', url: 'https://example.com/b' },
      },
    })

    // The user releases t2 while the second request is in flight or queued behind
    // the first; both paths must reject it without running the executor.
    extension.sendInventory(
      makeInventory({
        revision: 2,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
          makeTab({ tabId: 't2', groupId: 'g1', sessionId: 's1', state: 'released' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=2')
        })
      },
      { message: 'release revision applied while queued' },
    )

    // Handshake: release only after the pool confirms queue-a is parked, never
    // before, or the resolver would not exist yet.
    await waitForCondition(
      () => {
        return pool.held() === 1 && pool.executions[0]?.request.requestId === 'queue-a'
      },
      { message: 'queue-a is parked in the verifier pool' },
    )
    pool.releaseAll()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.body).toMatchObject({ ok: true })
    expect(secondResult.body).toMatchObject({
      ok: false,
      error: { code: 'resource-released', outcome: 'not-started' },
    })
    expect(pool.executions).toHaveLength(1)
    expect(
      extension.received.filter((entry) => {
        return entry.operation.kind === 'tab.resolve'
      }),
    ).toHaveLength(1)
  })

  test('a dropped HTTP client cancels the in-flight page operation', async () => {
    const pool = createTestPool()
    pool.hold = true
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const controller = new AbortController()
    const responsePromise = fetch(`http://127.0.0.1:${relay.port}/browser/v1/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: 'page-disconnect',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/' },
      }),
      signal: controller.signal,
    })
    await waitForCondition(
      () => {
        return pool.executions.length === 1 && pool.held() === 1
      },
      { message: 'execution is held before the client dropped' },
    )
    controller.abort()
    await expect(responsePromise).rejects.toThrow()
    await waitForCondition(
      () => {
        return pool.cancels.length === 1
      },
      { message: 'client disconnect cancels the pool request' },
    )
    expect(pool.cancels[0]).toEqual({ sessionId: 's1', requestId: 'page-disconnect' })
  })

  test('page operations on a released or foreign tab fail before the executor runs', async () => {
    const pool = createTestPool()
    const relay = await startTrackedRelay({ poolFactory: async () => pool })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', state: 'released' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const released = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'p-released',
        sessionId: 's1',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/' },
      },
    })
    expect(released.body).toMatchObject({
      ok: false,
      error: { code: 'resource-released', outcome: 'not-started' },
    })
    const foreign = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'p-foreign',
        sessionId: 's2',
        operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/' },
      },
    })
    expect(foreign.body).toMatchObject({
      ok: false,
      error: { code: 'ownership-mismatch', outcome: 'not-started' },
    })
    expect(pool.executions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Direct relay queue re-validation
// ---------------------------------------------------------------------------

describe('managed queue re-validation', () => {
  test('a queued page operation re-checks the tab inside the profile queue', async () => {
    const pool = createTestPool()
    pool.hold = true
    const tabsById = new Map<string, BrowserTab>()
    const transportCalls: BrowserRequest[] = []
    const relay = new ManagedRelay({
      host: '127.0.0.1',
      port: 1,
      poolFactory: async () => pool,
      hasConnectedExtensions: () => {
        return true
      },
      closeManagedClient: () => {},
      transport: {
        sendBrowserRequest: async ({ request }) => {
          transportCalls.push(request)
          const operation = request.operation
          if (operation.kind === 'tab.resolve') {
            const tab = tabsById.get(operation.tabId)
            if (!tab || tab.sessionId !== request.sessionId) {
              return {
                requestId: request.requestId,
                ok: false,
                error: {
                  code: 'resource-not-found',
                  message: `tab ${operation.tabId} not found`,
                  outcome: 'not-started',
                },
              }
            }
            return { requestId: request.requestId, ok: true, data: { tab } }
          }
          return { requestId: request.requestId, ok: true, data: { text: 'ok' } }
        },
      },
    })
    relay.noteConnectionOpened({ connectionId: 'connection-1' })
    const firstInventory = makeInventory({
      revision: 1,
      groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
      tabs: [
        makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
        makeTab({ tabId: 't2', groupId: 'g1', sessionId: 's1' }),
      ],
    })
    expect(
      relay.handleInventory({
        connectionId: 'connection-1',
        info: { browser: 'Chrome', installId: 'profile-1', stableKey: 'install:Chrome:profile-1' },
        inventory: firstInventory,
      }).accepted,
    ).toBe(true)
    for (const tab of firstInventory.tabs) {
      tabsById.set(tab.tabId, tab)
    }

    const first = relay.handleRequest({
      requestId: 'direct-a',
      sessionId: 's1',
      operation: { kind: 'page.navigate', tabId: 't1', url: 'https://example.com/a' },
    })
    await waitForCondition(
      () => {
        return (
          pool.executions.length === 1 &&
          pool.held() === 1 &&
          pool.executions[0]?.request.requestId === 'direct-a'
        )
      },
      { message: 'first direct request is parked' },
    )

    // handleRequest enqueues synchronously, so direct-b is waiting in the profile
    // queue when the release lands; its in-task re-check must reject it.
    const second = relay.handleRequest({
      requestId: 'direct-b',
      sessionId: 's1',
      operation: { kind: 'page.navigate', tabId: 't2', url: 'https://example.com/b' },
    })
    const released = relay.handleInventory({
      connectionId: 'connection-1',
      info: { browser: 'Chrome', installId: 'profile-1', stableKey: 'install:Chrome:profile-1' },
      inventory: makeInventory({
        revision: 2,
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1' })],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1' }),
          makeTab({ tabId: 't2', groupId: 'g1', sessionId: 's1', state: 'released' }),
        ],
      }),
    })
    expect(released.accepted).toBe(true)

    pool.releaseAll()
    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult).toMatchObject({ ok: true })
    expect(secondResult).toMatchObject({
      ok: false,
      error: { code: 'resource-released', outcome: 'not-started' },
    })
    expect(pool.executions).toHaveLength(1)
    expect(
      transportCalls.filter((request) => {
        return request.operation.kind === 'tab.resolve'
      }),
    ).toHaveLength(1)
    await relay.dispose()
  })
})

// ---------------------------------------------------------------------------
// Managed CDP scoping
// ---------------------------------------------------------------------------

describe('managed CDP scoping', () => {
  test('managed clients only see their own targets and cannot run destructive commands', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [
          makeGroup({ groupId: 'g1', sessionId: 'session-a' }),
          makeGroup({ groupId: 'g2', sessionId: 'session-b' }),
        ],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' }),
          makeTab({ tabId: 't2', groupId: 'g2', sessionId: 'session-b' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const legacy = await connectTrackedCdpClient({ port: relay.port, query: '' })
    const managed = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        extensionId: 'install:Chrome:profile-1',
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
      }).toString(),
    })

    const targetInfo = (targetId: string, url: string) => {
      return {
        targetId,
        type: 'page',
        title: targetId,
        url,
        attached: true,
        canAccessOpener: false,
      }
    }
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t1',
      params: {
        sessionId: 'pw-t1',
        targetInfo: targetInfo('target-t1', 'https://example.com/a'),
        waitingForDebugger: false,
      },
    })
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t2',
      params: {
        sessionId: 'pw-t2',
        targetInfo: targetInfo('target-t2', 'https://example.com/b'),
        waitingForDebugger: false,
      },
    })
    await waitForCondition(
      () => {
        return managed.attachedTargets().length === 1 && legacy.attachedTargets().length === 2
      },
      { message: 'attach events routed per scope' },
    )
    expect(managed.attachedTargets()).toEqual(['target-t1'])
    expect(legacy.attachedTargets()).toEqual(['target-t1', 'target-t2'])

    managed.send({ id: 1, method: 'Target.getTargets' })
    const getTargets = await managed.waitForResponse(1)
    expect(getTargets).toMatchInlineSnapshot(`
      {
        "id": 1,
        "result": {
          "targetInfos": [
            {
              "attached": true,
              "canAccessOpener": false,
              "targetId": "target-t1",
              "title": "target-t1",
              "type": "page",
              "url": "https://example.com/a",
            },
          ],
        },
      }
    `)

    managed.send({ id: 2, method: 'Target.getTargetInfo', params: { targetId: 'target-t2' } })
    const foreignInfo = await managed.waitForResponse(2)
    expect(foreignInfo.error).toMatchObject({
      message: expect.stringContaining('does not belong to this managed session'),
    })

    managed.send({ id: 3, method: 'Target.attachToTarget', params: { targetId: 'target-t2', flatten: true } })
    const foreignAttach = await managed.waitForResponse(3)
    expect(foreignAttach.error).toMatchObject({
      message: expect.stringContaining('does not belong to this managed session'),
    })

    managed.send({ id: 4, method: 'Target.createTarget', params: { url: 'https://example.com/' } })
    const createTarget = await managed.waitForResponse(4)
    expect(createTarget.error).toMatchObject({ message: expect.stringContaining('not allowed for managed sessions') })

    managed.send({ id: 5, method: 'Browser.close' })
    const browserClose = await managed.waitForResponse(5)
    expect(browserClose.error).toMatchObject({ message: expect.stringContaining('not allowed for managed sessions') })

    managed.send({ id: 6, method: 'Runtime.evaluate', sessionId: 'pw-t2', params: { expression: '1' } })
    const foreignSession = await managed.waitForResponse(6)
    expect(foreignSession.error).toMatchObject({
      message: expect.stringContaining('does not belong to this managed session'),
    })

    // Own session still works and is forwarded to the extension.
    managed.send({ id: 7, method: 'Runtime.evaluate', sessionId: 'pw-t1', params: { expression: '1' } })
    const ownSession = await managed.waitForResponse(7)
    expect(ownSession.result).toEqual({})

    expect(extension.forwardCommands.map((command) => command.method)).toContain('Runtime.evaluate')
    expect(extension.forwardCommands.map((command) => command.method)).not.toContain('Target.createTarget')
    expect(extension.forwardCommands.map((command) => command.method)).not.toContain('Browser.close')
  })

  test('attachment events arriving before the inventory recover once the snapshot arrives', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })

    const legacy = await connectTrackedCdpClient({ port: relay.port, query: '' })
    const targetInfo = (targetId: string, url: string) => {
      return {
        targetId,
        type: 'page',
        title: targetId,
        url,
        attached: true,
        canAccessOpener: false,
      }
    }
    // Attachment events can reach the relay before the extension registry snapshot
    // (relay restart, slow restore). They must not leak across sessions and must
    // become visible to the owner once the inventory arrives.
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t1',
      params: {
        sessionId: 'pw-t1',
        targetInfo: targetInfo('target-t1', 'https://example.com/a'),
        waitingForDebugger: false,
      },
    })
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t2',
      params: {
        sessionId: 'pw-t2',
        targetInfo: targetInfo('target-t2', 'https://example.com/b'),
        waitingForDebugger: false,
      },
    })
    await waitForCondition(
      () => {
        return legacy.attachedTargets().length === 2
      },
      { message: 'attachments stored before inventory' },
    )

    extension.sendInventory(
      makeInventory({
        groups: [
          makeGroup({ groupId: 'g1', sessionId: 'session-a' }),
          makeGroup({ groupId: 'g2', sessionId: 'session-b' }),
        ],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' }),
          makeTab({ tabId: 't2', groupId: 'g2', sessionId: 'session-b' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted after attachments' },
    )

    const managed = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
      }).toString(),
    })
    expect(managed.attachedTargets()).toEqual([])

    managed.send({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } })
    await managed.waitForResponse(1)
    await waitForCondition(
      () => {
        return managed.attachedTargets().includes('target-t1')
      },
      { message: 'owner target synthesized after inventory' },
    )
    expect(managed.attachedTargets()).toEqual(['target-t1'])
  })

  test('profile-wide, wrapper and unlisted root CDP commands are denied for managed clients', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [
          makeGroup({ groupId: 'g1', sessionId: 'session-a' }),
          makeGroup({ groupId: 'g2', sessionId: 'session-b' }),
        ],
        tabs: [
          makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' }),
          makeTab({ tabId: 't2', groupId: 'g2', sessionId: 'session-b' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )
    const managed = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
      }).toString(),
    })
    const targetInfo = (targetId: string, url: string) => {
      return {
        targetId,
        type: 'page',
        title: targetId,
        url,
        attached: true,
        canAccessOpener: false,
      }
    }
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t1',
      params: {
        sessionId: 'pw-t1',
        targetInfo: targetInfo('target-t1', 'https://example.com/a'),
        waitingForDebugger: false,
      },
    })
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t2',
      params: {
        sessionId: 'pw-t2',
        targetInfo: targetInfo('target-t2', 'https://example.com/b'),
        waitingForDebugger: false,
      },
    })
    await waitForCondition(
      () => {
        return managed.attachedTargets().length === 1
      },
      { message: 'managed attach scope resolved' },
    )

    const denied = [
      { id: 10, method: 'Network.clearBrowserCookies' },
      { id: 11, method: 'Network.clearBrowserCache' },
      {
        id: 12,
        method: 'Storage.clearDataForOrigin',
        sessionId: 'pw-t1',
        params: { origin: 'https://example.com', storageTypes: 'all' },
      },
      { id: 13, method: 'Page.enable' },
      { id: 14, method: 'Target.sendMessageToTarget', params: { sessionId: 'pw-t2', message: '{}' } },
      { id: 15, method: 'Target.detachFromTarget', params: { sessionId: 'pw-t2' } },
      {
        id: 18,
        method: 'Target.sendMessageToTarget',
        sessionId: 'pw-t1',
        params: {
          sessionId: 'pw-t1',
          message: JSON.stringify({ id: 1, method: 'Target.createTarget', params: { url: 'https://example.com/' } }),
        },
      },
      { id: 19, method: 'Target.sendMessageToBrowserTarget', params: { message: JSON.stringify({ id: 1, method: 'Browser.close' }) } },
    ]
    for (const command of denied) {
      managed.send(command)
    }
    for (const command of denied) {
      const response = await managed.waitForResponse(command.id)
      expect(response.error).toMatchObject({ message: expect.any(String) })
    }
    expect(extension.forwardCommands).toHaveLength(0)

    // Own-session wrappers and download behavior stay usable, scoped to own tabs.
    managed.send({ id: 16, method: 'Target.detachFromTarget', params: { sessionId: 'pw-t1' } })
    await managed.waitForResponse(16)
    managed.send({ id: 17, method: 'Browser.setDownloadBehavior', params: { behavior: 'allow', downloadPath: '/tmp/downloads' } })
    await managed.waitForResponse(17)
    expect(
      extension.forwardCommands.map((command) => {
        return `${command.method}:${command.sessionId ?? '-'}`
      }),
    ).toEqual(['Target.detachFromTarget:-', 'Page.setDownloadBehavior:pw-t1'])
  })

  test('managed scope only grants ready tabs in the current epoch', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 'session-a' })],
        tabs: [
          makeTab({ tabId: 't-ready', groupId: 'g1', sessionId: 'session-a' }),
          makeTab({ tabId: 't-rebind', groupId: 'g1', sessionId: 'session-a', state: 'needs-rebind' }),
          makeTab({ tabId: 't-off', groupId: 'g1', sessionId: 'session-a', state: 'disconnected' }),
        ],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )
    const managed = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
      }).toString(),
    })
    const targetInfo = (targetId: string) => {
      return {
        targetId,
        type: 'page',
        title: targetId,
        url: 'https://example.com/',
        attached: true,
        canAccessOpener: false,
      }
    }
    for (const tab of [
      { sessionId: 'pw-ready', targetId: 'target-t-ready' },
      { sessionId: 'pw-rebind', targetId: 'target-t-rebind' },
      { sessionId: 'pw-off', targetId: 'target-t-off' },
    ]) {
      extension.sendForwardCdpEvent({
        method: 'Target.attachedToTarget',
        sessionId: tab.sessionId,
        params: { sessionId: tab.sessionId, targetInfo: targetInfo(tab.targetId), waitingForDebugger: false },
      })
    }
    await waitForCondition(
      () => {
        return managed.attachedTargets().length === 1
      },
      { message: 'only the ready target reaches the managed client' },
    )
    expect(managed.attachedTargets()).toEqual(['target-t-ready'])

    managed.send({ id: 1, method: 'Target.getTargets' })
    const targets = await managed.waitForResponse(1)
    expect(targets.result).toMatchObject({ targetInfos: [{ targetId: 'target-t-ready' }] })

    for (const [id, cdpSessionId] of [
      [2, 'pw-rebind'],
      [3, 'pw-off'],
    ] as const) {
      managed.send({ id, method: 'Runtime.evaluate', sessionId: cdpSessionId, params: { expression: '1' } })
      const response = await managed.waitForResponse(id)
      expect(response.error).toMatchObject({ message: expect.stringContaining('does not belong to this managed session') })
    }
  })

  test('iframe grants die with the page that owns them', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        revision: 1,
        groups: [makeGroup({ groupId: 'g1', sessionId: 'session-a' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=1')
        })
      },
      { message: 'inventory accepted' },
    )
    const managed = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
      }).toString(),
    })
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-t1',
      params: {
        sessionId: 'pw-t1',
        targetInfo: {
          targetId: 'target-t1',
          type: 'page',
          title: 't1',
          url: 'https://example.com/',
          attached: true,
          canAccessOpener: false,
        },
        waitingForDebugger: false,
      },
    })
    extension.sendForwardCdpEvent({
      method: 'Page.frameAttached',
      sessionId: 'pw-t1',
      params: { frameId: 'frame-1', parentFrameId: '' },
    })
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-frame',
      params: {
        sessionId: 'pw-frame',
        targetInfo: {
          targetId: 'target-frame',
          type: 'iframe',
          title: 'frame',
          url: 'https://example.com/frame',
          parentFrameId: 'frame-1',
          attached: true,
          canAccessOpener: false,
        },
        waitingForDebugger: false,
      },
    })
    await waitForCondition(
      () => {
        return managed.attachedTargets().includes('target-frame')
      },
      { message: 'owned iframe attach forwarded' },
    )
    managed.send({ id: 1, method: 'Runtime.evaluate', sessionId: 'pw-frame', params: { expression: '1' } })
    await managed.waitForResponse(1)
    expect(extension.forwardCommands.map((command) => command.sessionId)).toContain('pw-frame')

    // The user releases the parent page: the iframe grant must disappear with it.
    extension.sendInventory(
      makeInventory({
        revision: 2,
        groups: [makeGroup({ groupId: 'g1', sessionId: 'session-a' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a', state: 'released' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('revision=2')
        })
      },
      { message: 'release revision applied' },
    )
    managed.send({ id: 2, method: 'Runtime.evaluate', sessionId: 'pw-frame', params: { expression: '1' } })
    const afterRelease = await managed.waitForResponse(2)
    expect(afterRelease.error).toMatchObject({ message: expect.stringContaining('does not belong to this managed session') })

    const before = managed.attachedTargets().length
    extension.sendForwardCdpEvent({
      method: 'Target.attachedToTarget',
      sessionId: 'pw-frame-2',
      params: {
        sessionId: 'pw-frame-2',
        targetInfo: {
          targetId: 'target-frame-2',
          type: 'iframe',
          title: 'frame2',
          url: 'https://example.com/frame2',
          parentFrameId: 'frame-1',
          attached: true,
          canAccessOpener: false,
        },
        waitingForDebugger: false,
      },
    })
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(managed.attachedTargets()).toHaveLength(before)
  })

  test('stale browserEpoch and stale connectionEpoch managed connections are rejected', async () => {
    const relay = await startTrackedRelay()
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 'session-a' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 'session-a' })],
      }),
    )
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )

    const staleEpoch = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-0',
      }).toString(),
    })
    expect(await staleEpoch.waitForClose()).toMatchObject({
      code: 4002,
      reason: expect.stringContaining('stale browser epoch'),
    })

    const staleConnection = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'profile-1',
        browserEpoch: 'epoch-1',
        connectionEpoch: 'bogus-epoch',
      }).toString(),
    })
    expect(await staleConnection.waitForClose()).toMatchObject({
      code: 4002,
      reason: expect.stringContaining('epoch is stale'),
    })

    const unknownProfile = await connectTrackedCdpClient({
      port: relay.port,
      query: new URLSearchParams({
        browserSessionId: 'session-a',
        profileId: 'missing-profile',
        browserEpoch: 'epoch-1',
      }).toString(),
    })
    const unknownClose = await unknownProfile.waitForClose()
    expect(unknownClose.code).toBe(4002)
  })
})

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

describe('managed registry ownership boundaries', () => {
  test('cached records outside their profile ownership boundary are ignored', () => {
    const state = createManagedRelayState()
    const snapshot: ManagedProfileSnapshot = {
      profileId: 'p1',
      stableKey: 'install:Chrome:p1',
      browser: 'Chrome',
      label: 'Chrome',
      browserEpoch: 'e1',
      revision: 1,
      groups: new Map([
        ['g-ok', makeGroup({ groupId: 'g-ok', sessionId: 's1', profileId: 'p1' })],
        ['g-foreign', makeGroup({ groupId: 'g-foreign', sessionId: 's1', profileId: 'p2' })],
      ]),
      tabs: new Map([
        ['t-ok', makeTab({ tabId: 't-ok', groupId: 'g-ok', sessionId: 's1', profileId: 'p1' })],
        ['t-foreign', makeTab({ tabId: 't-foreign', groupId: 'g-ok', sessionId: 's1', profileId: 'p2' })],
        ['t-orphan', makeTab({ tabId: 't-orphan', groupId: 'missing-group', sessionId: 's1', profileId: 'p1' })],
      ]),
      connected: true,
      connectionId: 'connection-1',
      connectionSeq: 1,
      updatedAt: 0,
    }
    state.profiles.set('p1', snapshot)

    expect(
      listManagedGroups(state, { sessionId: 's1' }).map((group) => {
        return group.groupId
      }),
    ).toEqual(['g-ok'])
    expect(
      listManagedTabs(state, { sessionId: 's1' }).map((tab) => {
        return tab.tabId
      }),
    ).toEqual(['t-ok'])
    expect(findManagedGroup(state, 'g-foreign')).toBeNull()
    expect(findManagedTab(state, 't-foreign')).toBeNull()
    expect(findManagedTab(state, 't-orphan')).toBeNull()
  })
})

describe('managed request parsing', () => {
  test('rejects unknown kinds, fields and disallowed urls', () => {
    expect(
      parseBrowserRequest({ requestId: 'r', sessionId: 's', operation: { kind: 'page.click' } }),
    ).toMatchObject({ ok: false })
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'page.navigate', tabId: 't', url: 'data:text/html,hi' },
      }),
    ).toMatchObject({ ok: false, message: expect.stringContaining('disallowed URL scheme') })
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'groups.list', profileId: 12 },
      }),
    ).toMatchObject({ ok: false })
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'tab.resolve', tabId: 't' },
      }),
    ).toMatchObject({ ok: true })
  })

  test('accepts existing-tab operations and keeps their new optional fields', () => {
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'tabs.discover', query: 'invoice', includeManaged: false },
      }),
    ).toMatchObject({ ok: true })
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'tabs.attach', candidateId: 'pcdt:profile-1:epoch-a:7' },
      }),
    ).toMatchObject({ ok: true })
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'page.back', tabId: 't' },
      }),
    ).toMatchObject({ ok: true })
    // Unknown fields stay rejected so a typo cannot be silently ignored.
    expect(
      parseBrowserRequest({
        requestId: 'r',
        sessionId: 's',
        operation: { kind: 'tabs.attach', candidate: 'nope' },
      }),
    ).toMatchObject({ ok: false })
  })

  test('inventory parsing keeps the in-place origin and the source tab of a popup', () => {
    const parsed = parseBrowserInventory(
      makeInventory({
        groups: [makeGroup({ groupId: 'g1', sessionId: 's1', origin: 'existing' })],
        tabs: [makeTab({ tabId: 't1', groupId: 'g1', sessionId: 's1', origin: 'existing', sourceTabId: 't0' })],
      }),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.groups[0]?.origin).toBe('existing')
    expect(parsed.value.tabs[0]?.origin).toBe('existing')
    expect(parsed.value.tabs[0]?.sourceTabId).toBe('t0')
  })
})

// ---------------------------------------------------------------------------
// Existing tab discovery and in-place attach
// ---------------------------------------------------------------------------

function makeCandidate(options: {
  profileId: string
  browserEpoch: string
  chromeTabId: number
  windowId: number
  title: string
  url: string
  active?: boolean
  windowFocused?: boolean
}): BrowserTabCandidate {
  return {
    candidateId: buildTabCandidateId(options),
    profileId: options.profileId,
    profileLabel: '',
    browser: '',
    browserEpoch: options.browserEpoch,
    windowId: options.windowId,
    active: options.active ?? false,
    windowFocused: options.windowFocused ?? false,
    chromeTabId: options.chromeTabId,
    url: options.url,
    title: options.title,
    managed: false,
    ownedByThisSession: false,
    attachable: true,
  }
}

describe('existing tab discovery and in-place attach', () => {
  test('discovery fans out to every connected profile and keeps real identifiers', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const first = await connectTrackedExtension({ port: relay.port, installId: 'profile-1', email: 'work@example.com' })
    const second = await connectTrackedExtension({ port: relay.port, installId: 'profile-2', email: 'home@example.com' })
    first.sendInventory(makeInventory({ groups: [], tabs: [] }))
    second.sendInventory(makeInventory({ profileId: 'profile-2', groups: [], tabs: [] }))
    await waitForExtensionCount({ port: relay.port, count: 2 })

    first.onRequest = (request) => {
      return {
        requestId: request.requestId,
        ok: true,
        data: {
          candidates: [
            makeCandidate({
              profileId: 'profile-1',
              browserEpoch: 'epoch-1',
              chromeTabId: 7,
              windowId: 3,
              title: 'Invoice draft',
              url: 'https://billing.example.com/draft',
              active: true,
            }),
          ],
        },
      }
    }
    second.onRequest = (request) => {
      return {
        requestId: request.requestId,
        ok: true,
        data: {
          candidates: [
            makeCandidate({
              profileId: 'profile-2',
              browserEpoch: 'epoch-1',
              chromeTabId: 9,
              windowId: 4,
              title: 'Invoice draft',
              url: 'https://billing.example.com/draft',
              windowFocused: true,
            }),
          ],
        },
      }
    }

    const discovered = await browserRequest({
      port: relay.port,
      request: { requestId: 'discover-1', sessionId: 's1', operation: { kind: 'tabs.discover', query: 'invoice' } },
    })
    expect(discovered.status).toBe(200)
    expect(discovered.body).toMatchObject({ ok: true })
    const data = (discovered.body as { data: BrowserResultData }).data
    // Both profiles are named so Pi can tell two same-titled tabs apart, and
    // each entry keeps its own window + active/focus state (no global "current").
    expect(data.candidates?.map((candidate) => {
      return {
        candidateId: candidate.candidateId,
        profileLabel: candidate.profileLabel,
        browser: candidate.browser,
        windowId: candidate.windowId,
        active: candidate.active,
        windowFocused: candidate.windowFocused,
      }
    })).toMatchInlineSnapshot(`
      [
        {
          "active": true,
          "browser": "Chrome",
          "candidateId": "pcdt:profile-1:epoch-1:7",
          "profileLabel": "work@example.com",
          "windowFocused": false,
          "windowId": 3,
        },
        {
          "active": false,
          "browser": "Chrome",
          "candidateId": "pcdt:profile-2:epoch-1:9",
          "profileLabel": "home@example.com",
          "windowFocused": true,
          "windowId": 4,
        },
      ]
    `)

    const filtered = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'discover-2',
        sessionId: 's1',
        operation: { kind: 'tabs.discover', profileId: 'profile-2' },
      },
    })
    const filteredData = (filtered.body as { data: BrowserResultData }).data
    expect(filteredData.candidates).toHaveLength(1)
    expect(filteredData.candidates?.[0]?.profileId).toBe('profile-2')
    expect(first.received.filter((request) => request.operation.kind === 'tabs.discover')).toHaveLength(1)
    expect(second.received.filter((request) => request.operation.kind === 'tabs.discover')).toHaveLength(2)
  })

  test('attach routes by the candidate profile and refuses a stale browser epoch', async () => {
    const relay = await startTrackedRelay({ poolFactory: async () => createTestPool() })
    const extension = await connectTrackedExtension({ port: relay.port, installId: 'profile-1' })
    extension.sendInventory(makeInventory({ groups: [], tabs: [] }))
    await waitForCondition(
      () => {
        return relay.logs.some((line) => {
          return line.includes('inventory profile=profile-1')
        })
      },
      { message: 'inventory accepted' },
    )
    extension.onRequest = (request) => {
      return {
        requestId: request.requestId,
        ok: true,
        data: { tab: makeTab({ tabId: 'pt-1', groupId: 'pg-1', sessionId: 's1', origin: 'existing' }) },
      }
    }

    const attached = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'attach-1',
        sessionId: 's1',
        operation: {
          kind: 'tabs.attach',
          candidateId: buildTabCandidateId({ profileId: 'profile-1', browserEpoch: 'epoch-1', chromeTabId: 7 }),
        },
      },
    })
    expect(attached.body).toMatchObject({ ok: true, data: { tab: { tabId: 'pt-1', sessionId: 's1' } } })
    expect(extension.received).toHaveLength(1)

    // Chrome tab ids are only valid inside one browser run: a discovery from a
    // previous epoch must never attach whatever now owns that id.
    const stale = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'attach-2',
        sessionId: 's1',
        operation: {
          kind: 'tabs.attach',
          candidateId: buildTabCandidateId({ profileId: 'profile-1', browserEpoch: 'epoch-0', chromeTabId: 7 }),
        },
      },
    })
    expect(stale.status).toBe(200)
    expect(stale.body).toMatchObject({
      ok: false,
      error: { code: 'stale-snapshot', outcome: 'not-started' },
    })
    expect(extension.received).toHaveLength(1)

    const garbage = await browserRequest({
      port: relay.port,
      request: {
        requestId: 'attach-3',
        sessionId: 's1',
        operation: { kind: 'tabs.attach', candidateId: 'not-a-discovery' },
      },
    })
    expect(garbage.body).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    expect(extension.received).toHaveLength(1)
  })
})
