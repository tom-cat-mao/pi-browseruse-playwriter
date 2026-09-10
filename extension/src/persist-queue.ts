/**
 * Serial write queue that survives failures: a rejected write never poisons the
 * chain, so the next write still runs.
 *
 * `invalidate()` drops queued and in-flight writers. Callers use it after
 * re-reading authoritative state (e.g. recovering from a storage failure) so a
 * stale in-memory snapshot can never overwrite fresher persisted records.
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

  invalidate(): void {
    this.generation += 1
    this.tail = Promise.resolve()
  }
}
