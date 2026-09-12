import { describe, expect, test } from 'vitest'
import type { BrowserDomRequest, BrowserResponse, BrowserTab, BrowserResultData } from './browser-protocol.js'
import { parseBrowserDomRequest } from './browser-dom-validation.js'
import { FirefoxExecutorPool, type FirefoxExecution } from './firefox-executor-pool.js'
import { ManagedCancellation } from './managed-executor-pool.js'

/** A real protocol peer that records wire commands without pretending to implement a browser DOM. */
class CommandPeer {
  readonly requests: BrowserDomRequest[] = []
  readonly snapshotMessages: BrowserResultData[] = []
  beforeReply?: (request: BrowserDomRequest) => Promise<void | BrowserResponse>

  async receive(value: BrowserDomRequest): Promise<BrowserResponse> {
    const request = parseBrowserDomRequest(JSON.parse(JSON.stringify(value)))
    if (!request) {
      throw new Error('Invalid DOM wire request')
    }
    this.requests.push(request)
    const override = await this.beforeReply?.(request)
    if (override) return override
    return {
      requestId: request.requestId,
      ok: true,
      data: request.command.method === 'snapshot' && this.snapshotMessages.length > 0 ? this.snapshotMessages.shift()! : {
        value: JSON.parse(JSON.stringify(request.command)),
        pageInfo: { tabId: request.tabId, url: 'https://example.test/current', title: 'Command peer' },
      },
    }
  }
}

function execution({ id, code, peer, session = 'session-1', profile = 'profile-1', epoch = 'epoch-1', timeoutMs = 3_000 }: {
  id: string
  code: string
  peer: CommandPeer
  session?: string
  profile?: string
  epoch?: string
  timeoutMs?: number
}): FirefoxExecution {
  const tab: BrowserTab = {
    tabId: `tab-${session}`, groupId: `group-${session}`, sessionId: session,
    profileId: profile, url: 'https://example.test/original', title: '',
    state: 'ready', browserEpoch: epoch, revision: 1, chromeTabId: -1, browserTabId: 10,
  }
  return {
    request: { requestId: id, sessionId: session, cwd: process.cwd(), timeoutMs, operation: { kind: 'page.execute', tabId: tab.tabId, code } },
    tab, connectionEpoch: `connection-${epoch}`,
    sendDomRequest: async (request) => { return await peer.receive(request) },
  }
}

function barrier(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Protocol test barrier exceeded 3 seconds')) }, 3_000)
    release = () => { clearTimeout(timeout); resolve() }
  })
  return { promise, release }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, milliseconds) })
}

describe('FirefoxExecutorPool real child process', () => {
  test('executes JavaScript with state, serializes console/results and invalidates snapshots', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      const first = await pool.execute(execution({ id: 'first', peer, code: "state.count = 4; console.log('count', state.count); return { count: state.count, url: page.url() }" }))
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true, data: { value: { count: 4, url: 'https://example.test/current' }, logs: ['[log] count 4'] } })
      expect(peer.requests.map((request) => { return request.command.method })).toEqual(['invalidate', 'invalidate'])
      const next = await pool.execute(execution({ id: 'next', peer, code: 'state.count + 1' }))
      expect(next).toMatchObject({ ok: true, data: { value: 5 } })
      expect(new Set(peer.requests.map((request) => { return request.requestId })).size).toBe(4)
      expect(peer.requests.every((request) => { return request.tabId === 'tab-session-1' && request.sessionId === 'session-1' && request.browserEpoch === 'epoch-1' })).toBe(true)
    } finally {
      await pool.dispose()
    }
  })

  test('serializes locator chains, role filters and evaluate function arguments across IPC', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      const response = await pool.execute(execution({ id: 'locator', peer, code: `
        return await page.locator('form').filter({ hasText: 'Shipping', has: page.getByText('Address') })
          .getByRole('textbox', { name: 'Name', exact: true }).nth(1).fill('Example', { timeout: 500 });
      ` }))
      expect(response).toMatchObject({ ok: true, data: { value: {
        method: 'locator', action: 'fill', args: ['Example', { timeout: 500 }],
        locator: { steps: [
          { kind: 'selector', engine: 'css', value: 'form' },
          { kind: 'filter', hasText: 'Shipping', has: { steps: [{ kind: 'selector', engine: 'text', value: 'Address' }] } },
          { kind: 'selector', engine: 'role', value: 'textbox', name: 'Name', exact: true },
          { kind: 'nth', index: 1 },
        ] },
      } } })
      await pool.execute(execution({ id: 'evaluate', peer, code: "await page.getByLabel('Name').evaluate((element, suffix) => { return element.textContent + suffix }, '!')" }))
      const evaluation = peer.requests.find((request) => { return request.command.method === 'evaluate' })
      expect(evaluation?.command).toMatchObject({ method: 'evaluate', locator: { steps: [{ kind: 'selector', engine: 'label', value: 'Name' }] } })
      if (evaluation?.command.method !== 'evaluate') {
        throw new Error('Missing evaluate command')
      }
      expect(evaluation.command.code).toContain('element, "!"')
    } finally {
      await pool.dispose()
    }
  })

  test('preserves a bound snapshot identity when a later snapshot reuses the same short ref', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.snapshotMessages.push(
      { snapshotId: 'snapshot-old', text: 'e1 Name', value: { refs: [{ ref: 'e1', role: 'textbox', name: 'Name' }] } },
      { snapshotId: 'snapshot-new', text: 'e1 Other', value: { refs: [{ ref: 'e1', role: 'textbox', name: 'Other' }] } },
    )
    try {
      const response = await pool.execute(execution({ id: 'old-ref', peer, code: `
        await snapshot();
        const old = refToLocator({ref: 'e1'});
        await snapshot();
        return await page.locator(old).locator('input').inputValue();
      ` }))
      expect(response).toMatchObject({ ok: true, data: { value: {
        method: 'locator', action: 'inputValue', locator: { snapshotId: 'snapshot-old', steps: [
          { kind: 'selector', engine: 'css', value: 'aria-ref=e1' },
          { kind: 'selector', engine: 'css', value: 'input' },
        ] },
      } } })
      expect(await pool.execute(execution({ id: 'bare-ref', peer, code: "await page.locator('aria-ref=e1').click()" }))).toMatchObject({ ok: false, error: { code: 'stale-snapshot' } })
      expect(await pool.execute(execution({ id: 'explicit-ref', peer, code: "await page.locator('aria-ref=e1', { snapshotId: 'snapshot-old' }).click()" }))).toMatchObject({ ok: true, data: { value: { locator: { snapshotId: 'snapshot-old' } } } })
    } finally {
      await pool.dispose()
    }
  })

  test('applies locator default timeouts, supports clear without options and keeps rich VM values', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      expect(await pool.execute(execution({ id: 'clear', peer, code: "page.setDefaultTimeout(700); return await page.getByTestId('name').clear()" }))).toMatchObject({ ok: true, data: { value: { action: 'fill', args: ['', { timeout: 700 }] } } })
      expect(await pool.execute(execution({ id: 'rich', peer, code: "return { date: new Date('2026-01-01T00:00:00Z'), values: new Set([1, 2]) }" }))).toMatchObject({ ok: true, data: { value: { date: '2026-01-01T00:00:00.000Z', values: [1, 2] } } })
      expect(await pool.execute(execution({ id: 'navigate', peer, code: "await page.goto('https://example.test/next', { waitUntil: 'commit' }); return page.url()" }))).toMatchObject({ ok: true, data: { value: 'https://example.test/current' } })
    } finally {
      await pool.dispose()
    }
  })

  test('keeps state isolated by session/profile and resets it when the connection epoch changes', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      await pool.execute(execution({ id: 'store', peer, code: 'state.secret = 42' }))
      expect(await pool.execute(execution({ id: 'other-session', peer, session: 'session-2', code: 'state.secret ?? null' }))).toMatchObject({ ok: true, data: { value: null } })
      expect(await pool.execute(execution({ id: 'other-profile', peer, profile: 'profile-2', code: 'state.secret ?? null' }))).toMatchObject({ ok: true, data: { value: null } })
      expect(await pool.execute(execution({ id: 'new-epoch', peer, epoch: 'epoch-2', code: 'state.secret ?? null' }))).toMatchObject({ ok: true, data: { value: null } })
    } finally {
      await pool.dispose()
    }
  })

  test('returns explicit unsupported errors for cross-request handles, CDP and unavailable Playwright methods', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      await pool.execute(execution({ id: 'store', peer, code: "state.old = page.getByRole('button')" }))
      const stale = await pool.execute(execution({ id: 'stale', peer, code: 'await state.old.click()' }))
      expect(stale).toMatchObject({ ok: false, error: { code: 'unsupported-capability' } })
      for (const code of ['await page.context().newPage()', 'getCDPSession({page})', "page.getByText(/Save/)", 'await page.close()']) {
        const response = await pool.execute(execution({ id: code, peer, code }))
        expect(response).toMatchObject({ ok: false, error: { code: 'unsupported-capability' } })
      }
      expect(peer.requests.every((request) => { return request.command.method === 'invalidate' })).toBe(true)
    } finally {
      await pool.dispose()
    }
  })

  test('kills synchronous and post-await infinite loops without blocking the parent, then replaces the worker', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      await pool.execute(execution({ id: 'warmup', peer, code: 'return 1' }))
      for (const code of ['while (true) {}', 'await Promise.resolve(); while (true) {}']) {
        const response = await pool.execute(execution({ id: code, peer, code, timeoutMs: 150 }))
        expect(response).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'unknown' } })
        expect(await pool.execute(execution({ id: `replace-${code}`, peer, code: 'return 2' }))).toMatchObject({ ok: true, data: { value: 2 } })
      }
    } finally {
      await pool.dispose()
    }
  })

  test('cancels an in-flight DOM RPC and rejects queued work without replaying later actions', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    const received = barrier()
    const reply = barrier()
    peer.beforeReply = async (request) => {
      if (request.command.method === 'page') {
        received.release()
        await reply.promise
      }
    }
    try {
      const controller = new AbortController()
      const first = pool.execute({
        ...execution({ id: 'cancel', peer, code: "await page.title(); await page.getByText('Danger').click()" }),
        signal: controller.signal,
      })
      await received.promise
      const queued = pool.execute(execution({ id: 'queued', peer, code: 'return 8' }))
      controller.abort(new ManagedCancellation('timeout'))
      await pool.cancel({ sessionId: 'session-1', requestId: 'cancel', reason: 'cancelled' })
      reply.release()
      expect(await first).toMatchObject({ ok: false, error: { code: 'timeout', outcome: 'unknown' } })
      expect(await queued).toMatchObject({ ok: false, error: { outcome: 'not-started' } })
      await delay(50)
      expect(peer.requests.filter((request) => { return request.command.method === 'locator' })).toHaveLength(0)
      expect(await pool.execute(execution({ id: 'recover', peer, code: 'return 9' }))).toMatchObject({ ok: true, data: { value: 9 } })
    } finally {
      reply.release()
      await pool.dispose()
    }
  })

  test('drains an unawaited DOM command and disposes user timers when the execute lease ends', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    const received = barrier()
    const reply = barrier()
    peer.beforeReply = async (request) => {
      if (request.command.method === 'page') {
        received.release()
        await reply.promise
      }
    }
    try {
      const result = pool.execute(execution({ id: 'unawaited', peer, code: 'page.title(); setTimeout(() => { page.content() }, 100); return 3' }))
      await received.promise
      reply.release()
      expect(await result).toMatchObject({ ok: true, data: { value: 3 } })
      await delay(150)
      expect(peer.requests.filter((request) => { return request.command.method === 'page' })).toHaveLength(1)
      expect(await pool.execute(execution({ id: 'next', peer, code: 'return 4' }))).toMatchObject({ ok: true, data: { value: 4 } })
    } finally {
      reply.release()
      await pool.dispose()
    }
  })

  test('refuses a mismatched owner before starting any process or DOM request', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      const input = execution({ id: 'wrong-owner', peer, code: 'return 1' })
      input.request.sessionId = 'other'
      expect(await pool.execute(input)).toMatchObject({ ok: false, error: { code: 'ownership-mismatch', outcome: 'not-started' } })
      expect(peer.requests).toHaveLength(0)
    } finally {
      await pool.dispose()
    }
  })

  test('constructs script-visible APIs, promises, bytes and errors in the execution context', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      const response = await pool.execute(execution({ id: 'context-values', peer, code: `
        const pending = page.title();
        const timer = setTimeout(() => {}, 100);
        clearTimeout(timer);
        const address = new URL('/search?q=hello%20world', 'https://example.test');
        address.searchParams.set('page', '2');
        const encoded = new TextEncoder().encode('Firefox');
        return {
          pageFunction: page.title.constructor.constructor === Function,
          consoleFunction: console.log.constructor === Function,
          promise: pending.constructor === Promise,
          state: Object.getPrototypeOf(state) === null,
          bytes: Buffer.from('abc').constructor.constructor === Function,
          timerType: typeof timer,
          text: new TextDecoder().decode(encoded),
          address: address.href,
          runtimeApi: typeof process.getBuiltinModule,
          bootstrap: typeof globalThis.__createFirefoxExecutorRealm,
        };
      ` }))
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { value: {
        pageFunction: true, consoleFunction: true, promise: true, state: true, bytes: true,
        timerType: 'number', text: 'Firefox', address: 'https://example.test/search?q=hello+world&page=2',
        runtimeApi: 'undefined', bootstrap: 'undefined',
      } } })
    } finally { await pool.dispose() }
  })

  test('reports an unawaited DOM rejection without losing worker state', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.beforeReply = async (request) => {
      if (request.command.method === 'page') return { requestId: request.requestId, ok: false, error: { code: 'execution-failed', message: 'Command peer rejected the page request', outcome: 'unknown' } }
    }
    try {
      const failed = await pool.execute(execution({ id: 'rejected-command', peer, code: 'state.marker = 41; page.title(); return 7' }))
      expect(failed, JSON.stringify(failed)).toMatchObject({ ok: false, error: { code: 'execution-failed' } })
      const continued = await pool.execute(execution({ id: 'continued-state', peer, code: 'return ++state.marker' }))
      expect(continued).toMatchObject({ ok: true, data: { value: 42 } })
      const handled = await pool.execute(execution({ id: 'handled-rejection', peer, code: 'try { await page.title() } catch {} return 12' }))
      expect(handled).toMatchObject({ ok: true, data: { value: 12 } })
    } finally { await pool.dispose() }
  })


  test('keeps URL searchParams identity and mutations live in both directions', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    try {
      const response = await pool.execute(execution({ id: 'url-params', peer, code: `
        const address = new URL('https://example.test/?a=1');
        const params = address.searchParams;
        address.search = '?b=2';
        params.set('c', '3');
        const iterator = params.entries();
        const first = iterator.next().value;
        params.append('d', '4');
        return { same: params === address.searchParams, href: address.href, first, rest: Array.from(iterator) };
      ` }))
      expect(response).toMatchObject({ ok: true, data: { value: {
        same: true, href: 'https://example.test/?b=2&c=3&d=4', first: ['b', '2'], rest: [['c', '3'], ['d', '4']],
      } } })
    } finally { await pool.dispose() }
  })

})
