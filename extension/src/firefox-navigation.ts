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
      if (this.committed) {
        this.result = {
          status: 'failed',
          message: 'Firefox started another navigation after the observed document committed',
        }
        return
      }
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
    if ((signal === 'history' || signal === 'fragment') && !this.started) {
      this.result = { status: 'complete', details }
      return
    }
    if (signal === 'error' && this.started) {
      if (
        this.committed?.documentId !== undefined &&
        details.documentId !== undefined &&
        this.committed.documentId !== details.documentId
      )
        return
      this.result = { status: 'failed', message: details.error ?? 'Firefox navigation failed' }
      return
    }
    if (signal !== 'completed' || !this.committed) return
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
