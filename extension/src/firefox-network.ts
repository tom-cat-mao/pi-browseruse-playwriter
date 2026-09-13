import type {
  BrowserJson,
  BrowserNetworkCaptureMetadata,
  BrowserResultData,
  BrowserTab,
} from 'playwriter/src/browser-protocol'
import type { FirefoxApi, FirefoxResponseFilter, FirefoxWebRequestDetails } from './firefox-api'
import { FirefoxNetworkBudget } from './firefox-network-budget'
import type { FirefoxNetworkBody } from './firefox-network-budget'
import { firefoxId } from './firefox-resources'

const MAX_REQUESTS = 200
const MAX_BODY_BYTES = 64 * 1024
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const BODY_NOTE =
  'Capture includes requests observed after start. Body accounting is limited to 64 KiB per body and 2 MiB per capture, including in-flight bytes and UTF-8 bytes of retained text (not an OS memory limit); binary, cached, service-worker and privileged responses may be unavailable.'

interface NetworkRow {
  requestId: string
  url: string
  method: string
  type: string
  startedAt: number
  status?: number
  error?: string
  contentType?: string
  requestBody?: string
  responseBody?: string
  bodyTruncated?: boolean
  bodyUnavailable?: string
  durationMs?: number
}

interface Capture {
  tabId: string
  sessionId: string
  browserTabId: number
  captureId: string
  status: 'active' | 'stopped' | 'interrupted'
  rows: NetworkRow[]
  droppedCount: number
  budget: FirefoxNetworkBudget
  filter?: string
  reason?: string
}

interface PendingRequest {
  capture: Capture
  row: NetworkRow
  stream?: FirefoxResponseFilter
  body: FirefoxNetworkBody
  completed: boolean
}

export class FirefoxNetwork {
  private readonly api: FirefoxApi
  private readonly lookup: (browserTabId: number) => BrowserTab | undefined
  private readonly captures = new Map<string, Capture>()
  private readonly bodies = new WeakMap<NetworkRow, { request: FirefoxNetworkBody; response: FirefoxNetworkBody }>()
  private readonly pending = new Map<string, PendingRequest>()

  constructor(options: { api: FirefoxApi; lookup: (browserTabId: number) => BrowserTab | undefined }) {
    this.api = options.api
    this.lookup = options.lookup
    const filter = { urls: ['<all_urls>'] }
    this.api.webRequest.onBeforeRequest.addListener(
      (details) => {
        this.begin(details)
      },
      filter,
      ['requestBody', 'blocking'],
    )
    this.api.webRequest.onHeadersReceived.addListener(
      (details) => {
        this.headers(details)
      },
      filter,
      ['responseHeaders'],
    )
    this.api.webRequest.onCompleted.addListener((details) => {
      this.complete(details)
    }, filter)
    this.api.webRequest.onErrorOccurred.addListener((details) => {
      this.complete(details)
    }, filter)
  }

  private current(browserTabId: number): Capture | undefined {
    const tab = this.lookup(browserTabId)
    if (!tab) return undefined
    const capture = this.captures.get(tab.tabId)
    return capture?.status === 'active' && capture.sessionId === tab.sessionId && capture.browserTabId === browserTabId
      ? capture
      : undefined
  }

  private begin(details: FirefoxWebRequestDetails): void {
    const browserTabId = details.tabId
    const capture = this.current(browserTabId)
    const previous = this.pending.get(details.requestId)
    if (previous) {
      if (previous.stream)
        previous.row.bodyUnavailable ??= 'Request redirected or its identifier was reused before the body completed'
      this.detach(previous)
    }
    if (!capture || (capture.filter && !details.url.includes(capture.filter))) return
    while (capture.rows.length >= MAX_REQUESTS) {
      const dropped = capture.rows.shift()
      if (!dropped) break
      capture.droppedCount += 1
      const bodies = this.bodies.get(dropped)
      bodies?.request.release()
      bodies?.response.release()
      const pending = this.pending.get(dropped.requestId)
      if (pending?.row === dropped) {
        this.detach(pending)
      }
    }
    const row: NetworkRow = {
      requestId: details.requestId,
      url: details.url.slice(0, 8192),
      method: details.method,
      type: details.type,
      startedAt: details.timeStamp,
    }
    const requestBody = capture.budget.createBody(MAX_BODY_BYTES)
    const responseBody = capture.budget.createBody(MAX_BODY_BYTES)
    this.bodies.set(row, { request: requestBody, response: responseBody })
    if (details.requestBody?.formData) {
      row.requestBody = requestBody.retainText(JSON.stringify(details.requestBody.formData))
    } else if (details.requestBody?.raw) {
      for (const part of details.requestBody.raw) {
        if (part.bytes) requestBody.append(new Uint8Array(part.bytes))
      }
      row.requestBody = requestBody.finish()
    }
    if (requestBody.truncated) row.bodyTruncated = true
    capture.rows.push(row)
    const pending: PendingRequest = { capture, row, body: responseBody, completed: false }
    this.pending.set(details.requestId, pending)
    if (!this.api.webRequest.filterResponseData) {
      row.bodyUnavailable = 'Firefox response filtering API is unavailable'
      return
    }
    try {
      const stream = this.api.webRequest.filterResponseData(details.requestId)
      pending.stream = stream
      stream.ondata = (event) => {
        // Always forward bytes before doing optional inspection.
        try {
          stream.write(event.data)
        } catch {
          row.bodyUnavailable = 'Firefox ended the response stream during capture'
          this.detach(pending)
          return
        }
        if (this.current(browserTabId) !== capture) {
          this.detach(pending)
          return
        }
        if (pending.stream !== stream) return
        pending.body.append(new Uint8Array(event.data))
        if (pending.body.truncated) row.bodyTruncated = true
      }
      stream.onstop = () => {
        if (pending.stream !== stream) return
        try {
          if (
            this.current(browserTabId) === capture &&
            (!row.contentType ||
              /^(text\/|application\/(?:[\w.+-]*json|[\w.+-]*xml|javascript|x-www-form-urlencoded))/i.test(
                row.contentType,
              ))
          ) {
            row.responseBody = pending.body.finish()
            if (pending.body.truncated) row.bodyTruncated = true
          } else {
            row.bodyUnavailable = 'Non-text response or capture ended before the response body completed'
            pending.body.release()
          }
        } finally {
          pending.stream = undefined
          if (pending.completed) this.forget(pending)
          stream.close()
        }
      }
      stream.onerror = () => {
        if (pending.stream !== stream) return
        row.bodyUnavailable = 'Firefox could not provide the response stream (for example cached or privileged content)'
        pending.body.release()
        pending.stream = undefined
        if (pending.completed) this.forget(pending)
      }
    } catch {
      row.bodyUnavailable = 'Firefox did not allow capturing this response body'
    }
  }

  private headers(details: FirefoxWebRequestDetails): void {
    const pending = this.pending.get(details.requestId)
    if (
      !pending ||
      details.timeStamp < pending.row.startedAt ||
      details.url.slice(0, 8192) !== pending.row.url ||
      this.current(details.tabId) !== pending.capture
    )
      return
    pending.row.status = details.statusCode
    pending.row.contentType = details.responseHeaders?.find((header) => {
      return header.name.toLowerCase() === 'content-type'
    })?.value
  }

  private complete(details: FirefoxWebRequestDetails): void {
    const pending = this.pending.get(details.requestId)
    if (
      !pending ||
      details.tabId !== pending.capture.browserTabId ||
      details.timeStamp < pending.row.startedAt ||
      details.url.slice(0, 8192) !== pending.row.url
    )
      return
    if (this.current(details.tabId) === pending.capture) {
      pending.row.status = details.statusCode ?? pending.row.status
      pending.row.error = details.error
      pending.row.durationMs = Math.max(0, details.timeStamp - pending.row.startedAt)
    }
    pending.completed = true
    if (details.error) this.detach(pending)
    else if (!pending.stream) this.forget(pending)
  }

  private forget(pending: PendingRequest): void {
    if (this.pending.get(pending.row.requestId) === pending) this.pending.delete(pending.row.requestId)
  }

  private detach(pending: PendingRequest): void {
    const stream = pending.stream
    pending.stream = undefined
    if (stream) pending.body.release()
    this.forget(pending)
    try {
      if (stream) {
        stream.ondata = null
        stream.onstop = null
        stream.onerror = null
        stream.disconnect()
      }
    } catch {
      /* Already closed by Firefox. */
    }
  }

  stopTab(options: { tabId: string; reason?: string; release?: boolean }): void {
    const capture = this.captures.get(options.tabId)
    if (!capture) return
    capture.status = options.reason ? 'interrupted' : 'stopped'
    capture.reason = options.reason
    for (const pending of this.pending.values()) {
      if (pending.capture !== capture) continue
      if (pending.stream) pending.row.bodyUnavailable ??= 'Capture stopped before the response completed'
      this.detach(pending)
    }
    if (options.release) {
      for (const row of capture.rows) {
        const bodies = this.bodies.get(row)
        bodies?.request.release()
        bodies?.response.release()
      }
      this.captures.delete(options.tabId)
    }
  }

  interrupt(): void {
    for (const capture of this.captures.values()) {
      if (capture.status === 'active')
        this.stopTab({ tabId: capture.tabId, reason: 'The runtime connection was lost; start capture again to resume' })
    }
  }

  handle(options: { tab: BrowserTab; action: 'start' | 'list' | 'stop'; filter?: string }): BrowserResultData {
    const { tab, action } = options
    let capture = this.captures.get(tab.tabId)
    if (capture && capture.sessionId !== tab.sessionId) throw new Error('Network capture ownership mismatch')
    if (action === 'start') {
      this.stopTab({ tabId: tab.tabId, release: true })
      capture = {
        tabId: tab.tabId,
        sessionId: tab.sessionId,
        browserTabId: tab.browserTabId!,
        captureId: firefoxId('capture'),
        status: 'active',
        rows: [],
        budget: new FirefoxNetworkBudget(MAX_CAPTURE_BYTES),
        droppedCount: 0,
        filter: options.filter,
      }
      this.captures.set(tab.tabId, capture)
    }
    if (action === 'stop') this.stopTab({ tabId: tab.tabId })
    const metadata: BrowserNetworkCaptureMetadata = capture
      ? {
          status: capture.status,
          captureId: capture.captureId,
          retainedCount: capture.rows.length,
          droppedCount: capture.droppedCount,
          ...(capture.reason ? { reason: capture.reason } : {}),
        }
      : { status: 'not-started', retainedCount: 0, droppedCount: 0 }
    const rows =
      capture?.rows.filter((row) => {
        return !options.filter || row.url.includes(options.filter)
      }) ?? []
    return { text: BODY_NOTE, value: JSON.parse(JSON.stringify(rows)) as BrowserJson, networkCapture: metadata }
  }
}
