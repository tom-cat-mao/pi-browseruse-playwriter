import { describe, expect, test } from 'vitest'
import { PersistQueue } from '../src/persist-queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('PersistQueue', () => {
  test('a failed write does not poison the queue', async () => {
    const queue = new PersistQueue()
    const attempts: string[] = []

    await expect(
      queue.run(async () => {
        attempts.push('fail')
        throw new Error('disk full')
      }),
    ).rejects.toThrow('disk full')

    await queue.run(async () => {
      attempts.push('recover')
    })
    expect(attempts).toEqual(['fail', 'recover'])
  })

  test('writes stay strictly ordered', async () => {
    const queue = new PersistQueue()
    const events: string[] = []
    const gate = deferred()

    const first = queue.run(async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
    })
    const second = queue.run(async () => {
      events.push('second')
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['first:start'])

    gate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second'])
  })

  test('invalidate drops queued stale writers but lets the running one finish', async () => {
    const queue = new PersistQueue()
    const events: string[] = []
    const gate = deferred()

    const running = queue.run(async () => {
      events.push('running:start')
      await gate.promise
      events.push('running:end')
    })
    const queued = queue.run(async () => {
      events.push('queued')
    })

    // Let the first writer actually start before invalidating: queued-but-not-started
    // writers are stale snapshots and must be dropped, the running one finishes.
    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['running:start'])

    queue.invalidate()
    gate.resolve()
    await Promise.all([running, queued])
    expect(events).toEqual(['running:start', 'running:end'])
  })
})
