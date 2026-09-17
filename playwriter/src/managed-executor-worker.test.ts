import { EventEmitter } from 'node:events'
import http from 'node:http'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { BrowserPageOperation, BrowserRequest, BrowserResponse, BrowserTab, ManagedExecution } from './browser-protocol.js'

const connectOverCDP = vi.hoisted(() => {
  return vi.fn()
})

vi.mock('./playwright-import.js', () => {
  return {
    getChromium: async () => {
      return { connectOverCDP }
    },
  }
})

import {
  attachObservedPageInfo,
  calculateNativeOperationTimeout,
  formatSnapshotText,
  ManagedExecutorWorkerRuntime,
} from './managed-executor-worker.js'

type FakePageImage = {
  src: string
  currentSrc?: string
  srcset?: string
  alt?: string
  naturalWidth?: number
  naturalHeight?: number
}

type FakePageGlyph = {
  src: string
  currentSrc: string
  srcset: string
  alt: string
  naturalWidth: number
  naturalHeight: number
}

/**
 * A page-side image element: the fake exposes the same properties the worker's
 * in-page enumeration reads, so the real page function runs against it.
 */
function createPageGlyph(image: FakePageImage): FakePageGlyph & { getAttribute: (name: string) => string | null } {
  return {
    src: image.src,
    currentSrc: image.currentSrc ?? '',
    srcset: image.srcset ?? '',
    alt: image.alt ?? '',
    naturalWidth: image.naturalWidth ?? 0,
    naturalHeight: image.naturalHeight ?? 0,
    getAttribute: (name: string): string | null => {
      if (name === 'alt') {
        return image.alt ?? null
      }
      if (name === 'srcset') {
        return image.srcset ?? null
      }
      return null
    },
  }
}

class FakePage extends EventEmitter {
  html = '<html><head><title>Example</title></head><body><article><p>Example body text.</p></article></body></html>'
  selectedHtml = '<article><p>Selected body text.</p></article>'
  /** Images the in-page enumeration sees. */
  images: FakePageImage[] = []
  /** Image bytes the page's own fetch can read, the way a CORS-enabled image would. */
  pageFetchable = new Map<string, { body: Uint8Array; contentType: string; declaredBytes?: number }>()
  /** URLs the page's own fetch refuses, the way a cross-origin image without CORS headers fails. */
  pageFetchBlocked = new Set<string>()
  pageFetchUrls: string[] = []
  pageFetchCredentials: string[] = []
  private readonly pageTitle: string

  constructor(private readonly id: string, title = 'Example') {
    super()
    this.pageTitle = title
  }

  targetId(): string {
    return this.id
  }

  url(): string {
    return 'https://example.com/'
  }

  isClosed(): boolean {
    return false
  }

  async content(): Promise<string> {
    return this.html
  }

  async title(): Promise<string> {
    return this.pageTitle
  }

  /**
   * Run a page function with the page-side globals it expects. The worker's
   * functions are already written for a browser realm, so the fake only has to
   * provide the DOM and fetch surface they read.
   */
  async evaluate<Arg, R>(pageFunction: (arg: Arg) => R | Promise<R>, arg: Arg): Promise<R> {
    const globals = globalThis as unknown as Record<string, unknown>
    const previous = {
      document: globals.document,
      fetch: globals.fetch,
      btoa: globals.btoa,
    }
    globals.document = { images: this.images.map((image) => createPageGlyph(image)) }
    globals.fetch = async (url: string, init: { credentials?: string }) => {
      this.pageFetchUrls.push(url)
      this.pageFetchCredentials.push(init?.credentials ?? '')
      const served = this.pageFetchBlocked.has(url) ? undefined : this.pageFetchable.get(url)
      if (!served) {
        throw new TypeError('Failed to fetch')
      }
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) => {
            const header = name.toLowerCase()
            if (header === 'content-type') {
              return served.contentType
            }
            if (header === 'content-length' && served.declaredBytes !== undefined) {
              return String(served.declaredBytes)
            }
            return null
          },
        },
        arrayBuffer: async () => {
          return served.body.buffer.slice(served.body.byteOffset, served.body.byteOffset + served.body.byteLength)
        },
      }
    }
    globals.btoa = (value: string) => {
      return Buffer.from(value, 'binary').toString('base64')
    }
    try {
      return await pageFunction(arg)
    } finally {
      globals.document = previous.document
      globals.fetch = previous.fetch
      globals.btoa = previous.btoa
    }
  }

  locator(): { evaluate: <R>(pageFunction: (element: { outerHTML: string }) => R) => Promise<R> } {
    return {
      evaluate: async <R>(pageFunction: (element: { outerHTML: string }) => R): Promise<R> => {
        return pageFunction({ outerHTML: this.selectedHtml })
      },
    }
  }
}

/** Serve image bytes over real HTTP for the worker-side fetch fallback. */
async function serveImage({ body, contentType }: { body: Uint8Array; contentType: string }): Promise<{
  url: string
  /** Requests the server answered, so a test can prove a fetch never happened. */
  hits: () => number
  close: () => Promise<void>
}> {
  let hits = 0
  const server = http.createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'content-type': contentType })
    response.end(body)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/image.png`,
    hits: () => {
      return hits
    },
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve()
        })
      })
    },
  }
}

class FakeContext extends EventEmitter {
  private readonly currentPages: Page[] = []

  pages(): Page[] {
    return [...this.currentPages]
  }

  addPage(page: Page): void {
    this.currentPages.push(page)
    this.emit('page', page)
  }
}

class FakeBrowser extends EventEmitter {
  constructor(private readonly context: BrowserContext) {
    super()
  }

  contexts(): BrowserContext[] {
    return [this.context]
  }
}

async function waitForCondition({ predicate, message }: { predicate: () => boolean; message: string }): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if (predicate()) {
      return
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 5)
    })
  }
  throw new Error(`timed out waiting for ${message}`)
}

function createExecution({ timeoutMs }: { timeoutMs: number }): ManagedExecution {
  return createOperationExecution({ timeoutMs, operation: { kind: 'page.logs', tabId: 'tab-1', limit: 1 } })
}

function createOperationExecution({
  timeoutMs,
  operation,
  requestId = 'request-1',
}: {
  timeoutMs: number
  operation: BrowserPageOperation
  requestId?: string
}): ManagedExecution {
  const request: BrowserRequest & { operation: BrowserPageOperation } = {
    requestId,
    sessionId: 'session-1',
    timeoutMs,
    operation,
  }
  const tab: BrowserTab = {
    tabId: 'tab-1',
    groupId: 'group-1',
    sessionId: 'session-1',
    profileId: 'profile-1',
    url: 'https://example.com/',
    title: 'Example',
    state: 'ready',
    browserEpoch: 'epoch-1',
    revision: 1,
    chromeTabId: 1,
    targetId: 'target-1',
  }
  return {
    request,
    tab,
    cdpUrl: 'ws://managed-profile',
    connectionEpoch: 'connection-1',
  }
}

/** Start a request and resolve the target page the way the worker expects. */
async function executeWithPage({
  operation,
  page,
  timeoutMs = 4_000,
}: {
  operation: BrowserPageOperation
  page: FakePage
  timeoutMs?: number
}): Promise<BrowserResponse> {
  const context = new FakeContext()
  const browser = new FakeBrowser(context as unknown as BrowserContext)
  connectOverCDP.mockResolvedValue(browser as unknown as Browser)
  const runtime = new ManagedExecutorWorkerRuntime()
  const pending = runtime.execute(createOperationExecution({ timeoutMs, operation }))
  await waitForCondition({
    predicate: () => {
      return context.listenerCount('page') === 2
    },
    message: 'target page listener',
  })
  context.addPage(page as unknown as Page)
  const response = await pending
  await runtime.dispose()
  return response
}

describe('managed executor target initialization', () => {
  afterEach(() => {
    connectOverCDP.mockReset()
  })

  test('waits for the requested target page event and removes the temporary listener', async () => {
    const context = new FakeContext()
    const browser = new FakeBrowser(context as unknown as BrowserContext)
    connectOverCDP.mockResolvedValue(browser as unknown as Browser)
    const runtime = new ManagedExecutorWorkerRuntime()

    const pending = runtime.execute(createExecution({ timeoutMs: 500 }))
    await waitForCondition({
      predicate: () => {
        return context.listenerCount('page') === 2
      },
      message: 'target page listener',
    })

    const page = new FakePage('target-1')
    context.addPage(page as unknown as Page)
    const response = await pending

    expect(response).toMatchObject({
      requestId: 'request-1',
      ok: true,
      data: { logs: [], pageInfo: { tabId: 'tab-1', url: 'https://example.com/' } },
    })
    expect(context.listenerCount('page')).toBe(1)

    await runtime.dispose()
    expect(context.listenerCount('page')).toBe(0)
    expect(browser.listenerCount('disconnected')).toBe(0)
  })
})

describe('managed executor pure result helpers', () => {
  test('formats search context, offset, and limit with only the displayed refs', () => {
    const snapshotLines = Array.from({ length: 14 }, (_, index) => {
      return { text: `line ${index}${index === 7 ? ' target' : ''}`, shortRef: `e${index}` }
    })
    const refs = snapshotLines.map((line) => {
      return { shortRef: line.shortRef, role: 'button', name: line.text }
    })

    const result = formatSnapshotText({ snapshotLines, refs, search: 'target', offset: 2, limit: 3 })

    expect(result.text).toBe(
      'line 4\nline 5\nline 6\n[truncated; use search or offset/limit in execute snapshot helper]',
    )
    expect([...result.visibleRefs]).toEqual(['e4', 'e5', 'e6'])
  })

  test('returns no refs when snapshot search has no matches', () => {
    const result = formatSnapshotText({
      snapshotLines: [{ text: '- button Alpha', shortRef: 'e1' }],
      refs: [{ shortRef: 'e1', role: 'button', name: 'Alpha' }],
      search: 'missing',
      offset: 0,
    })

    expect(result.text).toBe('No matches found')
    expect([...result.visibleRefs]).toEqual([])
  })

  test('keeps refs structurally tied to complete UTF-8 lines after text truncation', () => {
    const marker = '[truncated; use search or offset/limit in execute snapshot helper]'
    const first = '- button Alpha'
    const snapshotLines = [
      { text: first, shortRef: 'e1' },
      { text: '- button 中文中文中文', shortRef: 'e2' },
    ]
    const refs = [
      { shortRef: 'e1', role: 'button', name: 'Alpha' },
      { shortRef: 'e2', role: 'button', name: '中文中文中文' },
    ]
    const maxBytes = Buffer.byteLength(`${first}\n${marker}`, 'utf8')

    const result = formatSnapshotText({
      snapshotLines,
      refs,
      offset: 0,
      maxBytes,
      maxChars: 1_000,
    })

    expect(result.text).toBe(`${first}\n${marker}`)
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(maxBytes)
    expect([...result.visibleRefs]).toEqual(['e1'])
  })

  test('applies the character cap without splitting a Unicode code point', () => {
    const marker = '[truncated; use search or offset/limit in execute snapshot helper]'
    const result = formatSnapshotText({
      snapshotLines: [{ text: '😀😀' }],
      refs: [],
      offset: 0,
      maxChars: marker.length + 3,
      maxBytes: 1_000,
    })

    expect(result.text).toBe(`😀\n${marker}`)
    expect(result.text.length).toBeLessThanOrEqual(marker.length + 3)
  })

  test('stops text and refs together before the structured refs budget is exceeded', () => {
    const refs = [
      { shortRef: 'e1', role: 'button', name: 'Alpha' },
      { shortRef: 'e2', role: 'button', name: 'Beta' },
    ]
    const result = formatSnapshotText({
      snapshotLines: [
        { text: '- button Alpha', shortRef: 'e1' },
        { text: '- button Beta', shortRef: 'e2' },
      ],
      refs,
      offset: 0,
      maxRefsBytes: Buffer.byteLength(JSON.stringify({ refs: [refs[0]] }), 'utf8'),
    })

    expect(result.text).toContain('- button Alpha')
    expect(result.text).not.toContain('- button Beta')
    expect([...result.visibleRefs]).toEqual(['e1'])
  })

  test('only navigation results can contribute an observed page title', () => {
    const evaluated = attachObservedPageInfo({
      data: { value: { title: 'business title' } },
      tabId: 'tab-1',
      url: 'https://example.com/evaluate',
      operationKind: 'page.evaluate',
    })
    const navigated = attachObservedPageInfo({
      data: { value: { title: 'Page title', url: 'https://example.com/navigate' } },
      tabId: 'tab-1',
      url: 'https://example.com/navigate',
      operationKind: 'page.navigate',
    })

    expect(evaluated.pageInfo).toEqual({ tabId: 'tab-1', url: 'https://example.com/evaluate' })
    expect(navigated.pageInfo).toEqual({ tabId: 'tab-1', url: 'https://example.com/navigate', title: 'Page title' })
  })

  test('derives native timeouts from the remaining request budget with response reserve', () => {
    expect(calculateNativeOperationTimeout({ deadline: 10_000, now: 1_000, maximumMs: 5_000 })).toBe(5_000)
    expect(calculateNativeOperationTimeout({ deadline: 2_000, now: 1_000, maximumMs: 5_000 })).toBe(750)
    expect(calculateNativeOperationTimeout({ deadline: 1_200, now: 1_000, maximumMs: 5_000 })).toBe(0)
  })
})

describe('managed executor page.extract', () => {
  test('runs the extraction pipeline over the page HTML', async () => {
    const page = new FakePage('target-1')
    page.html = `<html><head><title>Retention policy</title>
      <meta name="author" content="Dana Whitfield">
      <meta property="og:site_name" content="Storage Docs">
      </head><body><nav>Getting started</nav><article><h1>Retention policy</h1>
      <p>A retention policy prevents objects from being deleted for a fixed period.</p></article>
      <footer>All rights reserved</footer></body></html>`

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown' },
    })

    expect(response).toMatchObject({
      ok: true,
      data: {
        value: { format: 'markdown', truncated: false, title: 'Retention policy', metadata: { author: 'Dana Whitfield' } },
        pageInfo: { tabId: 'tab-1', url: 'https://example.com/' },
      },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }
    expect(response.data.text).toContain('# Retention policy')
    expect(response.data.text).toContain('prevents objects from being deleted')
    expect(response.data.text).not.toContain('Getting started')
    expect(response.data.text).not.toContain('All rights reserved')
    expect(response.data.value).not.toHaveProperty('artifactText')
  })

  test('scopes extraction to the selector and to the requested window', async () => {
    const page = new FakePage('target-1')
    const filler = Array.from({ length: 20 }, (_unused, index) => {
      return `<p>Filler paragraph ${index} carries no keyword.</p>`
    }).join('')
    page.selectedHtml = `<article><h1>Chosen</h1><p>alpha marker</p>${filler}<p>omega marker</p></article>`

    const markdown = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', selector: 'article' },
    })
    expect(markdown).toMatchObject({ ok: true, data: { value: { format: 'markdown' } } })
    if (!markdown.ok) {
      throw new Error('expected a successful page.extract')
    }
    expect(markdown.data.text).toContain('Chosen')
    expect(markdown.data.text).toContain('omega marker')
    expect(markdown.data.text).not.toContain('Example body text')

    const text = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'text', selector: 'article', search: 'alpha marker' },
    })
    if (!text.ok) {
      throw new Error('expected a successful page.extract')
    }
    expect(text.data.text).toContain('alpha marker')
    expect(text.data.text).not.toContain('omega marker')
    expect(text.data.value).toMatchObject({ truncated: true })
  })

  test('bounds the html format with the same budget and hands the whole document to a persistence request', async () => {
    const page = new FakePage('target-1', 'Serialized page')
    page.html = `<html><body><article><p>${'x'.repeat(400_000)}</p></article></body></html>`

    const preview = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'html' },
    })
    if (!preview.ok) {
      throw new Error('expected a successful page.extract')
    }
    const previewText = preview.data.text ?? ''
    expect(previewText.length).toBeGreaterThan(39_000)
    expect(previewText.length).toBeLessThanOrEqual(40_000)
    expect(preview.data.value).toMatchObject({
      format: 'html',
      truncated: true,
      totalBytes: Buffer.byteLength(page.html, 'utf8'),
      title: 'Serialized page',
    })
    expect(preview.data.value).not.toHaveProperty('artifactText')

    const persisted = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'html', path: '/tmp/page.html' },
    })
    if (!persisted.ok) {
      throw new Error('expected a successful page.extract')
    }
    // The preview stays the same whether or not the caller persists the file.
    expect(persisted.data.text ?? '').toBe(previewText)
    expect(persisted.data.value).toMatchObject({ truncated: true })
    const value = persisted.data.value
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('expected a structured extract value')
    }
    expect(value.artifactText).toBe(page.html)
  })
})

describe('managed executor page.extract images', () => {
  test('lists the page images as an assets manifest and skips sources that carry no bytes', async () => {
    const page = new FakePage('target-1')
    page.images = [
      { src: 'https://cdn.example.com/chart.png', alt: 'Chart', naturalWidth: 640, naturalHeight: 480 },
      {
        src: 'https://cdn.example.com/photo.jpg',
        currentSrc: 'https://cdn.example.com/photo-2x.jpg',
        srcset: 'photo.jpg 1x, photo-2x.jpg 2x',
      },
      { src: 'data:image/png;base64,AAAA' },
      { src: '' },
    ]

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'assets-manifest' },
    })
    if (!response.ok) {
      throw new Error('expected a successful assets-manifest extraction')
    }

    expect(response.data.value).toMatchObject({
      format: 'assets-manifest',
      truncated: false,
      assetCount: 2,
      assets: [
        {
          src: 'https://cdn.example.com/chart.png',
          currentSrc: '',
          srcset: '',
          alt: 'Chart',
          naturalWidth: 640,
          naturalHeight: 480,
        },
        {
          src: 'https://cdn.example.com/photo.jpg',
          currentSrc: 'https://cdn.example.com/photo-2x.jpg',
          srcset: 'photo.jpg 1x, photo-2x.jpg 2x',
          alt: '',
          naturalWidth: 0,
          naturalHeight: 0,
        },
      ],
    })
    expect(response.data.value).not.toHaveProperty('assetsTruncated')
    expect(response.data.text).toContain('2 images found')
    expect(response.data.text).toContain('- https://cdn.example.com/chart.png 640x480 alt="Chart"')
    // The chosen srcset candidate is the URL an image fetch would have to use.
    expect(response.data.text).toContain('- https://cdn.example.com/photo-2x.jpg')
    expect(page.pageFetchUrls).toEqual([])
  })

  test("attaches the same manifest for images: 'urls' and fetches nothing", async () => {
    const page = new FakePage('target-1')
    page.images = [{ src: 'https://cdn.example.com/chart.png', alt: 'Chart' }]

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'urls' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    expect((response.data.value as Record<string, unknown>).assetCount).toBe(1)
    expect((response.data.value as Record<string, unknown>).assets).toEqual([
      {
        src: 'https://cdn.example.com/chart.png',
        currentSrc: '',
        srcset: '',
        alt: 'Chart',
        naturalWidth: 0,
        naturalHeight: 0,
      },
    ])
    expect(response.data.value).not.toHaveProperty('savedAssets')
    expect(response.data.text).toContain('Example body text')
    expect(page.pageFetchUrls).toEqual([])
  })

  test("saves image bytes through the page fetch with the page's cookies", async () => {
    const page = new FakePage('target-1')
    page.images = [
      { src: 'https://cdn.example.com/chart.png', alt: 'Chart' },
      { src: 'https://cdn.example.com/logo.svg' },
    ]
    page.pageFetchable.set('https://cdn.example.com/chart.png', {
      body: new Uint8Array(Buffer.from('chart-bytes')),
      contentType: 'image/png; charset=binary',
    })
    page.pageFetchable.set('https://cdn.example.com/logo.svg', {
      body: new Uint8Array(Buffer.from('<svg/>')),
      contentType: 'image/svg+xml',
    })

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    expect((response.data.value as Record<string, unknown>).savedAssets).toEqual([
      {
        base64: Buffer.from('chart-bytes').toString('base64'),
        mimeType: 'image/png',
        src: 'https://cdn.example.com/chart.png',
        alt: 'Chart',
      },
      { base64: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml', src: 'https://cdn.example.com/logo.svg' },
    ])
    expect(response.data.value).not.toHaveProperty('failedAssets')
    // A save reports the same inventory a listing does, so the caller sees what
    // was there next to what was saved.
    expect(response.data.value).toMatchObject({
      assetCount: 2,
      assets: [
        { src: 'https://cdn.example.com/chart.png', currentSrc: '', alt: 'Chart' },
        { src: 'https://cdn.example.com/logo.svg', currentSrc: '', alt: '' },
      ],
    })
    expect(response.data.value).not.toHaveProperty('assetsTruncated')
    expect(response.data.value).not.toHaveProperty('assetsNotFetched')
    expect(page.pageFetchCredentials).toEqual(['include', 'include'])
    // Image bytes travel to the relay, never on the model-inline image channel.
    expect(response.data.images).toBeUndefined()
  })

  test('names every URL of a saved image so the relay can rewrite the one the body kept', async () => {
    const page = new FakePage('target-1')
    page.images = [{
      src: 'https://cdn.example.com/photo.jpg',
      currentSrc: 'https://cdn.example.com/photo-2x.jpg',
      srcset: 'photo.jpg 1x, photo-2x.jpg 2x',
      alt: 'Photo',
    }]
    page.pageFetchable.set('https://cdn.example.com/photo-2x.jpg', {
      body: new Uint8Array(Buffer.from('photo-bytes')),
      contentType: 'image/png',
    })

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    // The srcset candidate is what a fetch can use; the `src` attribute is what
    // the extracted body usually keeps.
    expect((response.data.value as Record<string, unknown>).savedAssets).toEqual([{
      base64: Buffer.from('photo-bytes').toString('base64'),
      mimeType: 'image/png',
      src: 'https://cdn.example.com/photo-2x.jpg',
      sourceUrls: ['https://cdn.example.com/photo.jpg', 'https://cdn.example.com/photo-2x.jpg'],
      alt: 'Photo',
    }])
    expect(page.pageFetchUrls).toEqual(['https://cdn.example.com/photo-2x.jpg'])
  })

  test('refuses a private or loopback image in the node fallback instead of letting a page probe the network', async () => {
    const served = await serveImage({ body: new Uint8Array(Buffer.from('intranet-bytes')), contentType: 'image/png' })
    try {
      const page = new FakePage('target-1')
      const blocked = [
        // A reachable loopback server: only the guard keeps the fallback from hitting it.
        served.url,
        'http://10.1.2.3/internal.png',
        'http://172.16.4.4/private.png',
        'http://192.168.1.1/router.png',
        'http://169.254.169.254/latest/meta-data.png',
        'http://0.0.0.0/zero.png',
        'http://[::1]/v6.png',
        'http://[::ffff:127.0.0.1]/mapped.png',
        'http://[fd00::1]/unique-local.png',
        'http://2130706433/decimal.png',
        'http://0x7f000001/hex.png',
        'http://0177.0.0.1/octal.png',
        'http://localhost/loc.png',
        'http://metadata.localhost/loc.png',
      ]
      page.images = blocked.map((src) => { return { src } })
      for (const src of blocked) {
        page.pageFetchBlocked.add(src)
      }

      const response = await executeWithPage({
        page,
        operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
      })
      if (!response.ok) {
        throw new Error('expected a successful page.extract')
      }

      const value = response.data.value as Record<string, unknown>
      expect(value.savedAssets).toEqual([])
      const failed = value.failedAssets as Array<{ src: string; reason: string }>
      expect(failed.map((entry) => { return entry.src })).toEqual(blocked)
      for (const entry of failed) {
        expect(entry.reason).toContain('page fetch failed (Failed to fetch)')
        expect(entry.reason).toContain('will not fetch a loopback, private or link-local address')
      }
      // The guard runs before the request: the loopback server never saw one.
      expect(served.hits()).toBe(0)
      expect(page.pageFetchUrls).toEqual(blocked)
    } finally {
      await served.close()
    }
  })

  test('leaves a public image to the node fallback instead of refusing it as private', async () => {
    const page = new FakePage('target-1')
    // The reserved `.invalid` TLD never resolves, so the fallback fails fast
    // and for a reason that proves the guard let the URL through: it is a
    // fetch failure, not a refusal.
    const publicUrl = 'http://cdn.example.invalid/image.png'
    const unreachable = 'http://127.0.0.1:9/missing.png'
    page.images = [{ src: publicUrl }, { src: unreachable }]
    page.pageFetchBlocked.add(publicUrl)
    page.pageFetchBlocked.add(unreachable)

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    const failed = (response.data.value as Record<string, unknown>).failedAssets as Array<{ src: string; reason: string }>
    expect(failed.map((entry) => { return entry.src })).toEqual([publicUrl, unreachable])
    expect(failed[0].reason).toContain('page fetch failed (Failed to fetch)')
    expect(failed[0].reason).toContain('node fetch failed')
    expect(failed[0].reason).not.toContain('will not fetch a loopback, private or link-local address')
    expect(failed[1].reason).toContain('will not fetch a loopback, private or link-local address')
  })

  test('bounds the manifest to its entry cap and the saved set to its image cap', async () => {
    const page = new FakePage('target-1')
    page.images = Array.from({ length: 205 }, (_unused, index) => {
      return { src: `https://cdn.example.com/image-${index}.png` }
    })
    for (const image of page.images) {
      page.pageFetchable.set(image.src, { body: new Uint8Array([1, 2, 3]), contentType: 'image/png' })
    }

    const manifest = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'assets-manifest' },
    })
    if (!manifest.ok) {
      throw new Error('expected a successful assets-manifest extraction')
    }
    const manifestValue = manifest.data.value as Record<string, unknown>
    expect((manifestValue.assets as unknown[]).length).toBe(200)
    expect(manifestValue.assetCount).toBe(200)
    expect(manifestValue.assetsTruncated).toBe(true)
    expect(manifest.data.text).toContain('200 images found (listing the first ones)')

    const saved = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!saved.ok) {
      throw new Error('expected a successful page.extract')
    }
    expect((saved.data.value as Record<string, unknown>).savedAssets as unknown[]).toHaveLength(20)
    // The manifest holds 200 of the 205 images, and the save bound leaves the
    // rest of them untried — counted, not silently dropped.
    expect((saved.data.value as Record<string, unknown>).assetsNotFetched).toBe(180)
    expect(page.pageFetchUrls).toHaveLength(20)
  })

  test('bounds the manifest by its model-facing byte budget, not only by its entry cap', async () => {
    const page = new FakePage('target-1')
    /** Long URLs and long alt text, so the manifest is cut by bytes well before 200 entries. */
    const longPath = 'deeply-nested-segment/'.repeat(8)
    const longAlt = 'a caption that a page can make arbitrarily long '.repeat(4)
    page.images = Array.from({ length: 200 }, (_unused, index) => {
      return { src: `https://cdn.example.com/${index}/${longPath}image-${index}.png`, alt: longAlt }
    })

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'assets-manifest' },
    })
    if (!response.ok) {
      throw new Error('expected a successful assets-manifest extraction')
    }

    const value = response.data.value as Record<string, unknown>
    const assets = value.assets as Array<Record<string, unknown>>
    const entryBytes = (asset: Record<string, unknown>): number => {
      return Buffer.byteLength(JSON.stringify(asset), 'utf8') + 1
    }
    expect(assets.length).toBeGreaterThan(0)
    expect(assets.length).toBeLessThan(200)
    expect(assets.length).toBe(value.assetCount)
    expect(value.assetsTruncated).toBe(true)
    expect(assets.reduce((total, asset) => { return total + entryBytes(asset) }, 0)).toBeLessThanOrEqual(40_000)
    // The entry the budget stopped at is the one that would have crossed it.
    const omitted = page.images[assets.length]
    const omittedBytes = entryBytes({
      src: omitted.src, currentSrc: '', srcset: '', alt: omitted.alt, naturalWidth: 0, naturalHeight: 0,
    })
    const listedBytes = assets.reduce((total, asset) => { return total + entryBytes(asset) }, 0)
    expect(listedBytes + omittedBytes).toBeGreaterThan(40_000)
    expect(response.data.text).toContain('images found (listing the first ones)')
  })

  test('reports every image it cannot persist instead of failing the whole extraction', async () => {
    const page = new FakePage('target-1')
    page.images = [
      { src: 'https://cdn.example.com/vector.avif' },
      { src: 'https://cdn.example.com/huge.png' },
      { src: 'https://cdn.example.com/first.png' },
      { src: 'https://cdn.example.com/second.png' },
    ]
    page.pageFetchable.set('https://cdn.example.com/vector.avif', {
      body: new Uint8Array(Buffer.from('avif-bytes')),
      contentType: 'image/avif',
    })
    page.pageFetchable.set('https://cdn.example.com/huge.png', {
      body: new Uint8Array(16 * 1024 * 1024 + 1),
      contentType: 'image/png',
    })
    page.pageFetchable.set('https://cdn.example.com/first.png', {
      body: new Uint8Array(2 * 1024 * 1024),
      contentType: 'image/png',
    })
    page.pageFetchable.set('https://cdn.example.com/second.png', {
      body: new Uint8Array(2 * 1024 * 1024),
      contentType: 'image/png',
    })

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    const value = response.data.value as Record<string, unknown>
    expect(value.savedAssets).toEqual([
      {
        base64: Buffer.alloc(2 * 1024 * 1024).toString('base64'),
        mimeType: 'image/png',
        src: 'https://cdn.example.com/first.png',
      },
    ])
    const failed = value.failedAssets as Array<{ src: string; reason: string }>
    expect(failed.map((entry) => entry.src)).toEqual([
      'https://cdn.example.com/vector.avif',
      'https://cdn.example.com/huge.png',
      'https://cdn.example.com/second.png',
    ])
    expect(failed[0].reason).toBe('unsupported image type image/avif')
    expect(failed[1].reason).toBe('image of 16777217 bytes exceeds the 16777216 byte per-image limit')
    // The request budget is what stops the third image, and it says so: the
    // image is not saved because the response cannot carry it, not because the
    // caller asked for too many images.
    expect(failed[2].reason).toBe('image of 2097152 bytes would exceed the 3145728 byte per-request saved-image budget')
  })

  test('reports a request that has used up its image budget without fetching more bytes', async () => {
    const page = new FakePage('target-1')
    page.images = [
      { src: 'https://cdn.example.com/first.png' },
      { src: 'https://cdn.example.com/second.png' },
      { src: 'https://cdn.example.com/third.png' },
    ]
    // Two images of 1.5 MiB fill the 3 MiB request budget exactly.
    for (const image of page.images) {
      page.pageFetchable.set(image.src, { body: new Uint8Array(3 * 1024 * 1024 / 2), contentType: 'image/png' })
    }

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    const value = response.data.value as Record<string, unknown>
    expect(value.savedAssets as unknown[]).toHaveLength(2)
    expect(value.failedAssets).toEqual([{
      src: 'https://cdn.example.com/third.png',
      reason: 'saving stopped: the 3145728 byte per-request saved-image budget is already used up',
    }])
    // An image that cannot be carried is not fetched either.
    expect(page.pageFetchUrls).toEqual(['https://cdn.example.com/first.png', 'https://cdn.example.com/second.png'])
  })

  test('refuses an image whose declared size is already over the limit without reading it', async () => {
    const page = new FakePage('target-1')
    page.images = [{ src: 'https://cdn.example.com/enormous.png' }]
    // A three-byte body that claims to be 100 MiB: only a check on the declared
    // size can report the declared number, so the reason proves the read was cut
    // short before a huge image was decoded into a string and then base64.
    page.pageFetchable.set('https://cdn.example.com/enormous.png', {
      body: new Uint8Array([1, 2, 3]),
      contentType: 'image/png',
      declaredBytes: 100 * 1024 * 1024,
    })

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'markdown', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful page.extract')
    }

    const value = response.data.value as Record<string, unknown>
    expect(value.savedAssets).toEqual([])
    const failed = value.failedAssets as Array<{ src: string; reason: string }>
    expect(failed).toHaveLength(1)
    expect(failed[0].src).toBe('https://cdn.example.com/enormous.png')
    expect(failed[0].reason).toContain('image of 104857600 bytes exceeds the 16777216 byte per-image limit')
  })

  test("keeps the manifest when images: 'save' is asked for the manifest format", async () => {
    const page = new FakePage('target-1')
    page.images = [{ src: 'https://cdn.example.com/chart.png', alt: 'Chart' }]
    page.pageFetchable.set('https://cdn.example.com/chart.png', {
      body: new Uint8Array(Buffer.from('chart-bytes')),
      contentType: 'image/png',
    })

    const response = await executeWithPage({
      page,
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'assets-manifest', images: 'save' },
    })
    if (!response.ok) {
      throw new Error('expected a successful assets-manifest extraction')
    }

    expect(response.data.value).toMatchObject({
      assetCount: 1,
      assets: [{ src: 'https://cdn.example.com/chart.png' }],
      savedAssets: [{ mimeType: 'image/png', src: 'https://cdn.example.com/chart.png', alt: 'Chart' }],
    })
  })
})
