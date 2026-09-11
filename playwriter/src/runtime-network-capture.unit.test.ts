import { describe, expect, test } from 'vitest'
import type { BrowserTab } from './browser-protocol.js'
import {
  RUNTIME_NETWORK_MAX_BYTES,
  RUNTIME_NETWORK_MAX_CAPTURES,
  RuntimeNetworkCaptureStore,
  RuntimeNetworkCaptureLimitError,
} from './runtime-network-capture.js'

function makeTab(index: number): BrowserTab {
  return {
    tabId: `tab-${index}`,
    groupId: 'group-1',
    sessionId: 'session-1',
    profileId: 'profile-1',
    url: 'https://example.com/',
    title: 'Example',
    state: 'ready',
    browserEpoch: 'epoch-1',
    revision: 1,
    chromeTabId: index,
    targetId: `target-${index}`,
    cdpSessionId: `cdp-${index}`,
  }
}

function captureResponse({
  store,
  requestId,
  url,
}: {
  store: RuntimeNetworkCaptureStore
  requestId: string
  url: string
}): void {
  store.handleEvent({
    connectionId: 'connection-1',
    rootCdpSessionId: 'cdp-1',
    method: 'Network.requestWillBeSent',
    params: { requestId, type: 'XHR', request: { url, method: 'GET' } },
  })
  store.handleEvent({
    connectionId: 'connection-1',
    rootCdpSessionId: 'cdp-1',
    method: 'Network.responseReceived',
    params: { requestId, type: 'XHR', response: { url, status: 200 } },
  })
  store.handleEvent({
    connectionId: 'connection-1',
    rootCdpSessionId: 'cdp-1',
    method: 'Network.loadingFinished',
    params: { requestId },
  })
}

describe('runtime network capture bounds', () => {
  test('bounds retained metadata by serialized bytes', () => {
    const store = new RuntimeNetworkCaptureStore()
    store.start({
      sessionId: 'session-1',
      profileId: 'profile-1',
      tab: makeTab(1),
      connectionId: 'connection-1',
    })
    const largeUrl = `https://example.com/${'x'.repeat(Math.floor(RUNTIME_NETWORK_MAX_BYTES / 3))}`
    captureResponse({ store, requestId: 'request-1', url: `${largeUrl}1` })
    captureResponse({ store, requestId: 'request-2', url: `${largeUrl}2` })
    captureResponse({ store, requestId: 'request-3', url: `${largeUrl}3` })
    captureResponse({ store, requestId: 'request-4', url: `${largeUrl}4` })

    const result = store.list({ sessionId: 'session-1', tabId: 'tab-1' })
    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].url.endsWith('3')).toBe(true)
    expect(result.metadata).toMatchObject({ status: 'active', retainedCount: 2, droppedCount: 2 })
  })

  test('rejects a new capture at the process limit without deleting retained evidence', () => {
    const store = new RuntimeNetworkCaptureStore()
    Array.from({ length: RUNTIME_NETWORK_MAX_CAPTURES }).map((_, index) => {
      const tab = makeTab(index)
      return store.start({
        sessionId: 'session-1',
        profileId: 'profile-1',
        tab,
        connectionId: 'connection-1',
      })
    })
    expect(() => {
      store.start({
        sessionId: 'session-1',
        profileId: 'profile-1',
        tab: makeTab(RUNTIME_NETWORK_MAX_CAPTURES),
        connectionId: 'connection-1',
      })
    }).toThrow(RuntimeNetworkCaptureLimitError)
    expect(store.list({ sessionId: 'session-1', tabId: 'tab-0' }).metadata.status).toBe('active')
  })
})
