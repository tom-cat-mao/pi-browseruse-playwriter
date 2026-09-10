import type { Browser, BrowserContext, ElementHandle, Frame, Locator, Page } from '@xmorse/playwright-core'
import { describe, expect, test } from 'vitest'
import { ManagedPlaywrightFacade } from './managed-executor-facade.js'
import { ManagedExecutionLease, ManagedTimerScope } from './managed-executor-lease.js'
import { resolveManagedOperationOutcome } from './managed-executor-worker.js'

interface StubState {
  clicks: number
}

function createStubPage(state: StubState): Page {
  const browser: Record<string, unknown> = {
    close: () => {
      throw new Error('raw browser close reached the stub')
    },
    contexts: () => [],
  }
  const context: Record<string, unknown> = {
    browser: () => browser,
    close: () => {
      throw new Error('raw context close reached the stub')
    },
    newCDPSession: () => {
      throw new Error('raw context CDP reached the stub')
    },
    newPage: () => {
      throw new Error('raw context newPage reached the stub')
    },
    pages: () => [],
  }
  const page: Record<string, unknown> = {
    close: () => {
      throw new Error('raw page close reached the stub')
    },
    context: () => context,
    frames: () => [],
    locator: () => createStubLocator({ page, state }),
    mainFrame: () => createStubFrame({ page }),
    targetId: () => 'target-1',
    url: () => 'about:blank',
  }
  page.frames = () => [createStubFrame({ page })]
  return page as unknown as Page
}

function createStubFrame({ page }: { page: Record<string, unknown> }): Frame {
  return {
    frameId: () => 'frame-1',
    page: () => page as unknown as Page,
  } as unknown as Frame
}

function createStubLocator({ page, state }: { page: Record<string, unknown>; state: StubState }): Locator {
  const locator: Record<string, unknown> = {
    click: () => {
      state.clicks += 1
    },
    elementHandle: async () => createStubElement({ page }),
    fill: () => {},
    page: () => page as unknown as Page,
  }
  return locator as unknown as Locator
}

function createStubElement({ page }: { page: Record<string, unknown> }): ElementHandle {
  return {
    contentFrame: async () => createStubFrame({ page }),
    evaluate: async () => null,
    ownerFrame: async () => createStubFrame({ page }),
  } as unknown as ElementHandle
}

function createFacade({
  page,
  lease,
}: {
  page: Page
  lease: ManagedExecutionLease
}): ManagedPlaywrightFacade {
  const context = page.context()
  const browser = context.browser()
  if (!browser) {
    throw new Error('stub context has no browser')
  }
  return new ManagedPlaywrightFacade({
    browser,
    context,
    allowedTargetIds: new Set<string>(['target-1']),
    lease,
  })
}

describe('managed executor outcome and raw execution lease', () => {
  test('reports unknown after an operation has started a side effect', () => {
    expect(resolveManagedOperationOutcome({ sideEffectsStarted: false, outcome: 'not-started' })).toBe('not-started')
    expect(resolveManagedOperationOutcome({ sideEffectsStarted: true, outcome: 'not-started' })).toBe('unknown')
  })

  test('an old proxy cannot regain access when a later facade wraps the same page', () => {
    const state: StubState = { clicks: 0 }
    const page = createStubPage(state)
    const leaseA = new ManagedExecutionLease()
    const facadeA = createFacade({ page, lease: leaseA })
    const oldPage = facadeA.wrapPage(page)
    leaseA.release()

    const leaseB = new ManagedExecutionLease()
    const facadeB = createFacade({ page, lease: leaseB })
    const newPage = facadeB.wrapPage(page)

    expect(() => oldPage.locator('#button')).toThrow('lease has expired')
    expect(() => oldPage.frames()).toThrow('lease has expired')
    newPage.locator('#button').click()
    expect(state.clicks).toBe(1)
  })

  test('known frame and element handle chains stay wrapped and destructive calls stay guarded', async () => {
    const state: StubState = { clicks: 0 }
    const page = createStubPage(state)
    const lease = new ManagedExecutionLease()
    const facade = createFacade({ page, lease })
    const wrappedPage = facade.wrapPage(page)

    expect(wrappedPage.keyboard).toBeUndefined()
    expect(wrappedPage.mouse).toBeUndefined()

    const wrappedFrame = wrappedPage.frames()[0]
    expect(wrappedFrame.page()).toBe(wrappedPage)
    expect(() => wrappedFrame.page().close()).toThrow('page.close')
    expect(() => wrappedFrame.page().context().newPage()).toThrow('context.newPage')
    expect(() => wrappedFrame.page().context().browser()?.close()).toThrow('browser.close')

    const wrappedElement = await wrappedPage.locator('#button').elementHandle()
    expect(wrappedElement).not.toBeNull()
    expect((await wrappedElement?.ownerFrame())?.page()).toBe(wrappedPage)
  })

  test('request timers are cleared and cannot issue a later page action', async () => {
    const state: StubState = { clicks: 0 }
    const page = createStubPage(state)
    const lease = new ManagedExecutionLease()
    const facade = createFacade({ page, lease })
    const timers = new ManagedTimerScope(lease)
    const oldPage = facade.wrapPage(page)
    timers.setTimeout(() => {
      oldPage.locator('#button').click()
    }, 10)

    lease.release()
    timers.dispose()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40)
    })
    expect(state.clicks).toBe(0)
    expect(() => oldPage.locator('#button')).toThrow('lease has expired')
  })
})
