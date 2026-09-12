import { describe, expect, test } from 'vitest'
import { FirefoxNavigationState } from '../src/firefox-navigation'
import type { FirefoxNavigationDetails } from '../src/firefox-api'

const event = (fields: Partial<FirefoxNavigationDetails> = {}): FirefoxNavigationDetails => {
  return { tabId: 42, frameId: 0, url: 'https://example.com/same', timeStamp: 100, ...fields }
}

describe('Firefox navigation observation', () => {
  test('old complete and pre-dispatch signals cannot confirm a new action', () => {
    const state = new FirefoxNavigationState(42)
    state.observe({ signal: 'history', details: event() })
    expect(state.result).toBeUndefined()
    state.arm(100)
    state.observe({ signal: 'history', details: event({ timeStamp: 99 }) })
    state.observe({ signal: 'completed', details: event() })
    expect(state.result).toBeUndefined()
    state.observe({ signal: 'before', details: event() })
    state.observe({ signal: 'completed', details: event({ timeStamp: 101 }) })
    expect(state.result).toBeUndefined()
  })

  test('only the selected tab main frame can complete navigation', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    for (const fields of [{ tabId: 43 }, { frameId: 1 }]) {
      state.observe({ signal: 'committed', details: event(fields) })
      state.observe({ signal: 'completed', details: event(fields) })
      state.observe({ signal: 'history', details: event(fields) })
      state.observe({ signal: 'error', details: event(fields) })
    }
    expect(state.result).toBeUndefined()
  })

  test('same-URL document navigation waits for committed document completion', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'before', details: event() })
    state.observe({ signal: 'committed', details: event({ timeStamp: 101, documentId: 'new' }) })
    expect(state.result).toBeUndefined()
    state.observe({ signal: 'completed', details: event({ timeStamp: 102, documentId: 'old' }) })
    expect(state.result).toBeUndefined()
    state.observe({ signal: 'completed', details: event({ timeStamp: 102, documentId: 'new' }) })
    expect(state.result).toEqual({ status: 'complete', details: event({ timeStamp: 102, documentId: 'new' }) })
  })

  test('same-document history can complete without a different URL or loading status', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'history', details: event() })
    expect(state.result).toEqual({ status: 'complete', details: event() })
  })

  test('fragment changes and committed history restoration have distinct completion signals', () => {
    const fragment = new FirefoxNavigationState(42)
    fragment.arm(100)
    fragment.observe({ signal: 'fragment', details: event({ url: 'https://example.com/same#back' }) })
    expect(fragment.result?.status).toBe('complete')
    const restored = new FirefoxNavigationState(42)
    restored.arm(100)
    restored.observe({ signal: 'committed', details: event({ documentId: 'restored' }) })
    expect(restored.result).toBeUndefined()
    restored.observe({ signal: 'completed', details: event({ documentId: 'restored', timeStamp: 101 }) })
    expect(restored.result?.status).toBe('complete')
  })

  test('redirects wait for the final commit and reject older completion events', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'before', details: event() })
    state.observe({ signal: 'before', details: event({ timeStamp: 101, url: 'https://example.com/redirect' }) })
    state.observe({ signal: 'completed', details: event({ timeStamp: 100 }) })
    expect(state.result).toBeUndefined()
    state.observe({ signal: 'committed', details: event({ timeStamp: 102, url: 'https://example.com/final' }) })
    state.observe({ signal: 'completed', details: event({ timeStamp: 101 }) })
    expect(state.result).toBeUndefined()
    const details = event({ timeStamp: 103, url: 'https://example.com/final' })
    state.observe({ signal: 'completed', details })
    expect(state.result).toEqual({ status: 'complete', details })
  })

  test('history events during an unfinished document load do not end that load', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'before', details: event() })
    state.observe({ signal: 'history', details: event({ timeStamp: 101 }) })
    state.observe({ signal: 'fragment', details: event({ timeStamp: 102 }) })
    expect(state.result).toBeUndefined()
  })

  test('another navigation after commit is not silently adopted as this action', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'committed', details: event() })
    state.observe({ signal: 'before', details: event({ timeStamp: 101 }) })
    state.observe({ signal: 'completed', details: event({ timeStamp: 102 }) })
    expect(state.result?.status).toBe('failed')
  })

  test('missing document IDs require matching committed and completed URLs', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'committed', details: event() })
    state.observe({ signal: 'completed', details: event({ timeStamp: 101, url: 'https://example.com/other' }) })
    expect(state.result).toBeUndefined()
    state.observe({ signal: 'completed', details: event({ timeStamp: 102 }) })
    expect(state.result?.status).toBe('complete')
  })

  test('navigation errors are terminal and late successful events do not overwrite them', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'before', details: event() })
    state.observe({ signal: 'error', details: event({ timeStamp: 101, error: 'navigation failed' }) })
    state.observe({ signal: 'committed', details: event({ timeStamp: 102 }) })
    state.observe({ signal: 'completed', details: event({ timeStamp: 103 }) })
    expect(state.result).toEqual({ status: 'failed', message: 'navigation failed' })
  })
})
