import type { FirefoxNavigationDetails, FirefoxTab, FirefoxApi } from './firefox-api'

export type FirefoxNavigationSignal = 'before' | 'committed' | 'completed' | 'history' | 'fragment' | 'error'
export type FirefoxNavigationResult =
  | { status: 'complete'; details: FirefoxNavigationDetails }
  | { status: 'failed'; message: string }

export class FirefoxNavigationState {
  private readonly tabId: number
  private armed = false
  private stopped = false
  private started = false
  private committed?: FirefoxNavigationDetails
  private latestTime = -Infinity
  private targetUrl?: string
  private readonly supersededDocuments = new Set<string>()
  private readonly supersededUrls = new Set<string>()
  private pendingAbort?: FirefoxNavigationDetails
  private confirmation?: { candidate: FirefoxNavigationResult; documentId?: string; timeStamp: number }
  result?: FirefoxNavigationResult

  constructor(tabId: number) {
    this.tabId = tabId
  }

  arm(timeStamp: number): void {
    if (this.stopped) return
    this.latestTime = timeStamp
    this.armed = true
  }

  observe(options: { signal: FirefoxNavigationSignal; details: FirefoxNavigationDetails }): void {
    const { signal, details } = options
    if (!this.armed || this.result?.status === 'failed' || details.tabId !== this.tabId || details.frameId !== 0) return
    if (details.timeStamp < this.latestTime) return
    if (signal === 'before' || signal === 'committed') {
      if (this.pendingAbort) {
        const replaced =
          details.url !== this.pendingAbort.url ||
          (details.documentId !== undefined &&
            this.pendingAbort.documentId !== undefined &&
            details.documentId !== this.pendingAbort.documentId)
        if (replaced) this.pendingAbort = undefined
      }
      this.result = undefined
      this.confirmation = undefined
    }
    if (signal === 'before') {
      if (this.committed?.documentId) this.supersededDocuments.add(this.committed.documentId)
      if (this.committed) this.supersededUrls.add(this.committed.url)
      if (this.targetUrl) this.supersededUrls.add(this.targetUrl)
      this.targetUrl = details.url
      this.started = true
      this.committed = undefined
      this.latestTime = details.timeStamp
      return
    }
    if (signal === 'committed') {
      this.started = true
      this.committed = details
      this.latestTime = details.timeStamp
      return
    }
    if (signal === 'history' || signal === 'fragment') {
      if (!this.started) {
        this.latestTime = details.timeStamp
        this.result = { status: 'complete', details }
      } else if (this.committed) {
        if (
          details.documentId !== undefined &&
          this.committed.documentId !== undefined &&
          details.documentId !== this.committed.documentId
        )
          return
        if (
          this.committed.documentId === undefined &&
          details.documentId !== undefined &&
          this.supersededDocuments.has(details.documentId)
        )
          return
        this.committed = { ...this.committed, url: details.url }
        if (this.result?.status === 'complete') this.result = { status: 'complete', details }
        this.latestTime = details.timeStamp
      }
      return
    }
    if (signal === 'error' && this.started) {
      if (this.committed?.documentId !== undefined && details.documentId !== undefined) {
        if (this.committed.documentId !== details.documentId) return
      } else {
        if (details.documentId !== undefined && this.supersededDocuments.has(details.documentId)) return
        if (details.url !== (this.committed?.url ?? this.targetUrl) || this.supersededUrls.has(details.url)) return
      }
      if (details.error === 'Error code 2152398850') {
        this.pendingAbort = details
        this.result = undefined
        this.confirmation = undefined
        this.latestTime = details.timeStamp
        return
      }
      this.result = { status: 'failed', message: details.error ?? 'Firefox navigation failed' }
      return
    }
    if (signal !== 'completed' || !this.committed) return
    if (
      this.committed.documentId === undefined &&
      details.documentId !== undefined &&
      this.supersededDocuments.has(details.documentId)
    )
      return
    if (
      this.committed.documentId !== undefined &&
      details.documentId !== undefined &&
      this.committed.documentId !== details.documentId
    )
      return
    if (
      (this.committed.documentId === undefined || details.documentId === undefined) &&
      this.committed.url !== details.url
    )
      return
    this.latestTime = details.timeStamp
    this.result = { status: 'complete', details: { ...details, url: this.committed.url } }
  }

  stop(): void {
    this.stopped = true
    this.armed = false
    this.confirmation = undefined
    this.result = undefined
  }

  confirm(options: {
    candidate: FirefoxNavigationResult | undefined
    frame: Awaited<ReturnType<FirefoxApi['webNavigation']['getFrame']>>
    tab: FirefoxTab
    timeStamp: number
  }): boolean {
    const { candidate, frame, tab, timeStamp } = options
    if (
      this.stopped ||
      this.pendingAbort ||
      !candidate ||
      candidate !== this.result ||
      candidate.status !== 'complete' ||
      !frame ||
      frame.errorOccurred ||
      tab.id !== this.tabId ||
      tab.status !== 'complete' ||
      frame.url !== candidate.details.url ||
      tab.url !== candidate.details.url ||
      (candidate.details.documentId !== undefined &&
        frame.documentId !== undefined &&
        candidate.details.documentId !== frame.documentId)
    ) {
      this.confirmation = undefined
      return false
    }
    if (this.confirmation?.candidate !== candidate || this.confirmation.documentId !== frame.documentId) {
      this.confirmation = { candidate, documentId: frame.documentId, timeStamp }
      return false
    }
    return timeStamp - this.confirmation.timeStamp >= 25
  }
}
