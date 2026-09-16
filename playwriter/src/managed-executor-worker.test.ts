import { EventEmitter } from 'node:events'
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

class FakePage extends EventEmitter {
  html = '<html><head><title>Example</title></head><body><article><p>Example body text.</p></article></body></html>'
  selectedHtml = '<article><p>Selected body text.</p></article>'
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

  locator(): { evaluate: <R>(pageFunction: (element: { outerHTML: string }) => R) => Promise<R> } {
    return {
      evaluate: async <R>(pageFunction: (element: { outerHTML: string }) => R): Promise<R> => {
        return pageFunction({ outerHTML: this.selectedHtml })
      },
    }
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

  test('reports assets-manifest as unsupported instead of returning an empty extraction', async () => {
    const response = await executeWithPage({
      page: new FakePage('target-1'),
      operation: { kind: 'page.extract', tabId: 'tab-1', format: 'assets-manifest' },
    })

    expect(response).toMatchObject({ ok: false, error: { code: 'unsupported-capability' } })
  })
})
