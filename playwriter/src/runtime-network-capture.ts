import crypto from 'node:crypto'
import type { BrowserNetworkCaptureMetadata, BrowserTab } from './browser-protocol.js'

export const RUNTIME_NETWORK_MAX_ENTRIES = 500
export const RUNTIME_NETWORK_MAX_BYTES = 512 * 1024
export const RUNTIME_NETWORK_MAX_CAPTURES = 64
const RUNTIME_NETWORK_MAX_PENDING_REQUESTS = 1_000
const RUNTIME_NETWORK_MAX_PENDING_BYTES = 256 * 1024

export type RuntimeNetworkEntry = {
  url: string
  method: string
  resourceType: string
  status: number
}

type PendingRequest = {
  url: string
  method: string
  resourceType: string
  responded: boolean
}

type RuntimeNetworkCapture = {
  captureId: string
  sessionId: string
  profileId: string
  tabId: string
  browserEpoch: string
  connectionId: string
  targetId: string
  cdpSessionId: string
  filter?: string
  status: 'active' | 'stopped' | 'interrupted'
  reason?: string
  entries: RuntimeNetworkEntry[]
  retainedBytes: number
  droppedCount: number
  pendingRequests: Map<string, PendingRequest>
  pendingBytes: number
}

export type RuntimeNetworkCaptureResult = {
  entries: RuntimeNetworkEntry[]
  metadata: BrowserNetworkCaptureMetadata
}

export class RuntimeNetworkCaptureLimitError extends Error {
  constructor() {
    super(`Runtime network capture limit of ${RUNTIME_NETWORK_MAX_CAPTURES} has been reached`)
    this.name = 'RuntimeNetworkCaptureLimitError'
  }
}

function captureKey({ sessionId, tabId }: { sessionId: string; tabId: string }): string {
  return `${sessionId}\u0000${tabId}`
}

function entryBytes(entry: RuntimeNetworkEntry): number {
  return Buffer.byteLength(JSON.stringify(entry), 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export class RuntimeNetworkCaptureStore {
  private readonly captures = new Map<string, RuntimeNetworkCapture>()

  start({
    sessionId,
    profileId,
    tab,
    connectionId,
    filter,
  }: {
    sessionId: string
    profileId: string
    tab: BrowserTab
    connectionId: string
    filter?: string
  }): RuntimeNetworkCaptureResult {
    const key = captureKey({ sessionId, tabId: tab.tabId })
    if (!this.captures.has(key) && this.captures.size >= RUNTIME_NETWORK_MAX_CAPTURES) {
      throw new RuntimeNetworkCaptureLimitError()
    }
    this.captures.delete(key)
    const capture: RuntimeNetworkCapture = {
      captureId: crypto.randomUUID(),
      sessionId,
      profileId,
      tabId: tab.tabId,
      browserEpoch: tab.browserEpoch,
      connectionId,
      targetId: tab.targetId ?? '',
      cdpSessionId: tab.cdpSessionId ?? '',
      ...(filter !== undefined ? { filter } : {}),
      status: 'active',
      entries: [],
      retainedBytes: 0,
      droppedCount: 0,
      pendingRequests: new Map(),
      pendingBytes: 0,
    }
    this.captures.set(key, capture)
    return this.result(capture)
  }

  canStart({ sessionId, tabId }: { sessionId: string; tabId: string }): boolean {
    return this.captures.has(captureKey({ sessionId, tabId })) || this.captures.size < RUNTIME_NETWORK_MAX_CAPTURES
  }

  list({ sessionId, tabId, filter }: { sessionId: string; tabId: string; filter?: string }): RuntimeNetworkCaptureResult {
    const capture = this.captures.get(captureKey({ sessionId, tabId }))
    if (!capture) {
      return this.notStarted()
    }
    return this.result(capture, filter)
  }

  stop({ sessionId, tabId, filter }: { sessionId: string; tabId: string; filter?: string }): RuntimeNetworkCaptureResult {
    const capture = this.captures.get(captureKey({ sessionId, tabId }))
    if (!capture) {
      return this.notStarted()
    }
    if (capture.status === 'active') {
      capture.status = 'stopped'
      capture.pendingRequests.clear()
      capture.pendingBytes = 0
    }
    return this.result(capture, filter)
  }

  handleEvent({
    connectionId,
    rootCdpSessionId,
    sourceCdpSessionId,
    method,
    params,
  }: {
    connectionId: string
    rootCdpSessionId?: string
    sourceCdpSessionId?: string
    method: string
    params: unknown
  }): void {
    if (!rootCdpSessionId) {
      return
    }
    const captures = Array.from(this.captures.values()).filter((capture) => {
      return (
        capture.status === 'active' &&
        capture.connectionId === connectionId &&
        capture.cdpSessionId === rootCdpSessionId
      )
    })
    captures.map((capture) => {
      this.applyEvent({ capture, sourceCdpSessionId: sourceCdpSessionId ?? rootCdpSessionId, method, params })
    })
  }

  reconcileProfile({
    profileId,
    connectionId,
    browserEpoch,
    tabs,
  }: {
    profileId: string
    connectionId: string
    browserEpoch: string
    tabs: Map<string, BrowserTab>
  }): void {
    Array.from(this.captures.entries())
      .filter(([, capture]) => {
        return capture.profileId === profileId
      })
      .map(([key, capture]) => {
        const tab = tabs.get(capture.tabId)
        if (!tab || tab.sessionId !== capture.sessionId || tab.state === 'released') {
          this.captures.delete(key)
          return
        }
        if (tab.state !== 'ready') {
          this.interruptCapture(capture, `tab state changed to ${tab.state}`)
          return
        }
        if (
          tab.browserEpoch !== capture.browserEpoch ||
          browserEpoch !== capture.browserEpoch ||
          tab.targetId !== capture.targetId ||
          tab.cdpSessionId !== capture.cdpSessionId
        ) {
          this.interruptCapture(capture, 'tab target or browser epoch changed')
          return
        }
        if (capture.connectionId !== connectionId) {
          this.interruptCapture(capture, 'extension connection changed')
        }
      })
  }

  interruptProfile({ profileId, reason }: { profileId: string; reason: string }): void {
    Array.from(this.captures.values())
      .filter((capture) => {
        return capture.profileId === profileId
      })
      .map((capture) => {
        this.interruptCapture(capture, reason)
      })
  }

  deleteSession(sessionId: string): void {
    Array.from(this.captures.entries())
      .filter(([, capture]) => {
        return capture.sessionId === sessionId
      })
      .map(([key]) => {
        this.captures.delete(key)
      })
  }

  deleteTab({ sessionId, tabId }: { sessionId: string; tabId: string }): void {
    this.captures.delete(captureKey({ sessionId, tabId }))
  }

  clear(): void {
    this.captures.clear()
  }

  private applyEvent({
    capture,
    sourceCdpSessionId,
    method,
    params,
  }: {
    capture: RuntimeNetworkCapture
    sourceCdpSessionId: string
    method: string
    params: unknown
  }): void {
    if (!isRecord(params) || typeof params.requestId !== 'string') {
      return
    }
    if (method === 'Network.requestWillBeSent') {
      const request = isRecord(params.request) ? params.request : null
      if (!request || typeof request.url !== 'string' || typeof request.method !== 'string') {
        return
      }
      const scopedRequestId = `${sourceCdpSessionId}\u0000${params.requestId}`
      const previous = capture.pendingRequests.get(scopedRequestId)
      const redirectResponse = isRecord(params.redirectResponse) ? params.redirectResponse : null
      if (previous && !previous.responded && redirectResponse && typeof redirectResponse.status === 'number') {
        this.appendEntry(capture, { ...previous, status: redirectResponse.status })
      }
      const resourceType = typeof params.type === 'string' ? params.type.toLowerCase() : 'other'
      if (previous) {
        capture.pendingBytes -= this.pendingRequestBytes(previous)
      }
      const pendingRequest: PendingRequest = {
        url: request.url,
        method: request.method,
        resourceType,
        responded: false,
      }
      capture.pendingRequests.set(scopedRequestId, pendingRequest)
      capture.pendingBytes += this.pendingRequestBytes(pendingRequest)
      this.prunePendingRequests(capture)
      return
    }
    if (method === 'Network.responseReceived') {
      const scopedRequestId = `${sourceCdpSessionId}\u0000${params.requestId}`
      const pending = capture.pendingRequests.get(scopedRequestId)
      const response = isRecord(params.response) ? params.response : null
      if (!pending || pending.responded || !response || typeof response.status !== 'number') {
        return
      }
      const url = typeof response.url === 'string' ? response.url : pending.url
      const resourceType = typeof params.type === 'string' ? params.type.toLowerCase() : pending.resourceType
      this.appendEntry(capture, { url, method: pending.method, resourceType, status: response.status })
      capture.pendingBytes -= this.pendingRequestBytes(pending)
      pending.responded = true
      capture.pendingBytes += this.pendingRequestBytes(pending)
      return
    }
    if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      const scopedRequestId = `${sourceCdpSessionId}\u0000${params.requestId}`
      const pending = capture.pendingRequests.get(scopedRequestId)
      if (pending) {
        capture.pendingBytes -= this.pendingRequestBytes(pending)
        capture.pendingRequests.delete(scopedRequestId)
      }
    }
  }

  private appendEntry(capture: RuntimeNetworkCapture, entry: RuntimeNetworkEntry): void {
    if (capture.filter && !entry.url.includes(capture.filter)) {
      return
    }
    const bytes = entryBytes(entry)
    if (bytes > RUNTIME_NETWORK_MAX_BYTES) {
      capture.droppedCount += 1
      return
    }
    capture.entries.push(entry)
    capture.retainedBytes += bytes
    while (
      capture.entries.length > RUNTIME_NETWORK_MAX_ENTRIES ||
      capture.retainedBytes > RUNTIME_NETWORK_MAX_BYTES
    ) {
      const dropped = capture.entries.shift()
      if (!dropped) {
        break
      }
      capture.retainedBytes -= entryBytes(dropped)
      capture.droppedCount += 1
    }
  }

  private prunePendingRequests(capture: RuntimeNetworkCapture): void {
    while (
      capture.pendingRequests.size > RUNTIME_NETWORK_MAX_PENDING_REQUESTS ||
      capture.pendingBytes > RUNTIME_NETWORK_MAX_PENDING_BYTES
    ) {
      const oldest = capture.pendingRequests.keys().next().value
      if (oldest === undefined) {
        return
      }
      const dropped = capture.pendingRequests.get(oldest)
      if (dropped) {
        capture.pendingBytes -= this.pendingRequestBytes(dropped)
        capture.droppedCount += 1
      }
      capture.pendingRequests.delete(oldest)
    }
  }

  private pendingRequestBytes(request: PendingRequest): number {
    return Buffer.byteLength(JSON.stringify(request), 'utf8')
  }

  private interruptCapture(capture: RuntimeNetworkCapture, reason: string): void {
    if (capture.status !== 'active') {
      return
    }
    capture.status = 'interrupted'
    capture.reason = reason
    capture.pendingRequests.clear()
    capture.pendingBytes = 0
  }

  private result(capture: RuntimeNetworkCapture, filter?: string): RuntimeNetworkCaptureResult {
    const entries = filter
      ? capture.entries.filter((entry) => {
          return entry.url.includes(filter)
        })
      : [...capture.entries]
    return {
      entries,
      metadata: {
        status: capture.status,
        captureId: capture.captureId,
        retainedCount: capture.entries.length,
        droppedCount: capture.droppedCount,
        ...(capture.reason
          ? { reason: capture.reason }
          : capture.droppedCount > 0
            ? {
                reason: `Oldest metadata was dropped at the ${RUNTIME_NETWORK_MAX_ENTRIES} entry or ${RUNTIME_NETWORK_MAX_BYTES} byte capture limit.`,
              }
            : {}),
      },
    }
  }

  private notStarted(): RuntimeNetworkCaptureResult {
    return {
      entries: [],
      metadata: {
        status: 'not-started',
        retainedCount: 0,
        droppedCount: 0,
        reason: `No retained capture. Limits: ${RUNTIME_NETWORK_MAX_CAPTURES} captures, ${RUNTIME_NETWORK_MAX_ENTRIES} entries and ${RUNTIME_NETWORK_MAX_BYTES} bytes per capture.`,
      },
    }
  }
}
