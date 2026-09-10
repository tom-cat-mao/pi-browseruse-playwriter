import { EventEmitter } from 'node:events'
import type { Browser, BrowserContext, Page } from '@xmorse/playwright-core'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { BrowserPageOperation, BrowserRequest, BrowserTab, ManagedExecution } from './browser-protocol.js'

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

import { ManagedExecutorWorkerRuntime } from './managed-executor-worker.js'

class FakePage extends EventEmitter {
  constructor(private readonly id: string) {
    super()
  }

  targetId(): string {
    return this.id
  }

  isClosed(): boolean {
    return false
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
  const request: BrowserRequest & { operation: BrowserPageOperation } = {
    requestId: 'request-1',
    sessionId: 'session-1',
    timeoutMs,
    operation: { kind: 'page.logs', tabId: 'tab-1', limit: 1 },
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
      data: { logs: [] },
    })
    expect(context.listenerCount('page')).toBe(1)

    await runtime.dispose()
    expect(context.listenerCount('page')).toBe(0)
    expect(browser.listenerCount('disconnected')).toBe(0)
  })
})
