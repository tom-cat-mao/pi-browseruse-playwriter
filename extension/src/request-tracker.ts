/**
 * Tracks in-flight control requests so they can be cancelled (relay cancel/timeout)
 * or invalidated when the owning websocket connection goes away.
 *
 * Cancellation only stops future steps. The outcome reports whether side effects
 * had already started, so callers can answer `not-started` vs `unknown` without
 * pretending that sent actions were rolled back.
 */
export type RequestCancelOutcome = 'not-started' | 'unknown'
export type CancelLookup = 'cancelled' | 'not-active'

interface ActiveRequest {
  sessionId: string
  cancelled: boolean
  sideEffectsStarted: boolean
}

export class RequestTracker {
  private readonly active = new Map<string, ActiveRequest>()

  private key(options: { sessionId: string; requestId: string }): string {
    return `${options.sessionId}\u0000${options.requestId}`
  }

  start(options: { sessionId: string; requestId: string }): void {
    this.active.set(this.key(options), {
      sessionId: options.sessionId,
      cancelled: false,
      sideEffectsStarted: false,
    })
  }

  finish(options: { sessionId: string; requestId: string }): void {
    this.active.delete(this.key(options))
  }

  markSideEffects(options: { sessionId: string; requestId: string }): void {
    const entry = this.active.get(this.key(options))
    if (entry) entry.sideEffectsStarted = true
  }

  isCancelled(options: { sessionId: string; requestId: string }): boolean {
    return this.active.get(this.key(options))?.cancelled ?? false
  }

  /** Cancels only requests started by the same session. */
  cancel(options: { sessionId: string; targetRequestId: string }): CancelLookup {
    const entry = this.active.get(this.key({ sessionId: options.sessionId, requestId: options.targetRequestId }))
    if (!entry) return 'not-active'
    entry.cancelled = true
    return 'cancelled'
  }

  /** Every in-flight request belongs to the dropped connection. */
  cancelAll(): void {
    for (const entry of this.active.values()) {
      entry.cancelled = true
    }
  }

  outcomeForCancelled(options: { sessionId: string; requestId: string }): RequestCancelOutcome {
    return this.active.get(this.key(options))?.sideEffectsStarted ? 'unknown' : 'not-started'
  }
}
