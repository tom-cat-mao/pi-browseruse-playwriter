import { describe, expect, test } from 'vitest'
import { RequestTracker } from '../src/request-tracker'

describe('RequestTracker', () => {
  test('cancel before side effects reports not-started and stops the request', () => {
    const tracker = new RequestTracker()
    tracker.start({ sessionId: 'session-1', requestId: 'req-1' })

    expect(tracker.cancel({ sessionId: 'session-1', targetRequestId: 'req-1' })).toBe('cancelled')
    expect(tracker.isCancelled({ sessionId: 'session-1', requestId: 'req-1' })).toBe(true)
    expect(tracker.outcomeForCancelled({ sessionId: 'session-1', requestId: 'req-1' })).toBe('not-started')
  })

  test('cancel after side effects reports unknown without pretending rollback', () => {
    const tracker = new RequestTracker()
    tracker.start({ sessionId: 'session-1', requestId: 'req-1' })
    tracker.markSideEffects({ sessionId: 'session-1', requestId: 'req-1' })

    tracker.cancel({ sessionId: 'session-1', targetRequestId: 'req-1' })
    expect(tracker.outcomeForCancelled({ sessionId: 'session-1', requestId: 'req-1' })).toBe('unknown')
  })

  test('cancel cannot reach another session or a finished request', () => {
    const tracker = new RequestTracker()
    tracker.start({ sessionId: 'session-1', requestId: 'req-1' })

    expect(tracker.cancel({ sessionId: 'session-2', targetRequestId: 'req-1' })).toBe('not-active')
    expect(tracker.isCancelled({ sessionId: 'session-1', requestId: 'req-1' })).toBe(false)

    tracker.finish({ sessionId: 'session-1', requestId: 'req-1' })
    expect(tracker.cancel({ sessionId: 'session-1', targetRequestId: 'req-1' })).toBe('not-active')
  })

  test('cancelAll invalidates every request of a dropped connection', () => {
    const tracker = new RequestTracker()
    tracker.start({ sessionId: 'session-1', requestId: 'req-1' })
    tracker.start({ sessionId: 'session-2', requestId: 'req-2' })

    tracker.cancelAll()
    expect(tracker.isCancelled({ sessionId: 'session-1', requestId: 'req-1' })).toBe(true)
    expect(tracker.isCancelled({ sessionId: 'session-2', requestId: 'req-2' })).toBe(true)
  })
})
