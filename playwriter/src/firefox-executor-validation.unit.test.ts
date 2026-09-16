import { describe, expect, test } from 'vitest'
import { parseBrowserDomCommand, parseBrowserDomRequest } from './browser-dom-validation.js'
import {
  MAX_FIREFOX_ASSET_BASE64_LENGTH,
  MAX_FIREFOX_ASSET_COUNT,
  isFirefoxBrowserResponse,
  parseFirefoxAssetFetchRequest,
  parseFirefoxAssetFetchResponse,
  validateFirefoxMessageSize,
} from './firefox-executor-protocol.js'

describe('Firefox DOM command boundary', () => {
  test('accepts a nested locator and preserves explicit tab identity', () => {
    const command = {
      method: 'locator',
      action: 'fill',
      locator: { steps: [
        { kind: 'selector', engine: 'css', value: 'form' },
        { kind: 'filter', has: { steps: [{ kind: 'selector', engine: 'text', value: 'Shipping', exact: true }] } },
        { kind: 'selector', engine: 'label', value: 'Name' },
      ] },
      args: ['Example', { timeout: 500 }],
    }
    const request = { requestId: 'request', sessionId: 'session', tabId: 'tab', browserEpoch: 'epoch', command, timeoutMs: 1000 }
    expect(parseBrowserDomRequest(request)).toEqual(request)
    expect(parseBrowserDomCommand(command)).toEqual(command)
  })

  test('validates frame lookup locators without accepting another page identity', () => {
    const command = { method: 'frame.resolve', locator: { steps: [{ kind: 'selector', engine: 'css', value: 'iframe.payment' }] } }
    expect(parseBrowserDomCommand(command)).toEqual(command)
    expect(parseBrowserDomCommand({ method: 'page', action: 'readyState' })).toEqual({ method: 'page', action: 'readyState' })
    expect(parseBrowserDomCommand({ method: 'locator', action: 'inputValue', locator: { steps: [{ kind: 'selector', engine: 'css', value: 'aria-ref=e1' }], snapshotId: 'snapshot-1' } })).not.toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', action: 'fill', locator: command.locator, args: [42] })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', action: 'click', locator: command.locator, args: [{ timeout: -1 }] })).toBeNull()
    expect(parseBrowserDomCommand({ ...command, tabId: 'other' })).toBeNull()
    expect(parseBrowserDomCommand({ ...command, locator: { steps: [{ kind: 'nth', index: NaN }] } })).toBeNull()
  })

  test('rejects scope-changing fields, unknown commands and cross-tab nested operations', () => {
    const base = { requestId: 'r', sessionId: 's', tabId: 'tab', browserEpoch: 'e' }
    expect(parseBrowserDomRequest({ ...base, command: { method: 'operation', operation: { kind: 'page.back', tabId: 'other' } } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'operation', operation: { kind: 'page.execute', tabId: 'tab', code: 'return 1' } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'page', action: 'url', tabId: 'other' })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'closeBrowser' })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'evaluate', code: 'return 1', world: 'MAIN' })).toBeNull()
  })

  test('scopes a content read to one selector and no other page read', () => {
    const scoped = { method: 'page', action: 'content', selector: '#settings' }
    expect(parseBrowserDomCommand(scoped)).toEqual(scoped)
    expect(parseBrowserDomCommand({ ...scoped, action: 'title' })).toBeNull()
    expect(parseBrowserDomCommand({ ...scoped, selector: '' })).toBeNull()
    expect(parseBrowserDomCommand({ ...scoped, selector: 'x'.repeat(20_001) })).toBeNull()
  })

  test('validates prepared frame action points, tokens, and strict parent locator scope', () => {
    const locator = { steps: [{ kind: 'selector', engine: 'css', value: 'iframe.payment' }] }
    const point = { x: 24, y: 32 }
    expect(parseBrowserDomCommand({ method: 'frame.check', locator, point })).toEqual({ method: 'frame.check', locator, point })
    expect(parseBrowserDomCommand({ method: 'frame.actionPoint', locator, action: 'fill', args: ['value'] })).not.toBeNull()
    expect(parseBrowserDomCommand({ method: 'frame.actionPoint', locator, action: 'count' })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'frame.check', locator, point: { x: -1, y: 2 } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'frame.check', locator, point: { x: 1, y: Number.NaN } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'frame.check', locator, point: { x: 1, y: 2, tabId: 'other' } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'frame.check', locator, point, frameId: 42 })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', locator, action: 'click', expectedPoint: point, preparationId: 'prepared' })).not.toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', locator, action: 'click', expectedPoint: point })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', locator, action: 'click', preparationId: 'prepared' })).toBeNull()
  })

  test('rejects cyclic, oversized and malformed locator programs', () => {
    const cycle: Record<string, unknown> = { method: 'evaluate', code: 'return 1' }
    cycle.self = cycle
    expect(parseBrowserDomCommand(cycle)).toBeNull()
    expect(parseBrowserDomCommand({ method: 'evaluate', code: 'a'.repeat(1_000_001) })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', action: 'count', locator: { steps: [] } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', action: 'count', locator: { steps: [{ kind: 'nth', index: -2 }] } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'locator', action: 'count', locator: { steps: [{ kind: 'selector', engine: 'css', value: 'input', options: { unsupported: true } }] } })).toBeNull()
    expect(parseBrowserDomRequest({ requestId: 'r', sessionId: 's', tabId: 't', browserEpoch: 'e', command: { method: 'invalidate' }, timeoutMs: 0 })).toBeNull()
  })
})

describe('Firefox asset channel boundary', () => {
  const request = {
    requestId: 'request:assets',
    sessionId: 'session',
    tabId: 'tab',
    browserEpoch: 'epoch',
    targets: [
      { src: 'https://cdn.example.test/hero.png', alt: 'Hero' },
      { src: 'http://cdn.example.test/logo.png' },
    ],
  }

  test('accepts a bounded image request and keeps its tab identity', () => {
    expect(parseFirefoxAssetFetchRequest(request)).toEqual(request)
  })

  test('rejects unknown fields, unwritable identities and non-web image URLs', () => {
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [] })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, sessionId: '' })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, tabId: 't'.repeat(2_049) })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, extra: true })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [{ src: 'data:image/png;base64,AAAA' }] })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [{ src: 'file:///etc/passwd' }] })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [{ src: '/relative.png' }] })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [{ src: `https://cdn.example.test/${'a'.repeat(8_200)}.png` }] })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [{ src: 'https://cdn.example.test/a.png', alt: 42 }] })).toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: [{ src: 'https://cdn.example.test/a.png', weight: 2 }] })).toBeNull()
  })

  test('bounds how many images one request may ask for', () => {
    const targets = Array.from({ length: MAX_FIREFOX_ASSET_COUNT + 1 }, (_value, index) => {
      return { src: `https://cdn.example.test/${index}.png` }
    })
    expect(parseFirefoxAssetFetchRequest({ ...request, targets: targets.slice(0, MAX_FIREFOX_ASSET_COUNT) })).not.toBeNull()
    expect(parseFirefoxAssetFetchRequest({ ...request, targets })).toBeNull()
  })

  test('keeps per-image failures inside one bounded response', () => {
    const response = {
      requestId: request.requestId,
      assets: [
        { src: 'https://cdn.example.test/hero.png', ok: true, base64: 'AAAA', mimeType: 'image/png' },
        { src: 'https://cdn.example.test/broken.png', ok: false, reason: 'image request failed with HTTP 404' },
      ],
    }
    expect(parseFirefoxAssetFetchResponse(response)).toEqual(response)
    expect(parseFirefoxAssetFetchResponse({ requestId: request.requestId, assets: [], error: 'extension disconnected' })).not.toBeNull()
    expect(parseFirefoxAssetFetchResponse({ ...response, assets: [{ src: 'https://cdn.example.test/a.png', ok: true, base64: 'AAAA', mimeType: 'not a mime type' }] })).toBeNull()
    expect(parseFirefoxAssetFetchResponse({ ...response, assets: [{ src: 'https://cdn.example.test/a.png', ok: false }] })).toBeNull()
    expect(parseFirefoxAssetFetchResponse({ ...response, assets: [{ src: 'https://cdn.example.test/a.png', ok: true, base64: 'A'.repeat(MAX_FIREFOX_ASSET_BASE64_LENGTH + 1), mimeType: 'image/png' }] })).toBeNull()
    expect(parseFirefoxAssetFetchResponse({ ...response, error: '' })).toBeNull()
  })

  test('lets only asset payloads exceed the control-message limit', () => {
    // One 6 MiB image plus envelope stays under the 8 MiB control-message limit,
    // so a larger payload is what distinguishes the two budgets.
    const base64 = 'A'.repeat(9 * 1024 * 1024)
    const control = { type: 'dom-request', id: 'rpc', rpcId: '1', command: { method: 'page', action: 'content' }, padding: base64 }
    expect(() => { validateFirefoxMessageSize(control) }).toThrow(/8 MiB/)
    const assetResponse = { type: 'asset-response', id: 'id', rpcId: '1', response: { requestId: 'r', assets: [{ src: 'https://cdn.example.test/hero.png', ok: true, base64, mimeType: 'image/png' }] } }
    expect(() => { validateFirefoxMessageSize(assetResponse) }).not.toThrow()
    const extraction = { type: 'response', id: 'id', response: { requestId: 'r', ok: true, data: { value: { savedAssets: [{ base64, mimeType: 'image/png', src: 'https://cdn.example.test/hero.png' }] } } } }
    expect(() => { validateFirefoxMessageSize(extraction) }).not.toThrow()
    const withoutAssets = { type: 'response', id: 'id', response: { requestId: 'r', ok: true, data: { text: base64 } } }
    expect(() => { validateFirefoxMessageSize(withoutAssets) }).toThrow(/8 MiB/)
  })
})

describe('Firefox content-read frame budget', () => {
  test('carries the widest serialized document the extension allows inside the control frame', () => {
    // The extension-side document budget (6,000,000 characters in firefox-dom.ts)
    // is derived from this frame, so the widest read has to fit it.
    const response = {
      requestId: 'request:content',
      ok: true,
      data: {
        value: 'x'.repeat(6_000_000),
        pageInfo: { tabId: 'tab', url: 'https://en.wikipedia.test/wiki/Article', title: 'Article' },
      },
    }
    const message = { type: 'dom-response', id: 'id', rpcId: '1', response }
    expect(isFirefoxBrowserResponse(response)).toBe(true)
    expect(() => { validateFirefoxMessageSize(message) }).not.toThrow()

    // A document past the frame budget is still refused, with its own limit named.
    const overBudget = { ...message, response: { ...response, data: { ...response.data, value: 'x'.repeat(8 * 1024 * 1024 + 1) } } }
    expect(() => { validateFirefoxMessageSize(overBudget) }).toThrow(/8 MiB/)
  })
})
