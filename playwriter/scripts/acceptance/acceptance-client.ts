/**
 * HTTP/CDP client helpers for the acceptance harness.
 *
 * The harness only talks to the user-specified test runtime through the real
 * /browser/v1 HTTP API (plus an optional Chrome DevTools cross-check). It never
 * connects to port 19988 by default, never launches Chrome, and never uses
 * Playwright, so nothing here can create or adopt browser resources on its own.
 */

import type {
  BrowserCapabilities,
  BrowserProfile,
  BrowserRequest,
  BrowserResponse,
} from '../../src/browser-protocol.ts'

export type RuntimeEndpoint = {
  baseUrl: string
  token: string | null
}

export class AcceptanceHttpError extends Error {
  readonly status: number
  readonly body: string

  constructor({ message, status, body, cause }: { message: string; status: number; body: string; cause?: unknown }) {
    super(message, cause == null ? undefined : { cause })
    this.name = 'AcceptanceHttpError'
    this.status = status
    this.body = body
  }
}

export class AcceptanceTimeoutError extends Error {
  readonly lastDetail: string

  constructor({ message, lastDetail }: { message: string; lastDetail: string }) {
    super(message)
    this.name = 'AcceptanceTimeoutError'
    this.lastDetail = lastDetail
  }
}

function authHeaders({ token }: { token: string | null }): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

function withTimeoutSignal({ signal, timeoutMs }: { signal?: AbortSignal; timeoutMs: number }): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

async function fetchOrThrow({ url, init, timeoutMs }: { url: string; init: RequestInit; timeoutMs: number }): Promise<Response> {
  try {
    return await fetch(url, init)
  } catch (error) {
    const cause = error instanceof Error && error.cause ? error.cause : null
    const causeText = cause instanceof Error ? `; cause: ${cause.message}` : cause ? `; cause: ${String(cause)}` : ''
    const reason = error instanceof Error ? `${error.name}: ${error.message}${causeText}` : String(error)
    throw new AcceptanceHttpError({
      message: `request to ${url} failed within ${timeoutMs}ms (${reason})`,
      status: 0,
      body: reason,
      cause: error,
    })
  }
}

export async function callBrowserApi({
  endpoint,
  request,
  timeoutMs,
  signal,
}: {
  endpoint: RuntimeEndpoint
  request: BrowserRequest
  timeoutMs: number
  signal?: AbortSignal
}): Promise<BrowserResponse> {
  const url = new URL('/browser/v1/request', endpoint.baseUrl).toString()
  const response = await fetchOrThrow({
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders({ token: endpoint.token }) },
      body: JSON.stringify(request),
      signal: withTimeoutSignal({ signal, timeoutMs }),
    },
    timeoutMs,
  })
  const bodyText = await response.text()
  if (!response.ok) {
    throw new AcceptanceHttpError({
      message: `POST /browser/v1/request failed with HTTP ${response.status}`,
      status: response.status,
      body: bodyText,
    })
  }
  try {
    return JSON.parse(bodyText) as BrowserResponse
  } catch (error) {
    throw new AcceptanceHttpError({
      message: 'POST /browser/v1/request returned malformed JSON',
      status: response.status,
      body: bodyText,
      cause: error,
    })
  }
}

export async function getCapabilities({
  endpoint,
  timeoutMs,
  signal,
}: {
  endpoint: RuntimeEndpoint
  timeoutMs: number
  signal?: AbortSignal
}): Promise<BrowserCapabilities> {
  const url = new URL('/browser/v1/capabilities', endpoint.baseUrl).toString()
  const response = await fetchOrThrow({
    url,
    init: { headers: authHeaders({ token: endpoint.token }), signal: withTimeoutSignal({ signal, timeoutMs }) },
    timeoutMs,
  })
  const bodyText = await response.text()
  if (!response.ok) {
    throw new AcceptanceHttpError({
      message: `GET /browser/v1/capabilities failed with HTTP ${response.status}`,
      status: response.status,
      body: bodyText,
    })
  }
  try {
    return JSON.parse(bodyText) as BrowserCapabilities
  } catch (error) {
    throw new AcceptanceHttpError({
      message: 'GET /browser/v1/capabilities returned malformed JSON',
      status: response.status,
      body: bodyText,
      cause: error,
    })
  }
}

export async function listProfiles({
  endpoint,
  timeoutMs,
  signal,
}: {
  endpoint: RuntimeEndpoint
  timeoutMs: number
  signal?: AbortSignal
}): Promise<BrowserProfile[]> {
  const url = new URL('/browser/v1/profiles', endpoint.baseUrl).toString()
  const response = await fetchOrThrow({
    url,
    init: { headers: authHeaders({ token: endpoint.token }), signal: withTimeoutSignal({ signal, timeoutMs }) },
    timeoutMs,
  })
  const bodyText = await response.text()
  if (!response.ok) {
    throw new AcceptanceHttpError({
      message: `GET /browser/v1/profiles failed with HTTP ${response.status}`,
      status: response.status,
      body: bodyText,
    })
  }
  try {
    const parsed = JSON.parse(bodyText) as { profiles?: BrowserProfile[] }
    return parsed.profiles || []
  } catch (error) {
    throw new AcceptanceHttpError({
      message: 'GET /browser/v1/profiles returned malformed JSON',
      status: response.status,
      body: bodyText,
      cause: error,
    })
  }
}

export type RuntimeProbe =
  | { state: 'ready'; detail: string }
  | { state: 'unauthorized'; detail: string }
  | { state: 'down'; detail: string }
  | { state: 'error'; detail: string }

export async function probeRuntime({
  endpoint,
  timeoutMs,
}: {
  endpoint: RuntimeEndpoint
  timeoutMs: number
}): Promise<RuntimeProbe> {
  try {
    const capabilities = await getCapabilities({ endpoint, timeoutMs })
    return { state: 'ready', detail: `protocolVersion=${capabilities.protocolVersion}` }
  } catch (error) {
    if (error instanceof AcceptanceHttpError && error.status === 401) {
      return { state: 'unauthorized', detail: 'runtime answered 401 for the configured token' }
    }
    if (error instanceof AcceptanceHttpError) {
      return { state: 'error', detail: `HTTP ${error.status}: ${error.body.slice(0, 200)}` }
    }
    return { state: 'down', detail: error instanceof Error ? error.message : String(error) }
  }
}

export async function pollUntil<T>({
  description,
  timeoutMs,
  intervalMs,
  check,
  signal,
}: {
  description: string
  timeoutMs: number
  intervalMs: number
  check: () => Promise<{ done: true; value: T } | { done: false; detail: string }>
  signal?: AbortSignal
}): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastDetail = 'no attempt made'
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new AcceptanceTimeoutError({ message: `polling aborted: ${description}`, lastDetail })
    }
    const result = await check()
    if (result.done) {
      return result.value
    }
    lastDetail = result.detail
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs)
    })
  }
  throw new AcceptanceTimeoutError({ message: `timed out waiting for ${description}`, lastDetail })
}

export type ChromeTargetInfo = {
  targetId: string
  type: string
  url: string
}

export type ChromeTargetsResult = {
  browserWsUrl: string
  targets: ChromeTargetInfo[]
}

async function resolveBrowserWsUrl({ cdpUrl, timeoutMs }: { cdpUrl: string; timeoutMs: number }): Promise<string> {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) {
    return cdpUrl
  }
  const versionUrl = new URL('/json/version', cdpUrl).toString()
  const response = await fetchOrThrow({
    url: versionUrl,
    init: { signal: AbortSignal.timeout(timeoutMs) },
    timeoutMs,
  })
  const bodyText = await response.text()
  if (!response.ok) {
    throw new AcceptanceHttpError({
      message: `GET /json/version failed with HTTP ${response.status}`,
      status: response.status,
      body: bodyText,
    })
  }
  const parsed = JSON.parse(bodyText) as { webSocketDebuggerUrl?: string }
  if (!parsed.webSocketDebuggerUrl) {
    throw new AcceptanceHttpError({
      message: 'Chrome /json/version did not include webSocketDebuggerUrl',
      status: response.status,
      body: bodyText,
    })
  }
  return parsed.webSocketDebuggerUrl
}

/**
 * Optional independent cross-check: ask the isolated Chrome itself which
 * targets exist. Group membership is not exposed over CDP, so this only proves
 * that recorded targetIds really exist in the browser the user opened.
 */
export async function fetchChromeTargets({
  cdpUrl,
  timeoutMs,
}: {
  cdpUrl: string
  timeoutMs: number
}): Promise<ChromeTargetsResult> {
  const browserWsUrl = await resolveBrowserWsUrl({ cdpUrl, timeoutMs })
  const socket = new WebSocket(browserWsUrl)
  const targets = await new Promise<ChromeTargetInfo[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new AcceptanceTimeoutError({ message: 'CDP Target.getTargets timed out', lastDetail: browserWsUrl }))
    }, timeoutMs)
    socket.addEventListener('error', (event) => {
      clearTimeout(timer)
      reject(new AcceptanceHttpError({ message: 'CDP socket error', status: 0, body: String(event.type), cause: event }))
    })
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Target.getTargets', params: {} }))
    })
    socket.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : String(event.data)
      let parsed: { id?: number; result?: { targetInfos?: ChromeTargetInfo[] }; error?: { message?: string } }
      try {
        parsed = JSON.parse(text) as typeof parsed
      } catch (error) {
        clearTimeout(timer)
        socket.close()
        reject(
          new AcceptanceHttpError({
            message: 'CDP returned non-JSON message',
            status: 0,
            body: text.slice(0, 300),
            cause: error,
          }),
        )
        return
      }
      if (parsed.id !== 1) {
        return
      }
      clearTimeout(timer)
      socket.close()
      if (parsed.error) {
        reject(new AcceptanceHttpError({ message: `CDP error: ${parsed.error.message || 'unknown'}`, status: 0, body: text.slice(0, 300) }))
        return
      }
      resolve(parsed.result?.targetInfos || [])
    })
  })
  return { browserWsUrl, targets }
}
