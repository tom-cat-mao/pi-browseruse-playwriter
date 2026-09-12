import type {
  BrowserJson,
  BrowserNetworkCaptureMetadata,
  BrowserResultData,
  BrowserTab,
} from 'playwriter/src/browser-protocol'
import type { FirefoxApi, FirefoxResponseFilter, FirefoxWebRequestDetails } from './firefox-api'
import { firefoxId } from './firefox-resources'

const MAX_REQUESTS = 200
const MAX_BODY_BYTES = 64 * 1024
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
const BODY_NOTE =
  'Capture includes requests observed after start. Text request/response bodies are bounded; binary, cached, service-worker and privileged responses may be unavailable.'

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
  retainedBytes: number
  filter?: string
  reason?: string
}

interface PendingRequest {
  capture: Capture
  row: NetworkRow
  stream?: FirefoxResponseFilter
  chunks: Uint8Array[]
  length: number
}

export class FirefoxNetwork {
  private readonly api: FirefoxApi
  private readonly lookup: (browserTabId: number) => BrowserTab | undefined
  private readonly captures = new Map<string, Capture>()
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
    if (!capture || (capture.filter && !details.url.includes(capture.filter))) return
    const previous = this.pending.get(details.requestId)
    if (previous) this.detach(previous)
    while (capture.rows.length >= MAX_REQUESTS) {
      const dropped = capture.rows.shift()
      if (!dropped) break
      capture.droppedCount += 1
      capture.retainedBytes = Math.max(
        0,
        capture.retainedBytes - (dropped.responseBody?.length ?? 0) - (dropped.requestBody?.length ?? 0),
      )
      const pending = this.pending.get(dropped.requestId)
      if (pending?.row === dropped) {
        this.detach(pending)
        this.pending.delete(dropped.requestId)
      }
    }
    const row: NetworkRow = {
      requestId: details.requestId,
      url: details.url.slice(0, 8192),
      method: details.method,
      type: details.type,
      startedAt: details.timeStamp,
    }
    if (details.requestBody?.formData) {
      row.requestBody = JSON.stringify(details.requestBody.formData).slice(0, MAX_BODY_BYTES)
    } else if (details.requestBody?.raw) {
      const decoder = new TextDecoder()
      let body = ''
      for (const part of details.requestBody.raw) {
        if (part.bytes && body.length < MAX_BODY_BYTES)
          body += decoder.decode(new Uint8Array(part.bytes).subarray(0, MAX_BODY_BYTES - body.length))
      }
      if (body) row.requestBody = body
    }
    if (row.requestBody) {
      row.requestBody = row.requestBody.slice(0, Math.max(0, MAX_CAPTURE_BYTES - capture.retainedBytes))
      capture.retainedBytes += row.requestBody.length
    }
    capture.rows.push(row)
    const pending: PendingRequest = { capture, row, chunks: [], length: 0 }
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
        const room = Math.min(
          MAX_BODY_BYTES - pending.length,
          MAX_CAPTURE_BYTES - capture.retainedBytes - pending.length,
        )
        if (room > 0) {
          const part = new Uint8Array(event.data).slice(0, room)
          pending.chunks.push(part)
          pending.length += part.byteLength
        }
        if (event.data.byteLength > room) row.bodyTruncated = true
      }
      stream.onstop = () => {
        try {
          if (
            this.current(browserTabId) === capture &&
            (!row.contentType ||
              /^(text\/|application\/(?:[\w.+-]*json|[\w.+-]*xml|javascript|x-www-form-urlencoded))/i.test(
                row.contentType,
              ))
          ) {
            const bytes = new Uint8Array(pending.length)
            let offset = 0
            for (const chunk of pending.chunks) {
              bytes.set(chunk, offset)
              offset += chunk.byteLength
            }
            row.responseBody = new TextDecoder().decode(bytes).slice(0, MAX_CAPTURE_BYTES - capture.retainedBytes)
            capture.retainedBytes += row.responseBody.length
          } else {
            row.bodyUnavailable = row.contentType
              ? 'Non-text response body is not retained'
              : 'Capture ended before the response body completed'
          }
        } finally {
          pending.chunks = []
          pending.stream = undefined
          stream.close()
        }
      }
      stream.onerror = () => {
        row.bodyUnavailable = 'Firefox could not provide the response stream (for example cached or privileged content)'
        pending.chunks = []
        pending.stream = undefined
      }
    } catch {
      row.bodyUnavailable = 'Firefox did not allow capturing this response body'
    }
  }

  private headers(details: FirefoxWebRequestDetails): void {
    const pending = this.pending.get(details.requestId)
    if (!pending || this.current(details.tabId) !== pending.capture) return
    pending.row.status = details.statusCode
    pending.row.contentType = details.responseHeaders?.find((header) => {
      return header.name.toLowerCase() === 'content-type'
    })?.value
  }

  private complete(details: FirefoxWebRequestDetails): void {
    const pending = this.pending.get(details.requestId)
    if (!pending) return
    if (this.current(details.tabId) === pending.capture) {
      pending.row.status = details.statusCode ?? pending.row.status
      pending.row.error = details.error
      pending.row.durationMs = Math.max(0, details.timeStamp - pending.row.startedAt)
    }
    this.pending.delete(details.requestId)
  }

  private detach(pending: PendingRequest): void {
    try {
      if (pending.stream) {
        pending.stream.ondata = null
        pending.stream.onstop = null
        pending.stream.onerror = null
        pending.stream.disconnect()
      }
    } catch {
      /* Already closed by Firefox. */
    }
    pending.stream = undefined
    pending.chunks = []
  }

  stopTab(options: { tabId: string; reason?: string; release?: boolean }): void {
    const capture = this.captures.get(options.tabId)
    if (!capture) return
    capture.status = options.reason ? 'interrupted' : 'stopped'
    capture.reason = options.reason
    for (const [id, pending] of this.pending) {
      if (pending.capture !== capture) continue
      pending.row.bodyUnavailable ??= 'Capture stopped before the response completed'
      this.detach(pending)
      this.pending.delete(id)
    }
    if (options.release) this.captures.delete(options.tabId)
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
    if (action === 'start' && capture?.status !== 'active') {
      this.stopTab({ tabId: tab.tabId, release: true })
      capture = {
        tabId: tab.tabId,
        sessionId: tab.sessionId,
        browserTabId: tab.browserTabId!,
        captureId: firefoxId('capture'),
        status: 'active',
        rows: [],
        retainedBytes: 0,
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
