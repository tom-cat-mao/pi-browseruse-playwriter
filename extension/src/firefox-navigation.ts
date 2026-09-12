import type { FirefoxNavigationDetails } from './firefox-api'

export type FirefoxNavigationSignal = 'before' | 'committed' | 'completed' | 'history' | 'fragment' | 'error'
export type FirefoxNavigationResult =
  | { status: 'complete'; details: FirefoxNavigationDetails }
  | { status: 'failed'; message: string }

export class FirefoxNavigationState {
  private readonly tabId: number
  private armed = false
  private started = false
  private committed?: FirefoxNavigationDetails
  private latestTime = -Infinity
  private targetUrl?: string
  private readonly supersededDocuments = new Set<string>()
  private readonly supersededUrls = new Set<string>()
  result?: FirefoxNavigationResult

  constructor(tabId: number) {
    this.tabId = tabId
  }

  arm(timeStamp: number): void {
    this.latestTime = timeStamp
    this.armed = true
  }

  observe(options: { signal: FirefoxNavigationSignal; details: FirefoxNavigationDetails }): void {
    const { signal, details } = options
    if (!this.armed || this.result || details.tabId !== this.tabId || details.frameId !== 0) return
    if (details.timeStamp < this.latestTime) return
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
    this.result = { status: 'complete', details }
  }
}
