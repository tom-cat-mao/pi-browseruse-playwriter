import { afterEach, describe, expect, test, vi } from 'vitest'
import { CoalescedPublisher, compareDiscoveredTabs } from '../src/managed-groups'
import type { DiscoverySortableTab } from '../src/managed-groups'

function tab(options: { windowId: number; index: number; active?: boolean }): DiscoverySortableTab {
  return { windowId: options.windowId, index: options.index, active: options.active ?? false }
}

function summarize(tabs: DiscoverySortableTab[]): string[] {
  return tabs.map((candidate) => {
    return `${candidate.windowId}/${candidate.index}${candidate.active ? ' active' : ''}`
  })
}

function order(tabs: DiscoverySortableTab[], focusedWindowIds: number[]): DiscoverySortableTab[] {
  const focused = new Set(focusedWindowIds)
  return [...tabs].sort((a, b) => {
    return compareDiscoveredTabs(a, b, focused)
  })
}

describe('tabs.discover ordering', () => {
  test('active tabs of every window lead and the focused window only orders ties', () => {
    const tabs = [
      tab({ windowId: 7, index: 0 }),
      tab({ windowId: 9, index: 0 }),
      tab({ windowId: 9, index: 2, active: true }),
      tab({ windowId: 7, index: 3, active: true }),
      tab({ windowId: 9, index: 1 }),
      tab({ windowId: 7, index: 1 }),
    ]

    expect(summarize(order(tabs, [7]))).toEqual(['7/3 active', '9/2 active', '7/0', '7/1', '9/0', '9/1'])
  })

  test('each window keeps its own active tab when no window has OS focus', () => {
    const tabs = [
      tab({ windowId: 5, index: 0 }),
      tab({ windowId: 2, index: 0, active: true }),
      tab({ windowId: 5, index: 2, active: true }),
      tab({ windowId: 5, index: 1 }),
      tab({ windowId: 2, index: 1 }),
    ]

    expect(summarize(order(tabs, []))).toEqual(['2/0 active', '5/2 active', '2/1', '5/0', '5/1'])
  })

  test('the focused window leads inactive tabs but never outranks another active tab', () => {
    const tabs = [
      tab({ windowId: 3, index: 0, active: true }),
      tab({ windowId: 8, index: 0, active: true }),
      tab({ windowId: 3, index: 1 }),
      tab({ windowId: 8, index: 1 }),
    ]

    expect(summarize(order(tabs, [8]))).toEqual(['8/0 active', '3/0 active', '8/1', '3/1'])
  })

  test('the listing is deterministic and does not depend on input enumeration order', () => {
    const tabs = [
      tab({ windowId: 4, index: 1 }),
      tab({ windowId: 4, index: 0, active: true }),
      tab({ windowId: 1, index: 2 }),
      tab({ windowId: 1, index: 0 }),
    ]
    const reversed = [...tabs].reverse()

    const first = order(tabs, [1])
    const second = order(reversed, [1])
    expect(summarize(first)).toEqual(['4/0 active', '1/0', '1/2', '4/1'])
    expect(summarize(second)).toEqual(summarize(first))
  })
})

describe('CoalescedPublisher', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('a burst flushes once and later updates do not push the deadline forward', () => {
    vi.useFakeTimers()
    let flushes = 0
    const publisher = new CoalescedPublisher({
      delayMs: 250,
      flush: () => {
        flushes += 1
      },
    })

    publisher.schedule()
    vi.advanceTimersByTime(100)
    publisher.schedule()
    vi.advanceTimersByTime(100)
    publisher.schedule()
    expect(flushes).toBe(0)

    vi.advanceTimersByTime(50)
    expect(flushes).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(flushes).toBe(1)
  })

  test('continuous updates flush on a bounded interval instead of starving', () => {
    vi.useFakeTimers()
    let flushes = 0
    const publisher = new CoalescedPublisher({
      delayMs: 250,
      flush: () => {
        flushes += 1
      },
    })

    // 1000ms of updates every 10ms: a sliding debounce would never fire.
    for (let i = 0; i < 100; i += 1) {
      publisher.schedule()
      vi.advanceTimersByTime(10)
    }
    expect(flushes).toBe(4)

    publisher.schedule()
    vi.advanceTimersByTime(250)
    expect(flushes).toBe(5)
  })
})
