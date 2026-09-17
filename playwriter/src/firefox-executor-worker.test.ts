import { describe, expect, test } from 'vitest'
import path from 'node:path'
import type { BrowserDomRequest, BrowserExtractFormat, BrowserExtractImagesMode, BrowserResponse, BrowserTab, BrowserResultData } from './browser-protocol.js'
import { parseBrowserDomRequest } from './browser-dom-validation.js'
import {
  MAX_FIREFOX_ASSET_COUNT,
  MAX_FIREFOX_ASSET_TOTAL_BYTES,
  parseFirefoxAssetFetchRequest,
  type FirefoxAssetFetchRequest,
  type FirefoxAssetFetchResponse,
} from './firefox-executor-protocol.js'
import { FirefoxExecutorPool, type FirefoxExecution } from './firefox-executor-pool.js'
import { extractPageContent, windowExtractedText } from './page-extract.js'
import { ManagedCancellation } from './managed-executor-pool.js'

const EXTRACT_DOCUMENT_URL = 'https://example.test/storage'
const EXTRACT_DOCUMENT_TITLE = 'Storage documentation'
const EXTRACT_DOCUMENT_HTML = `<!doctype html><html lang="en"><head><title>${EXTRACT_DOCUMENT_TITLE}</title></head><body><main><article><h1>Storage documentation</h1><p>Retention keeps every revision for thirty days.</p></article></main></body></html>`

/** Longer than the 40,000 character preview budget, so windowing is observable. */
function longDocumentHtml(): string {
  const paragraphs = Array.from({ length: 1_500 }, (_value, index) => {
    return `<p>Retention detail ${index}: the export keeps every revision for thirty days before the purge.</p>`
  }).join('')
  return `<!doctype html><html lang="en"><head><title>${EXTRACT_DOCUMENT_TITLE}</title></head><body><main><article><h1>Storage documentation</h1>${paragraphs}</article></main></body></html>`
}

/**
 * Larger than the 1 MB an evaluated value may return: a real long-form article
 * serializes this way.
 *
 * The bytes come from a few thousand-character paragraphs, not from thousands
 * of short ones: the extraction pipeline's cost grows with the DOM node count
 * far faster than with the byte count, and 5,000 small paragraphs of the same
 * total size pushed the extraction past its 5 s execution deadline on a slow CI
 * runner. The test is about a document too large for an evaluated value, so the
 * same bytes in 200 nodes keep its intent.
 */
function wideDocumentHtml(): string {
  const sentence = 'the exporter keeps every revision of a stored document for thirty days, then purges the oldest revisions in the order they were written until the store is back under its configured quota. '
  const paragraphBody = sentence.repeat(30)
  const paragraphs = Array.from({ length: 200 }, (_value, index) => {
    return `<p>Section ${index} of the retention policy: ${paragraphBody}</p>`
  }).join('')
  return `<!doctype html><html lang="en"><head><title>${EXTRACT_DOCUMENT_TITLE}</title></head><body><main><article><h1>Storage documentation</h1>${paragraphs}</article></main></body></html>`
}

/** One page image as the DOM evaluate command reports it. */
function pageImage({ src, alt = '', width = 800, height = 600, currentSrc, srcset = '' }: {
  src: string
  alt?: string
  width?: number
  height?: number
  currentSrc?: string
  srcset?: string
}): Record<string, unknown> {
  // The page-side enumeration reports the `src` attribute and the URL the
  // browser chose as separate fields, the way the Chrome backend's page read does.
  return { src, currentSrc: currentSrc ?? src, srcset, alt, naturalWidth: width, naturalHeight: height }
}

/** A real protocol peer that records wire commands without pretending to implement a browser DOM. */
class CommandPeer {
  readonly requests: BrowserDomRequest[] = []
  readonly snapshotMessages: BrowserResultData[] = []
  /** Serialized document a real extension returns for a whole-document `page.content` read. */
  documentHtml?: string
  /** Serialized element a real extension returns for a strictly matched `page.content` read. */
  scopedHtml?: string
  /** Images the page reports for the DOM evaluate command the asset manifest uses. */
  pageImages: Record<string, unknown>[] = []
  beforeReply?: (request: BrowserDomRequest) => Promise<void | BrowserResponse>

  async receive(value: BrowserDomRequest): Promise<BrowserResponse> {
    const request = parseBrowserDomRequest(JSON.parse(JSON.stringify(value)))
    if (!request) {
      throw new Error('Invalid DOM wire request')
    }
    this.requests.push(request)
    const override = await this.beforeReply?.(request)
    if (override) return override
    if (this.documentHtml !== undefined && request.command.method === 'page' && request.command.action === 'content') {
      return {
        requestId: request.requestId,
        ok: true,
        data: {
          value: request.command.selector !== undefined ? this.scopedHtml ?? '' : this.documentHtml,
          pageInfo: { tabId: request.tabId, url: EXTRACT_DOCUMENT_URL, title: EXTRACT_DOCUMENT_TITLE },
        },
      }
    }
    return {
      requestId: request.requestId,
      ok: true,
      data: request.command.method === 'snapshot' && this.snapshotMessages.length > 0 ? this.snapshotMessages.shift()! : {
        value: request.command.method === 'evaluate' && this.pageImages.length > 0
          ? { items: this.pageImages }
          : JSON.parse(JSON.stringify(request.command)),
        pageInfo: { tabId: request.tabId, url: 'https://example.test/current', title: 'Command peer' },
      },
    }
  }
}

/**
 * The extension side of the asset byte channel: it records the worker's request
 * and answers with bytes, so a test sees exactly what the runtime would carry.
 */
class AssetPeer {
  readonly requests: FirefoxAssetFetchRequest[] = []
  respond: (request: FirefoxAssetFetchRequest) => Promise<FirefoxAssetFetchResponse> = async (request) => {
    return {
      requestId: request.requestId,
      assets: request.targets.map((target) => {
        return { src: target.src, ok: true, base64: Buffer.from(`bytes:${target.src}`).toString('base64'), mimeType: 'image/png' }
      }),
    }
  }

  async receive(value: FirefoxAssetFetchRequest): Promise<FirefoxAssetFetchResponse> {
    const request = parseFirefoxAssetFetchRequest(JSON.parse(JSON.stringify(value)))
    if (!request) {
      throw new Error('Invalid asset wire request')
    }
    this.requests.push(request)
    return await this.respond(request)
  }
}

function firefoxTab({ session = 'session-1', profile = 'profile-1', epoch = 'epoch-1' }: {
  session?: string
  profile?: string
  epoch?: string
} = {}): BrowserTab {
  return {
    tabId: `tab-${session}`, groupId: `group-${session}`, sessionId: session,
    profileId: profile, url: 'https://example.test/original', title: '',
    state: 'ready', browserEpoch: epoch, revision: 1, chromeTabId: -1, browserTabId: 10,
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
  const tab = firefoxTab({ session, profile, epoch })
  return {
    request: { requestId: id, sessionId: session, cwd: process.cwd(), timeoutMs, operation: { kind: 'page.execute', tabId: tab.tabId, code } },
    tab, connectionEpoch: `connection-${epoch}`,
    sendDomRequest: async (request) => { return await peer.receive(request) },
  }
}

function extractExecution({ id, peer, assetPeer, format, images, selector, search, offset, limit, persist = false, session = 'session-1', profile = 'profile-1', epoch = 'epoch-1', timeoutMs = 5_000 }: {
  id: string
  peer: CommandPeer
  assetPeer?: AssetPeer
  format: BrowserExtractFormat
  images?: BrowserExtractImagesMode
  selector?: string
  search?: string
  offset?: number
  limit?: number
  persist?: boolean
  session?: string
  profile?: string
  epoch?: string
  timeoutMs?: number
}): FirefoxExecution {
  const tab = firefoxTab({ session, profile, epoch })
  return {
    request: {
      requestId: id, sessionId: session, cwd: process.cwd(), timeoutMs,
      operation: {
        kind: 'page.extract', tabId: tab.tabId, format,
        ...(images !== undefined ? { images } : {}),
        ...(selector !== undefined ? { selector } : {}),
        ...(search !== undefined ? { search } : {}),
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
        // Only the presence of a path matters to the worker: it hands the whole
        // extraction back for the relay to write, and never touches this file.
        ...(persist ? { path: path.join(process.cwd(), 'tmp', `${id}.md`) } : {}),
      },
    },
    tab, connectionEpoch: `connection-${epoch}`,
    sendDomRequest: async (request) => { return await peer.receive(request) },
    ...(assetPeer ? { sendAssetRequest: async (request) => { return await assetPeer.receive(request) } } : {}),
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

describe('Firefox executor page.extract', () => {
  test('runs the shared Node pipeline for markdown and text over one serialized document read', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    try {
      const markdown = await pool.execute(extractExecution({ id: 'extract-markdown', peer, format: 'markdown' }))
      const expectedMarkdown = await extractPageContent({ html: EXTRACT_DOCUMENT_HTML, url: EXTRACT_DOCUMENT_URL, format: 'markdown' })
      expect(markdown, JSON.stringify(markdown)).toMatchObject({ ok: true, data: {
        text: expectedMarkdown.text,
        value: { format: 'markdown', truncated: false, totalBytes: expectedMarkdown.totalBytes, title: EXTRACT_DOCUMENT_TITLE },
        pageInfo: { tabId: 'tab-session-1', url: EXTRACT_DOCUMENT_URL, title: EXTRACT_DOCUMENT_TITLE },
      } })
      if (!markdown.ok) {
        throw new Error('expected a successful markdown extraction')
      }
      expect(markdown.data.value).not.toHaveProperty('artifactText')
      const text = await pool.execute(extractExecution({ id: 'extract-text', peer, format: 'text' }))
      const expectedText = await extractPageContent({ html: EXTRACT_DOCUMENT_HTML, url: EXTRACT_DOCUMENT_URL, format: 'text' })
      expect(text).toMatchObject({ ok: true, data: { text: expectedText.text, value: { format: 'text' } } })
      if (!text.ok) {
        throw new Error('expected a successful text extraction')
      }
      expect(text.data.text).not.toContain('#')
      // Extraction only reads the document: one content read per request, no snapshot and no ref invalidation.
      expect(peer.requests.map((request) => { return request.command })).toEqual([
        { method: 'page', action: 'content' },
        { method: 'page', action: 'content' },
      ])
    } finally {
      await pool.dispose()
    }
  })

  test('scopes the extraction to the single element the extension serializes under the requested selector', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    // An element serialized on its own, exactly what the extension returns for a strict match.
    const scopedHtml = `<article id="settings"><h1>Account settings</h1>${Array.from({ length: 8 }, (_value, index) => {
      return `<p>Scoped setting ${index} controls export retention.</p>`
    }).join('')}</article>`
    peer.scopedHtml = scopedHtml
    try {
      const response = await pool.execute(extractExecution({ id: 'extract-scoped', peer, format: 'markdown', selector: '#settings' }))
      expect(peer.requests.map((request) => { return request.command })).toEqual([
        { method: 'page', action: 'content', selector: '#settings' },
      ])
      const expected = await extractPageContent({ html: scopedHtml, url: EXTRACT_DOCUMENT_URL, format: 'markdown' })
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { text: expected.text } })
      if (!response.ok) {
        throw new Error('expected a successful scoped extraction')
      }
      expect(response.data.text).toContain('Account settings')
      expect(response.data.text).toContain('Scoped setting 7 controls export retention.')
      expect(response.data.text).not.toContain('Retention keeps every revision')
    } finally {
      await pool.dispose()
    }
  })

  test('extracts a serialized document larger than the generic evaluate budget', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    const html = wideDocumentHtml()
    const totalBytes = Buffer.byteLength(html, 'utf8')
    expect(totalBytes).toBeGreaterThan(1_000_000)
    expect(totalBytes).toBeLessThan(6 * 1024 * 1024)
    peer.documentHtml = html
    try {
      const markdown = await pool.execute(extractExecution({ id: 'extract-wide', peer, format: 'markdown', limit: 5 }))
      if (!markdown.ok) {
        throw new Error(`expected a successful extraction of a large document: ${JSON.stringify(markdown)}`)
      }
      // The pipeline saw the whole document: its own text is past the value budget too.
      expect(markdown.data.value).toMatchObject({ format: 'markdown', truncated: true })
      const value = markdown.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.totalBytes !== 'number') {
        throw new Error(`expected a structured extract value: ${JSON.stringify(markdown)}`)
      }
      expect(value.totalBytes).toBeGreaterThan(1_000_000)
      expect(markdown.data.text).toContain('Section 0 of the retention policy')
      expect((markdown.data.text ?? '').length).toBeLessThan(40_000)

      // `html` reports the document's own byte count, so the read reached the worker whole.
      const serialized = await pool.execute(extractExecution({ id: 'extract-wide-html', peer, format: 'html', limit: 5 }))
      expect(serialized, JSON.stringify(serialized)).toMatchObject({ ok: true, data: { value: { format: 'html', totalBytes } } })
      expect(peer.requests.map((request) => { return request.command })).toEqual([
        { method: 'page', action: 'content' },
        { method: 'page', action: 'content' },
      ])
    } finally {
      await pool.dispose()
    }
  })

  test('keeps the model preview bounded and hands the whole document to the relay when a path is requested', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    const html = longDocumentHtml()
    peer.documentHtml = html
    try {
      const full = await extractPageContent({ html, url: EXTRACT_DOCUMENT_URL, format: 'markdown', full: true })
      expect(full.text.length).toBeGreaterThan(40_000)
      const persisted = await pool.execute(extractExecution({
        id: 'extract-persist-markdown', peer, format: 'markdown', persist: true, offset: 0, limit: 5,
      }))
      expect(persisted, JSON.stringify(persisted)).toMatchObject({ ok: true, data: {
        text: windowExtractedText({ text: full.text, offset: 0, limit: 5 }).text,
        value: {
          format: 'markdown', truncated: true, totalBytes: Buffer.byteLength(full.text, 'utf8'),
          artifactText: full.text,
        },
      } })
      if (!persisted.ok) {
        throw new Error('expected a successful persisted extraction')
      }
      const previewText = persisted.data.text ?? ''
      expect(previewText.length).toBeLessThan(40_000)
      // Without a path the full extraction never travels: only the bounded preview is returned.
      const inline = await pool.execute(extractExecution({ id: 'extract-inline-markdown', peer, format: 'markdown', offset: 0, limit: 5 }))
      if (!inline.ok) {
        throw new Error('expected a successful inline extraction')
      }
      expect(inline.data.value).not.toHaveProperty('artifactText')
      expect(inline.data.text).toBe(previewText)
      const persistedHtml = await pool.execute(extractExecution({ id: 'extract-persist-html', peer, format: 'html', persist: true }))
      if (!persistedHtml.ok) {
        throw new Error('expected a successful persisted html extraction')
      }
      expect(persistedHtml.data.value).toMatchObject({ format: 'html', truncated: true })
      expect((persistedHtml.data.text ?? '').length).toBeLessThan(html.length)
      const value = persistedHtml.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected a structured extract value')
      }
      expect(value.artifactText).toBe(html)
      expect(value.truncated).toBe(true)
    } finally {
      await pool.dispose()
    }
  })

  test('enumerates page images into a manifest without reading bytes', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [
      pageImage({ src: 'https://cdn.example.test/hero.png', alt: 'Hero', width: 1_200, height: 630 }),
      // An image whose bytes come from a srcset candidate reports both URLs: the
      // `src` attribute the body keeps and the candidate the browser chose.
      pageImage({ src: 'https://cdn.example.test/logo.png', width: 32, height: 32, currentSrc: 'https://cdn.example.test/logo@2x.png' }),
      // A srcset-only image has no `src` attribute but still has bytes to fetch.
      pageImage({ src: '', currentSrc: 'https://cdn.example.test/srcset-only.png' }),
      // Inline bytes and empty sources are page-local, so the manifest skips them.
      pageImage({ src: 'data:image/png;base64,AAAA' }),
      pageImage({ src: '' }),
    ]
    const assetPeer = new AssetPeer()
    try {
      const response = await pool.execute(extractExecution({ id: 'assets-manifest', peer, assetPeer, format: 'assets-manifest' }))
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: {
        value: {
          format: 'assets-manifest',
          assetCount: 3,
          truncated: false,
          assets: [
            { src: 'https://cdn.example.test/hero.png', currentSrc: 'https://cdn.example.test/hero.png', srcset: '', alt: 'Hero', naturalWidth: 1_200, naturalHeight: 630 },
            { src: 'https://cdn.example.test/logo.png', currentSrc: 'https://cdn.example.test/logo@2x.png', alt: '', naturalWidth: 32, naturalHeight: 32 },
            { src: '', currentSrc: 'https://cdn.example.test/srcset-only.png', alt: '', naturalWidth: 800, naturalHeight: 600 },
          ],
        },
        pageInfo: { tabId: 'tab-session-1', url: 'https://example.test/current' },
      } })
      if (!response.ok) {
        throw new Error('expected a successful image manifest')
      }
      expect(response.data.value).not.toHaveProperty('savedAssets')
      expect(response.data.text).toBe('3 images found\n- https://cdn.example.test/hero.png 1200x630 alt="Hero"\n- https://cdn.example.test/logo@2x.png 32x32\n- https://cdn.example.test/srcset-only.png 800x600')
      // The manifest is a read: one DOM evaluate, no document read and no byte fetch.
      expect(peer.requests.map((request) => { return request.command })).toEqual([{ method: 'evaluate', code: expect.any(String) }])
      expect(peer.requests[0].command.method === 'evaluate' ? peer.requests[0].command.code : '').toContain('document.images')
      expect(assetPeer.requests).toHaveLength(0)
    } finally {
      await pool.dispose()
    }
  })

  test('caps the manifest at 200 images and reports the cap', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = Array.from({ length: 205 }, (_value, index) => {
      return pageImage({ src: `https://cdn.example.test/${index}.png` })
    })
    try {
      const response = await pool.execute(extractExecution({ id: 'assets-cap', peer, format: 'assets-manifest' }))
      if (!response.ok) {
        throw new Error(`expected a successful manifest, got ${JSON.stringify(response)}`)
      }
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.assets)) {
        throw new Error('expected a structured asset manifest')
      }
      expect(value.assets).toHaveLength(200)
      expect(value.assetCount).toBe(200)
      expect(value.assetsTruncated).toBe(true)
      expect(value.assets[199]).toMatchObject({ src: 'https://cdn.example.test/199.png' })
    } finally {
      await pool.dispose()
    }
  })

  test('attaches the same manifest to a markdown extraction with images:urls and fetches nothing', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [pageImage({ src: 'https://cdn.example.test/hero.png', alt: 'Hero' })]
    const assetPeer = new AssetPeer()
    try {
      const plain = await pool.execute(extractExecution({ id: 'markdown-plain', peer, format: 'markdown' }))
      const expected = await extractPageContent({ html: EXTRACT_DOCUMENT_HTML, url: EXTRACT_DOCUMENT_URL, format: 'markdown' })
      expect(plain).toMatchObject({ ok: true, data: { text: expected.text } })
      if (!plain.ok) {
        throw new Error('expected a successful markdown extraction')
      }
      expect(plain.data.value).not.toHaveProperty('assets')
      peer.requests.length = 0
      const response = await pool.execute(extractExecution({ id: 'markdown-urls', peer, assetPeer, format: 'markdown', images: 'urls' }))
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { text: expected.text, value: {
        format: 'markdown',
        assets: [{ src: 'https://cdn.example.test/hero.png', alt: 'Hero', naturalWidth: 800, naturalHeight: 600 }],
      } } })
      if (!response.ok) {
        throw new Error('expected a successful markdown extraction with assets')
      }
      expect(response.data.value).not.toHaveProperty('savedAssets')
      expect(assetPeer.requests).toHaveLength(0)
      // One manifest read plus the document read: 'urls' never moves bytes.
      expect(peer.requests.map((request) => { return request.command.method })).toEqual(['evaluate', 'page'])
    } finally {
      await pool.dispose()
    }
  })

  test('saves image bytes through the extension channel and reports failures per image', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [
      pageImage({ src: 'https://cdn.example.test/hero.png', alt: 'Hero' }),
      pageImage({ src: 'https://cdn.example.test/broken.png' }),
      pageImage({ src: 'blob:https://example.test/9c1f' }),
    ]
    const assetPeer = new AssetPeer()
    assetPeer.respond = async (request) => {
      return {
        requestId: request.requestId,
        assets: request.targets.map((target) => {
          if (target.src.endsWith('broken.png')) {
            return { src: target.src, ok: false, reason: 'image request failed with HTTP 404' }
          }
          return { src: target.src, ok: true, base64: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png' }
        }),
      }
    }
    try {
      const response = await pool.execute(extractExecution({ id: 'markdown-save', peer, assetPeer, format: 'markdown', images: 'save' }))
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { value: {
        format: 'markdown',
        savedAssets: [{ base64: Buffer.from('png-bytes').toString('base64'), mimeType: 'image/png', src: 'https://cdn.example.test/hero.png', alt: 'Hero' }],
        failedAssets: [
          // blob: URLs stay page-local: they are reported, never requested.
          { src: 'blob:https://example.test/9c1f', reason: 'unsupported image URL scheme: only http(s) images can be saved' },
          { src: 'https://cdn.example.test/broken.png', reason: 'image request failed with HTTP 404' },
        ],
      } } })
      if (!response.ok) {
        throw new Error('expected a successful save extraction')
      }
      expect(assetPeer.requests).toHaveLength(1)
      expect(assetPeer.requests[0]).toMatchObject({
        requestId: 'markdown-save:assets', sessionId: 'session-1', tabId: 'tab-session-1', browserEpoch: 'epoch-1',
        targets: [{ src: 'https://cdn.example.test/hero.png', alt: 'Hero' }, { src: 'https://cdn.example.test/broken.png' }],
      })
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected a structured extract value')
      }
      expect(value.assetsNotFetched).toBeUndefined()
    } finally {
      await pool.dispose()
    }
  })

  test('reports every URL the page used for an image whose bytes came from a srcset candidate', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [
      pageImage({ src: 'https://cdn.example.test/photo.png', alt: 'Photo', currentSrc: 'https://cdn.example.test/photo-2x.png' }),
    ]
    const assetPeer = new AssetPeer()
    try {
      const response = await pool.execute(extractExecution({ id: 'markdown-save-aliases', peer, assetPeer, format: 'markdown', images: 'save' }))
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { value: {
        savedAssets: [{
          base64: Buffer.from('bytes:https://cdn.example.test/photo-2x.png').toString('base64'),
          mimeType: 'image/png',
          // The bytes come from the candidate, so that is the saved URL; the
          // `src` attribute the extracted body keeps travels as an alias, and
          // the relay rewrites every one of them.
          src: 'https://cdn.example.test/photo-2x.png',
          sourceUrls: ['https://cdn.example.test/photo.png', 'https://cdn.example.test/photo-2x.png'],
          alt: 'Photo',
        }],
      } } })
      // The extension channel is only asked for the URL it should fetch.
      expect(assetPeer.requests[0].targets).toEqual([{ src: 'https://cdn.example.test/photo-2x.png', alt: 'Photo' }])
    } finally {
      await pool.dispose()
    }
  })

  test('keeps the saved asset minimal when the page names an image by one URL', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [pageImage({ src: 'https://cdn.example.test/hero.png', alt: 'Hero' })]
    const assetPeer = new AssetPeer()
    try {
      const response = await pool.execute(extractExecution({ id: 'markdown-save-one-url', peer, assetPeer, format: 'markdown', images: 'save' }))
      if (!response.ok) {
        throw new Error(`expected a successful save extraction, got ${JSON.stringify(response)}`)
      }
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.savedAssets)) {
        throw new Error('expected a structured extract value')
      }
      const saved = value.savedAssets[0] as Record<string, unknown>
      expect(saved).not.toHaveProperty('sourceUrls')
      expect(saved).toEqual({
        base64: Buffer.from('bytes:https://cdn.example.test/hero.png').toString('base64'),
        mimeType: 'image/png',
        src: 'https://cdn.example.test/hero.png',
        alt: 'Hero',
      })
    } finally {
      await pool.dispose()
    }
  })

  test('fetches only the channel target bound and counts the images it left out', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = Array.from({ length: MAX_FIREFOX_ASSET_COUNT + 4 }, (_value, index) => {
      return pageImage({ src: `https://cdn.example.test/${index}.png` })
    })
    const assetPeer = new AssetPeer()
    try {
      const response = await pool.execute(extractExecution({ id: 'manifest-save-cap', peer, assetPeer, format: 'assets-manifest', images: 'save' }))
      if (!response.ok) {
        throw new Error(`expected a successful save extraction, got ${JSON.stringify(response)}`)
      }
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected a structured extract value')
      }
      expect(assetPeer.requests).toHaveLength(1)
      expect(assetPeer.requests[0].targets).toHaveLength(MAX_FIREFOX_ASSET_COUNT)
      expect(value.savedAssets).toHaveLength(MAX_FIREFOX_ASSET_COUNT)
      expect(value.assetCount).toBe(MAX_FIREFOX_ASSET_COUNT + 4)
      expect(value.assetsNotFetched).toBe(4)
    } finally {
      await pool.dispose()
    }
  })

  test('clamps the manifest fields and bounds the manifest by bytes, not only by its entry cap', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    const longSrcset = Array.from({ length: 300 }, (_value, index) => {
      return `https://cdn.example.test/candidate-${index}.png ${index + 1}x`
    }).join(', ')
    peer.pageImages = Array.from({ length: 200 }, (_value, index) => {
      return pageImage({ src: `https://cdn.example.test/${'deeply-nested-segment/'.repeat(8)}${index}.png`, alt: 'a'.repeat(2_000), srcset: longSrcset })
    })
    try {
      const response = await pool.execute(extractExecution({ id: 'manifest-budget', peer, format: 'assets-manifest' }))
      if (!response.ok) {
        throw new Error(`expected a successful manifest, got ${JSON.stringify(response)}`)
      }
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.assets)) {
        throw new Error('expected a structured asset manifest')
      }
      const assets = value.assets as Array<Record<string, unknown>>
      expect(assets.length).toBeGreaterThan(0)
      expect(assets.length).toBeLessThan(200)
      expect(value.assetCount).toBe(assets.length)
      expect(value.assetsTruncated).toBe(true)
      // The listing stays inside the same budget the Chrome backend applies.
      expect(assets.reduce((total, asset) => { return total + Buffer.byteLength(JSON.stringify(asset), 'utf8') + 1 }, 0)).toBeLessThanOrEqual(40_000)
      expect((assets[0].srcset as string)).toHaveLength(2_048)
      expect((assets[0].alt as string)).toHaveLength(512)
      expect(response.data.text).toContain('images found (listing the first ones)')
    } finally {
      await pool.dispose()
    }
  })

  test('carries a full-budget asset batch without exhausting the worker heap', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = Array.from({ length: MAX_FIREFOX_ASSET_COUNT }, (_value, index) => {
      return pageImage({ src: `https://cdn.example.test/big-${index}.png` })
    })
    const assetPeer = new AssetPeer()
    // The channel's whole byte budget in one batch: 20 images of 3.2 MiB is
    // 64 MiB of bytes, which arrives as roughly 85 MiB of base64 text in the
    // single frame the worker has to parse, check and answer from.
    const imageBase64 = Buffer.alloc(MAX_FIREFOX_ASSET_TOTAL_BYTES / MAX_FIREFOX_ASSET_COUNT, 7).toString('base64')
    assetPeer.respond = async (request) => {
      return {
        requestId: request.requestId,
        assets: request.targets.map((target) => {
          return { src: target.src, ok: true, base64: imageBase64, mimeType: 'image/png' }
        }),
      }
    }
    try {
      const response = await pool.execute(extractExecution({
        id: 'assets-full-budget', peer, assetPeer, format: 'assets-manifest', images: 'save', timeoutMs: 30_000,
      }))
      if (!response.ok) {
        throw new Error(`expected the full-budget batch to succeed, got ${JSON.stringify(response)}`)
      }
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.savedAssets)) {
        throw new Error('expected a structured extract value')
      }
      expect(value.savedAssets).toHaveLength(MAX_FIREFOX_ASSET_COUNT)
      expect((value.savedAssets[0] as Record<string, unknown>).base64).toBe(imageBase64)
      expect(value.failedAssets).toBeUndefined()
      expect(value.assetsNotFetched).toBeUndefined()
    } finally {
      await pool.dispose()
    }
  })

  test('reports every image as failed when the runtime cannot carry asset bytes', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [pageImage({ src: 'https://cdn.example.test/hero.png', alt: 'Hero' })]
    try {
      // No sendAssetRequest: the runtime has no channel, so 'save' degrades to a
      // reported failure instead of losing the extraction.
      const response = await pool.execute(extractExecution({ id: 'markdown-save-unavailable', peer, format: 'markdown', images: 'save' }))
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true, data: { value: {
        format: 'markdown',
        failedAssets: [{ src: 'https://cdn.example.test/hero.png', reason: expect.stringContaining('cannot fetch image bytes') }],
      } } })
      if (!response.ok) {
        throw new Error('expected the extraction to survive a missing asset channel')
      }
      expect(response.data.text).toContain('Storage documentation')
    } finally {
      await pool.dispose()
    }
  })

  test('reports every image as failed when the extension answers with a channel error', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.pageImages = [pageImage({ src: 'https://cdn.example.test/hero.png' }), pageImage({ src: 'https://cdn.example.test/other.png' })]
    const assetPeer = new AssetPeer()
    assetPeer.respond = async (request) => {
      return { requestId: request.requestId, assets: [], error: 'Firefox asset request failed: extension disconnected' }
    }
    try {
      const response = await pool.execute(extractExecution({ id: 'markdown-save-error', peer, assetPeer, format: 'markdown', images: 'save' }))
      if (!response.ok) {
        throw new Error(`expected a successful extraction, got ${JSON.stringify(response)}`)
      }
      const value = response.data.value
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('expected a structured extract value')
      }
      expect(value.failedAssets).toEqual([
        { src: 'https://cdn.example.test/hero.png', reason: 'Firefox asset request failed: extension disconnected' },
        { src: 'https://cdn.example.test/other.png', reason: 'Firefox asset request failed: extension disconnected' },
      ])
      expect(value.savedAssets).toBeUndefined()
    } finally {
      await pool.dispose()
    }
  })

  test('surfaces a strict multi-match as a read failure instead of extracting the first element', async () => {
    const pool = new FirefoxExecutorPool()
    const peer = new CommandPeer()
    peer.documentHtml = EXTRACT_DOCUMENT_HTML
    peer.scopedHtml = EXTRACT_DOCUMENT_HTML
    peer.beforeReply = async (request) => {
      if (request.command.method === 'page' && request.command.action === 'content' && request.command.selector === '.repeated') {
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: 'execution-failed',
            message: 'Strict locator requires exactly one element; matched 2. Refine the selector or use an explicit nth().',
            outcome: 'not-started',
          },
        }
      }
    }
    try {
      const failed = await pool.execute(extractExecution({ id: 'extract-strict', peer, format: 'markdown', selector: '.repeated' }))
      expect(failed).toMatchObject({ ok: false, error: { code: 'execution-failed', outcome: 'not-started' } })
      if (failed.ok) {
        throw new Error('expected a failed scoped extraction')
      }
      expect(failed.error.message).toContain('Firefox page.extract')
      expect(peer.requests).toHaveLength(1)
    } finally {
      await pool.dispose()
    }
  })
})
