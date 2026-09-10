/**
 * Serializes async work per key. Tasks sharing a key run strictly in order while
 * different keys stay parallel, so per-group mutations (first-tab grouping,
 * rename, close) cannot interleave without blocking unrelated work such as
 * user-release event handling.
 */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(() => {
      return task()
    })
    const tail = result.then(
      () => {
        return undefined
      },
      () => {
        return undefined
      },
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    })
    return result
  }

  isBusy(key: string): boolean {
    return this.tails.has(key)
  }
}
