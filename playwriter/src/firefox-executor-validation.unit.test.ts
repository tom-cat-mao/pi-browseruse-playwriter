import { describe, expect, test } from 'vitest'
import { parseBrowserDomCommand, parseBrowserDomRequest } from './browser-dom-validation.js'

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

  test('rejects scope-changing fields, unknown commands and cross-tab nested operations', () => {
    const base = { requestId: 'r', sessionId: 's', tabId: 'tab', browserEpoch: 'e' }
    expect(parseBrowserDomRequest({ ...base, command: { method: 'operation', operation: { kind: 'page.back', tabId: 'other' } } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'operation', operation: { kind: 'page.execute', tabId: 'tab', code: 'return 1' } })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'page', action: 'url', tabId: 'other' })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'closeBrowser' })).toBeNull()
    expect(parseBrowserDomCommand({ method: 'evaluate', code: 'return 1', world: 'MAIN' })).toBeNull()
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
