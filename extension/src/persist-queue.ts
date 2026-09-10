/**
 * Serial write queue that survives failures: a rejected write never poisons the
 * chain, so the next write still runs.
 *
 * `invalidate()` marks queued-but-not-started writers as stale and resolves only
 * after the currently running write settles. Callers await it before re-reading
 * authoritative state, so a slower in-flight write can never land after the
 * reload/new state (an already-issued chrome.storage write cannot be cancelled).
 */
export class PersistQueue {
  private tail: Promise<void> = Promise.resolve()
  private generation = 0

  run(task: () => Promise<void>): Promise<void> {
    const generation = this.generation
    const guarded = async (): Promise<void> => {
      if (generation !== this.generation) return
      await task()
    }
    const next = this.tail.then(guarded, guarded)
    this.tail = next.then(
      () => {
        return undefined
      },
      () => {
        return undefined
      },
    )
    return next
  }

  /**
   * Skips queued stale writers and waits for the in-flight one to finish. New
   * writers submitted during the drain stay ordered behind it.
   */
  async invalidate(): Promise<void> {
    this.generation += 1
    const pending = this.tail
    await pending.catch(() => {
      return undefined
    })
    if (this.tail === pending) {
      this.tail = Promise.resolve()
    }
  }
}
