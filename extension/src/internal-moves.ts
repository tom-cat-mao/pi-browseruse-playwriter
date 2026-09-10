/**
 * Tracks tab moves this extension performs itself (grouping a new tab, ungrouping
 * on release, moving an adopted tab into the target window) so the Chrome
 * `tabs.onUpdated` groupId listener can tell them apart from user moves.
 *
 * Matching is done against the exact Chrome group id (and window when known)
 * that the operation produced. A marker never swallows the next arbitrary
 * event: a move to a different group is treated as a user move and the stale
 * marker is dropped.
 */
export interface InternalMoveExpectation {
  expectedChromeGroupId: number
  windowId?: number
  expiresAt: number
}

export class InternalMoves {
  private readonly entries = new Map<number, InternalMoveExpectation>()
  private readonly ttlMs: number

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  register(chromeTabId: number, options: { expectedChromeGroupId: number; windowId?: number; now?: number }): void {
    const now = options.now ?? Date.now()
    this.entries.set(chromeTabId, {
      expectedChromeGroupId: options.expectedChromeGroupId,
      ...(options.windowId !== undefined ? { windowId: options.windowId } : {}),
      expiresAt: now + this.ttlMs,
    })
  }

  /**
   * Returns true only when the observed move matches the operation we started.
   * The marker is consumed in both cases (match or mismatch) so it can never
   * swallow a later user interaction.
   */
  matches(chromeTabId: number, options: { chromeGroupId?: number; windowId?: number; now?: number }): boolean {
    const entry = this.entries.get(chromeTabId)
    if (!entry) return false
    const now = options.now ?? Date.now()
    this.entries.delete(chromeTabId)
    if (entry.expiresAt <= now) return false
    if (options.chromeGroupId === undefined || options.chromeGroupId !== entry.expectedChromeGroupId) {
      return false
    }
    if (entry.windowId !== undefined && options.windowId !== undefined && options.windowId !== entry.windowId) {
      return false
    }
    return true
  }

  clear(chromeTabId: number): void {
    this.entries.delete(chromeTabId)
  }
}
