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

  test('navigation chains follow a later main-frame commit without accepting old aborts or completion', () => {
    for (const withDocumentIds of [false, true]) {
      const state = new FirefoxNavigationState(42)
      state.arm(100)
      const old = event({ ...(withDocumentIds ? { documentId: 'old' } : {}) })
      const next = event({ url: 'https://example.com/next', ...(withDocumentIds ? { documentId: 'next' } : {}) })
      state.observe({ signal: 'before', details: old })
      state.observe({ signal: 'committed', details: { ...old, timeStamp: 101 } })
      state.observe({ signal: 'before', details: { ...next, timeStamp: 102 } })
      state.observe({ signal: 'error', details: { ...old, timeStamp: 103, error: 'old document aborted' } })
      state.observe({ signal: 'completed', details: { ...old, timeStamp: 104 } })
      expect(state.result).toBeUndefined()
      state.observe({ signal: 'committed', details: { ...next, timeStamp: 105 } })
      state.observe({ signal: 'error', details: { ...old, timeStamp: 106, error: 'old document aborted' } })
      state.observe({ signal: 'completed', details: { ...old, timeStamp: 107 } })
      expect(state.result).toBeUndefined()
      const completed = { ...next, timeStamp: 108 }
      state.observe({ signal: 'completed', details: completed })
      expect(state.result).toEqual({ status: 'complete', details: completed })
    }
  })

  test('history and fragment update the committed URL but do not finish its load', () => {
    for (const signal of ['history', 'fragment'] as const) {
      const state = new FirefoxNavigationState(42)
      state.arm(100)
      state.observe({ signal: 'before', details: event() })
      state.observe({ signal: 'committed', details: event({ timeStamp: 101 }) })
      const changed = event({ url: 'https://example.com/same?changed#fragment', timeStamp: 102 })
      state.observe({ signal, details: changed })
      expect(state.result).toBeUndefined()
      state.observe({ signal: 'completed', details: event({ timeStamp: 103 }) })
      expect(state.result).toBeUndefined()
      const completed = { ...changed, timeStamp: 104 }
      state.observe({ signal: 'completed', details: completed })
      expect(state.result).toEqual({ status: 'complete', details: completed })
    }
  })

  test('an old document history event cannot change the current committed document URL', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'committed', details: event({ documentId: 'current' }) })
    state.observe({
      signal: 'history',
      details: event({ documentId: 'old', url: 'https://example.com/old', timeStamp: 101 }),
    })
    const completed = event({ documentId: 'current', timeStamp: 102 })
    state.observe({ signal: 'completed', details: completed })
    expect(state.result).toEqual({ status: 'complete', details: completed })
  })

  test('same-URL replacement ignores the retired document abort before the next commit', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'committed', details: event({ documentId: 'old' }) })
    state.observe({ signal: 'before', details: event({ timeStamp: 101 }) })
    state.observe({ signal: 'error', details: event({ documentId: 'old', timeStamp: 102, error: 'aborted' }) })
    expect(state.result).toBeUndefined()
    state.observe({ signal: 'committed', details: event({ documentId: 'new', timeStamp: 103 }) })
    state.observe({ signal: 'completed', details: event({ documentId: 'old', timeStamp: 104 }) })
    expect(state.result).toBeUndefined()
    const completed = event({ documentId: 'new', timeStamp: 105 })
    state.observe({ signal: 'completed', details: completed })
    expect(state.result).toEqual({ status: 'complete', details: completed })
  })

  test('a known retired document cannot complete a same-URL commit with missing identity', () => {
    const state = new FirefoxNavigationState(42)
    state.arm(100)
    state.observe({ signal: 'committed', details: event({ documentId: 'retired' }) })
    state.observe({ signal: 'before', details: event({ timeStamp: 101 }) })
    state.observe({ signal: 'committed', details: event({ timeStamp: 102 }) })
    state.observe({ signal: 'completed', details: event({ documentId: 'retired', timeStamp: 103 }) })
    expect(state.result).toBeUndefined()
    const completed = event({ timeStamp: 104 })
    state.observe({ signal: 'completed', details: completed })
    expect(state.result).toEqual({ status: 'complete', details: completed })
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
