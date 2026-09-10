import { describe, expect, test } from 'vitest'
import { InternalMoves } from '../src/internal-moves'

describe('InternalMoves', () => {
  test('consumes a marker only for the group the operation produced', () => {
    const moves = new InternalMoves(3000)
    moves.register(101, { expectedChromeGroupId: 55, windowId: 7, now: 1000 })

    expect(moves.matches(101, { chromeGroupId: 55, windowId: 7, now: 1100 })).toBe(true)
    // Consumed: a later move cannot be swallowed by the same marker.
    expect(moves.matches(101, { chromeGroupId: 55, windowId: 7, now: 1200 })).toBe(false)
  })

  test('a user move to a different group is reported as not internal', () => {
    const moves = new InternalMoves(3000)
    moves.register(101, { expectedChromeGroupId: 55, now: 1000 })

    expect(moves.matches(101, { chromeGroupId: 99, now: 1100 })).toBe(false)
    // The stale marker is gone, so the next unrelated move is not swallowed either.
    expect(moves.matches(101, { chromeGroupId: 55, now: 1200 })).toBe(false)
  })

  test('expired markers never match', () => {
    const moves = new InternalMoves(3000)
    moves.register(101, { expectedChromeGroupId: 55, now: 1000 })

    expect(moves.matches(101, { chromeGroupId: 55, now: 4500 })).toBe(false)
  })

  test('window expectations distinguish a move into the group window', () => {
    const moves = new InternalMoves(3000)
    moves.register(101, { expectedChromeGroupId: -1, windowId: 7, now: 1000 })

    expect(moves.matches(101, { chromeGroupId: -1, windowId: 8, now: 1100 })).toBe(false)

    moves.register(102, { expectedChromeGroupId: -1, windowId: 7, now: 1000 })
    expect(moves.matches(102, { chromeGroupId: -1, windowId: 7, now: 1100 })).toBe(true)
  })
})
