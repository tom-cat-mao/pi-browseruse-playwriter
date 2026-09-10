import { describe, expect, test } from 'vitest'
import { KeyedSerialQueue } from '../src/keyed-queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('KeyedSerialQueue', () => {
  test('tasks with the same key run strictly in order', async () => {
    const queue = new KeyedSerialQueue()
    const events: string[] = []
    const gate = deferred()

    const first = queue.run('group-1', async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
    })
    const second = queue.run('group-1', async () => {
      events.push('second')
    })
    const third = queue.run('group-1', async () => {
      events.push('third')
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    expect(queue.isBusy('group-1')).toBe(true)

    gate.resolve()
    await Promise.all([first, second, third])
    expect(events).toEqual(['first:start', 'first:end', 'second', 'third'])
    expect(queue.isBusy('group-1')).toBe(false)
  })

  test('tasks with different keys run in parallel', async () => {
    const queue = new KeyedSerialQueue()
    const events: string[] = []
    const gateA = deferred()

    const a = queue.run('group-a', async () => {
      events.push('a:start')
      await gateA.promise
      events.push('a:end')
    })
    const b = queue.run('group-b', async () => {
      events.push('b')
    })

    await b
    expect(events).toContain('b')
    gateA.resolve()
    await a
    expect(events).toEqual(['a:start', 'b', 'a:end'])
  })

  test('a failing task rejects its caller without blocking the queue', async () => {
    const queue = new KeyedSerialQueue()
    const events: string[] = []

    const failing = queue.run('group-1', async () => {
      events.push('failing')
      throw new Error('boom')
    })
    const next = queue.run('group-1', async () => {
      events.push('next')
      return 'ok'
    })

    await expect(failing).rejects.toThrow('boom')
    await expect(next).resolves.toBe('ok')
    expect(events).toEqual(['failing', 'next'])
  })
})
