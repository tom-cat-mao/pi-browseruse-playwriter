import type { Browser, BrowserContext, ConsoleMessage, Frame, Locator, Page, Response } from '@xmorse/playwright-core'
import * as acorn from 'acorn'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import vm from 'node:vm'
import type {
  BrowserErrorCode,
  BrowserJson,
  BrowserRequest,
  BrowserPageOperation,
  BrowserResponse,
  BrowserResultData,
  ManagedExecution,
} from './browser-protocol.js'
import {
  getAriaSnapshot,
  hideAriaRefLabels,
  screenshotWithAccessibilityLabels,
  type ScreenshotResult,
  type SnapshotOutputLine,
} from './aria-snapshot.js'
import { getCDPSessionForPage, type ICDPSession } from './cdp-session.js'
import { getChromium } from './playwright-import.js'
import { waitForPageLoad } from './wait-for-page-load.js'
import { ManagedPlaywrightFacade } from './managed-executor-facade.js'
import { LeasedCDPSession, ManagedExecutionLease, ManagedTimerScope } from './managed-executor-lease.js'
import {
  encodeManagedWorkerMessage,
  errorMessage,
  MAX_MANAGED_WORKER_MESSAGE_BYTES,
  parseManagedWorkerCommand,
  serializeBrowserJson,
  splitManagedWorkerLines,
  truncateString,
  type ManagedExecutorWorkerCommand,
  type ManagedExecutorWorkerWireMessage,
} from './managed-executor-protocol.js'

const DEFAULT_PAGE_TIMEOUT_MS = 60_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_SNAPSHOT_CHARS = 40_000
const MAX_SNAPSHOT_BYTES = 40_000
const MAX_SNAPSHOT_REFS_BYTES = 16_000
const MAX_SNAPSHOT_LINES = 2_000
const MAX_SELECTOR_TIMEOUT_MS = 5_000
const RESPONSE_RESERVE_MS = 250
const MAX_LOG_ENTRIES = 1_000
const MAX_LOG_RETURN_ENTRIES = 500
const MAX_NETWORK_ENTRIES = 500
// Keep image payloads below the newline protocol's 8 MiB envelope budget.
const MAX_INLINE_IMAGE_BASE64 = 4 * 1024 * 1024
const MAX_EXECUTE_CODE_LENGTH = 1_000_000

const SAFE_NODE_GLOBALS = {
  AbortController,
  AbortSignal,
  Buffer,
  TextDecoder,
  TextEncoder,
  URL,
  URLSearchParams,
  clearInterval,
  clearTimeout,
  crypto,
  fetch,
  setInterval,
  setTimeout,
  structuredClone,
} as const

interface SnapshotRecord {
  id: string
  pageGeneration: number
  refs: Map<string, string>
}

interface NetworkCapture {
  page: Page
  filter?: string
  entries: BrowserJson[]
  listener: (response: Response) => void
}

interface ManagedPageState {
  targetId: string
  page: Page
  pageGeneration: number
  snapshotGeneration: number
  logs: string[]
  latestSnapshot?: SnapshotRecord
  network?: NetworkCapture
  consoleListener: (message: ConsoleMessage) => void
  pageErrorListener: (error: Error) => void
  navigationListener: (frame: Frame) => void
  closeListener: (page: Page) => void
}

interface SnapshotOptions {
  page?: Page
  locator?: Locator
  search?: string
  showDiffSinceLastCall?: boolean
  full?: boolean
  interactiveOnly?: boolean
  offset?: number
  limit?: number
  deadline?: number
  markSideEffectsStarted?: () => void
}

interface RawConsole {
  log: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
  debug: (...args: unknown[]) => void
}

class ManagedExecutorOperationError extends Error {
  readonly code: BrowserErrorCode
  readonly outcome: 'not-started' | 'unknown'

  constructor({
    code,
    message,
    outcome = 'not-started',
    cause,
  }: {
    code: BrowserErrorCode
    message: string
    outcome?: 'not-started' | 'unknown'
    cause?: unknown
  }) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'ManagedExecutorOperationError'
    this.code = code
    this.outcome = outcome
  }
}

export interface ManagedExecutorWorkerRuntimeOptions {
  allowedTargetIds?: Set<string>
}

/**
 * One runtime owns one Playwright CDP connection. It never creates a context,
 * page, or browser and never calls browser.close()/context.close(): the
 * parent process owns the control connection lifecycle and terminating this
 * worker is the disconnect operation.
 */
export class ManagedExecutorWorkerRuntime {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private facade: ManagedPlaywrightFacade | null = null
  private browserDisconnectedListener: (() => void) | null = null
  private contextPageListener: ((page: Page) => void) | null = null
  private readonly pageStates = new Map<string, ManagedPageState>()
  private readonly pageGenerations = new Map<string, number>()
  private readonly allowedTargetIds: Set<string>
  private readonly userState: Record<string, unknown> = {}
  private sessionCwd: string | null = null
  private connectionEpoch: string | null = null
  private cdpUrl: string | null = null
  private disposed = false

  constructor(options: ManagedExecutorWorkerRuntimeOptions = {}) {
    this.allowedTargetIds = options.allowedTargetIds ?? new Set<string>()
  }

  async execute(execution: ManagedExecution): Promise<BrowserResponse> {
    const requestId = execution.request.requestId
    const requestDeadline = Date.now() + (execution.request.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
    let sideEffectsStarted = false
    try {
      this.validateExecution(execution)
      this.setSessionCwd(execution.request.cwd)
      await this.ensureConnection({ cdpUrl: execution.cdpUrl, connectionEpoch: execution.connectionEpoch })
      const targetId = execution.tab.targetId
      if (!targetId) {
        throw new ManagedExecutorOperationError({
          code: 'resource-not-found',
          message: `Tab ${execution.tab.tabId} has no CDP targetId; refusing to select a default page`,
        })
      }
      this.allowedTargetIds.add(targetId)
      const page = await this.getPage({ targetId, deadline: requestDeadline })
      const data = await this.executeOperation({
        request: execution.request,
        page,
        deadline: requestDeadline,
        markSideEffectsStarted: () => {
          sideEffectsStarted = true
        },
      })
      return { requestId, ok: true, data }
    } catch (error) {
      return this.errorResponse({ requestId, error, sideEffectsStarted })
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    if (this.context && this.contextPageListener) {
      this.context.off('page', this.contextPageListener)
    }
    if (this.browser && this.browserDisconnectedListener) {
      this.browser.off('disconnected', this.browserDisconnectedListener)
    }
    this.pageStates.forEach((state) => {
      this.detachPageState(state)
    })
    this.pageStates.clear()
    this.facade = null
    this.context = null
    this.browser = null
    this.browserDisconnectedListener = null
    this.contextPageListener = null
    Object.keys(this.userState).forEach((key) => {
      delete this.userState[key]
    })
  }

  private validateExecution(execution: ManagedExecution): void {
    const request = execution.request
    const operation = request.operation
    if (this.disposed) {
      throw new ManagedExecutorOperationError({
        code: 'internal-error',
        message: 'Managed executor worker has been disposed',
      })
    }
    if (!request.sessionId || request.sessionId !== execution.tab.sessionId) {
      throw new ManagedExecutorOperationError({
        code: 'ownership-mismatch',
        message: 'Request session does not own the selected tab',
      })
    }
    if (!isBrowserPageOperation(operation) || operation.tabId !== execution.tab.tabId) {
      throw new ManagedExecutorOperationError({
        code: 'invalid-request',
        message: 'Managed executor accepts only page operations for the explicitly selected tab',
      })
    }
    if (!execution.tab.targetId) {
      throw new ManagedExecutorOperationError({
        code: 'resource-not-found',
        message: `Tab ${execution.tab.tabId} has no CDP targetId; refusing to select a default page`,
      })
    }
    if (execution.tab.state !== 'ready') {
      throw new ManagedExecutorOperationError({
        code: execution.tab.state === 'released' ? 'resource-released' : 'profile-disconnected',
        message: `Tab ${execution.tab.tabId} is ${execution.tab.state}`,
      })
    }
    if (request.operation.kind === 'page.evaluate' || request.operation.kind === 'page.execute') {
      if (request.operation.code.length > MAX_EXECUTE_CODE_LENGTH) {
        throw new ManagedExecutorOperationError({
          code: 'invalid-request',
          message: `JavaScript code exceeds the ${MAX_EXECUTE_CODE_LENGTH}-character limit`,
        })
      }
    }
  }

  private async ensureConnection({
    cdpUrl,
    connectionEpoch,
  }: {
    cdpUrl: string
    connectionEpoch: string
  }): Promise<void> {
    if (this.browser && this.context && this.cdpUrl === cdpUrl && this.connectionEpoch === connectionEpoch) {
      return
    }
    if (this.browser || this.context) {
      throw new ManagedExecutorOperationError({
        code: 'profile-disconnected',
        message: 'Managed executor connection epoch changed; the old worker must be replaced',
      })
    }

    let browser: Browser
    try {
      const chromium = await getChromium()
      browser = await chromium.connectOverCDP(cdpUrl)
    } catch (error) {
      throw new ManagedExecutorOperationError({
        code: 'profile-disconnected',
        message: `Could not connect the managed executor to the profile CDP endpoint: ${errorMessage(error)}`,
        cause: error,
      })
    }

    const contexts = browser.contexts()
    const context = contexts[0]
    if (!context) {
      throw new ManagedExecutorOperationError({
        code: 'profile-disconnected',
        message: 'The profile CDP endpoint exposed no browser context',
      })
    }

    this.browser = browser
    this.context = context
    this.cdpUrl = cdpUrl
    this.connectionEpoch = connectionEpoch
    this.facade = new ManagedPlaywrightFacade({
      browser,
      context,
      allowedTargetIds: this.allowedTargetIds,
    })
    this.browserDisconnectedListener = () => {
      this.clearConnectionAfterDisconnect()
    }
    browser.on('disconnected', this.browserDisconnectedListener)
    this.contextPageListener = (page) => {
      this.registerPage(page)
    }
    context.on('page', this.contextPageListener)
    context.pages().forEach((page) => {
      this.registerPage(page)
    })
  }

  private clearConnectionAfterDisconnect(): void {
    this.pageStates.forEach((state) => {
      this.detachPageState(state)
    })
    this.pageStates.clear()
    this.context = null
    this.browser = null
    this.facade = null
    this.browserDisconnectedListener = null
    this.contextPageListener = null
  }

  private registerPage(page: Page): ManagedPageState | null {
    const targetId = page.targetId()
    if (!targetId) {
      return null
    }
    const existing = this.pageStates.get(targetId)
    if (existing?.page === page) {
      return existing
    }
    if (existing) {
      this.detachPageState(existing)
    }

    const pageGeneration = (this.pageGenerations.get(targetId) ?? 0) + 1
    this.pageGenerations.set(targetId, pageGeneration)
    const state: ManagedPageState = {
      targetId,
      page,
      pageGeneration,
      snapshotGeneration: 0,
      logs: [],
      consoleListener: (message) => {
        this.appendPageLog({
          state,
          message: `[console:${message.type()}] ${message.text()}`,
        })
      },
      pageErrorListener: (error) => {
        this.appendPageLog({
          state,
          message: `[pageerror] ${error.stack ?? error.message}`,
        })
      },
      navigationListener: (frame) => {
        if (frame === page.mainFrame()) {
          state.latestSnapshot = undefined
        }
      },
      closeListener: () => {
        if (this.pageStates.get(targetId) !== state) {
          return
        }
        this.detachPageState(state)
        this.pageStates.delete(targetId)
      },
    }
    page.on('console', state.consoleListener)
    page.on('pageerror', state.pageErrorListener)
    page.on('framenavigated', state.navigationListener)
    page.on('close', state.closeListener)
    this.pageStates.set(targetId, state)
    return state
  }

  private detachPageState(state: ManagedPageState): void {
    state.page.off('console', state.consoleListener)
    state.page.off('pageerror', state.pageErrorListener)
    state.page.off('framenavigated', state.navigationListener)
    state.page.off('close', state.closeListener)
    this.stopNetworkCapture({ state })
    state.latestSnapshot = undefined
  }

  private appendPageLog({ state, message }: { state: ManagedPageState; message: string }): void {
    state.logs.push(truncateString({ value: message, maxLength: 4_000 }))
    if (state.logs.length > MAX_LOG_ENTRIES) {
      state.logs.splice(0, state.logs.length - MAX_LOG_ENTRIES)
    }
  }

  private setSessionCwd(rawCwd: string | undefined): void {
    if (!rawCwd) {
      return
    }
    if (!isAbsolutePath(rawCwd)) {
      throw new ManagedExecutorOperationError({
        code: 'invalid-request',
        message: `Request cwd must be an absolute path: ${rawCwd}`,
      })
    }
    if (this.sessionCwd && this.sessionCwd !== rawCwd) {
      throw new ManagedExecutorOperationError({
        code: 'invalid-request',
        message: 'A managed executor worker cannot change cwd within one session/profile context',
      })
    }
    if (!this.sessionCwd) {
      try {
        process.chdir(rawCwd)
      } catch (error) {
        throw new ManagedExecutorOperationError({
          code: 'invalid-request',
          message: `Could not use request cwd ${rawCwd}: ${errorMessage(error)}`,
          cause: error,
        })
      }
      this.sessionCwd = rawCwd
    }
  }

  // Reattaching a physical target creates its Playwright page asynchronously;
  // wait only for the requested target within the current request deadline.
  private async getPage({ targetId, deadline }: { targetId: string; deadline: number }): Promise<Page> {
    const context = this.context
    if (!context) {
      throw new ManagedExecutorOperationError({
        code: 'profile-disconnected',
        message: 'Managed profile is not connected',
      })
    }

    const findPage = (): Page | null => {
      const pages = context.pages().filter((page) => {
        return !page.isClosed() && page.targetId() === targetId
      })
      if (pages.length > 1) {
        throw new ManagedExecutorOperationError({
          code: 'internal-error',
          message: `Multiple Playwright pages reported targetId ${targetId}`,
        })
      }
      return (
        pages.find((page) => {
          return page.targetId() === targetId
        }) ?? null
      )
    }

    const existingPage = findPage()
    if (existingPage) {
      this.registerPage(existingPage)
      return existingPage
    }

    const timeoutError = (): ManagedExecutorOperationError => {
      return new ManagedExecutorOperationError({
        code: 'timeout',
        message: `Timed out waiting for Playwright page with targetId ${targetId}`,
      })
    }
    if (deadline <= Date.now()) {
      throw timeoutError()
    }

    return await new Promise<Page>((resolve, reject) => {
      let settled = false
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null
      const cleanup = (): void => {
        context.off('page', onPage)
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle)
          timeoutHandle = null
        }
      }
      const resolvePage = (page: Page): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        this.registerPage(page)
        resolve(page)
      }
      const rejectPage = (error: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      function onPage(page: Page): void {
        if (page.isClosed() || page.targetId() !== targetId) {
          return
        }
        try {
          resolvePage(findPage() ?? page)
        } catch (error) {
          rejectPage(error)
        }
      }

      context.on('page', onPage)
      if (settled) {
        return
      }
      try {
        const recheckedPage = findPage()
        if (recheckedPage) {
          resolvePage(recheckedPage)
          return
        }
      } catch (error) {
        rejectPage(error)
        return
      }
      if (settled) {
        return
      }
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        rejectPage(timeoutError())
        return
      }
      timeoutHandle = setTimeout(() => {
        rejectPage(timeoutError())
      }, remainingMs)
    })
  }

  private async executeOperation({
    request,
    page,
    deadline,
    markSideEffectsStarted,
  }: {
    request: BrowserRequest & { operation: Extract<BrowserRequest['operation'], { kind: `page.${string}` }> }
    page: Page
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    const operation = request.operation
    const data = await this.dispatchOperation({ operation, page, deadline, markSideEffectsStarted })
    // page.url() is cached; only navigate/back may contribute a computed title.
    return attachObservedPageInfo({ data, tabId: operation.tabId, url: page.url(), operationKind: operation.kind })
  }

  private async dispatchOperation({
    operation,
    page,
    deadline,
    markSideEffectsStarted,
  }: {
    operation: Extract<BrowserRequest['operation'], { kind: `page.${string}` }>
    page: Page
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    switch (operation.kind) {
      case 'page.navigate':
        return await this.navigate({ page, url: operation.url, deadline, markSideEffectsStarted })
      case 'page.back':
        return await this.goBack({ page, deadline, markSideEffectsStarted })
      case 'page.snapshot':
        return await this.snapshot({
          page,
          locator: operation.selector ? page.locator(operation.selector) : undefined,
          search: operation.search,
          full: operation.full,
          interactiveOnly: operation.interactiveOnly,
          deadline,
          markSideEffectsStarted,
        })
      case 'page.click':
        return await this.click({
          page,
          selector: operation.selector,
          snapshotId: operation.snapshotId,
          deadline,
          markSideEffectsStarted,
        })
      case 'page.fill':
        return await this.fill({
          page,
          selector: operation.selector,
          snapshotId: operation.snapshotId,
          value: operation.value,
          deadline,
          markSideEffectsStarted,
        })
      case 'page.evaluate':
        return await this.evaluate({ page, code: operation.code, markSideEffectsStarted })
      case 'page.screenshot':
        return await this.screenshot({
          page,
          path: operation.path,
          fullPage: operation.fullPage,
          labels: operation.labels,
          deadline,
          markSideEffectsStarted,
        })
      case 'page.network':
        return this.network({
          state: this.requirePageState({ page }),
          action: operation.action,
          filter: operation.filter,
        })
      case 'page.logs':
        return this.logs({ state: this.requirePageState({ page }), limit: operation.limit })
      case 'page.execute':
        return await this.executeJavaScript({ page, code: operation.code, deadline, markSideEffectsStarted })
      default:
        return assertNever(operation)
    }
  }

  private async navigate({
    page,
    url,
    deadline,
    markSideEffectsStarted,
  }: {
    page: Page
    url: string
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    validateNavigationUrl(url)
    const timeout = this.nativeOperationTimeout({ deadline, maximumMs: DEFAULT_NAVIGATION_TIMEOUT_MS })
    markSideEffectsStarted()
    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout,
    })
    this.invalidateSnapshot({ page })
    return {
      text: `Navigated to ${page.url()}`,
      value: {
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? null,
      },
    }
  }

  /**
   * Real browser history back — never a goto() to the previous URL, so the site
   * keeps whatever it restores from its own history entry. Sites that rebuild
   * scroll/form state from JS may still not restore it; we report the resulting
   * URL and never assert more than we know.
   */
  private async goBack({
    page,
    deadline,
    markSideEffectsStarted,
  }: {
    page: Page
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    const timeout = this.nativeOperationTimeout({ deadline, maximumMs: DEFAULT_NAVIGATION_TIMEOUT_MS })
    markSideEffectsStarted()
    const response = await page.goBack({
      waitUntil: 'domcontentloaded',
      timeout,
    })
    this.invalidateSnapshot({ page })
    const url = page.url()
    const title = await page.title()
    // A null response only means "no main-resource response to report" — a
    // same-document/SPA/hash history entry goes back without one. Never claim
    // nothing happened; report the tab's real state instead.
    return {
      text:
        response === null
          ? `Back request completed; the tab is now on ${url} (no navigation response; inspect the page to confirm its state)`
          : `Went back to ${url}`,
      value: { url, title, hadNavigationResponse: response !== null },
    }
  }

  private async click({
    page,
    selector,
    snapshotId,
    deadline,
    markSideEffectsStarted,
  }: {
    page: Page
    selector: string
    snapshotId?: string
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    const locator = this.resolveActionLocator({ page, selector, snapshotId })
    const timeout = this.nativeOperationTimeout({ deadline, maximumMs: MAX_SELECTOR_TIMEOUT_MS })
    markSideEffectsStarted()
    await locator.click({ timeout })
    this.invalidateSnapshot({ page })
    // The URL is the tab's state observed right after the click returns — not a
    // promise that any navigation the click triggered has finished. We never sleep
    // or auto-goto; take a fresh snapshot to confirm the resulting page.
    return {
      text: 'Clicked the selected element; url below is the immediate post-click observation, not a settled navigation',
      value: { url: page.url() },
    }
  }

  private async fill({
    page,
    selector,
    snapshotId,
    value,
    deadline,
    markSideEffectsStarted,
  }: {
    page: Page
    selector: string
    snapshotId?: string
    value: string
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    const locator = this.resolveActionLocator({ page, selector, snapshotId })
    // Chrome debugger keyboard input follows the OS-focused surface. A real
    // click immediately before fill keeps extension-backed tabs focused.
    const clickTimeout = this.nativeOperationTimeout({ deadline, maximumMs: MAX_SELECTOR_TIMEOUT_MS })
    markSideEffectsStarted()
    await locator.click({ timeout: clickTimeout })
    const fillTimeout = this.nativeOperationTimeout({ deadline, maximumMs: MAX_SELECTOR_TIMEOUT_MS })
    await locator.fill(value, { timeout: fillTimeout })
    this.invalidateSnapshot({ page })
    return {
      text: 'Filled the selected element',
      value: { url: page.url() },
    }
  }

  private resolveActionLocator({
    page,
    selector,
    snapshotId,
  }: {
    page: Page
    selector: string
    snapshotId?: string
  }): Locator {
    const ref = normalizeSnapshotRef(selector)
    if (!ref) {
      return page.locator(selector)
    }
    if (!snapshotId) {
      throw new ManagedExecutorOperationError({
        code: 'stale-snapshot',
        message: `Selector ${selector} is a snapshot ref and requires the snapshotId returned by page.snapshot`,
      })
    }
    const state = this.requirePageState({ page })
    const snapshot = state.latestSnapshot
    // A snapshot is invalidated after any navigation, click, fill, evaluate, or
    // execute on this page, because those may mutate the DOM in ways we cannot
    // introspect (JS side effects are opaque). We keep this conservative rather
    // than guessing a ref still points at the same element.
    if (!snapshot) {
      throw new ManagedExecutorOperationError({
        code: 'stale-snapshot',
        message: `Selector ${selector} needs a snapshot ref, but no snapshot is current for target ${state.targetId} (a prior navigate/click/fill/evaluate/execute invalidated it); take a fresh page.snapshot and reuse its refs`,
      })
    }
    if (snapshot.id !== snapshotId || snapshot.pageGeneration !== state.pageGeneration) {
      throw new ManagedExecutorOperationError({
        code: 'stale-snapshot',
        message: `Snapshot ${snapshotId} is stale for target ${state.targetId}: the page changed or a later action replaced it (current snapshot ${snapshot.id}). Take a fresh page.snapshot and use the refs it returns`,
      })
    }
    const locator = snapshot.refs.get(ref)
    if (!locator) {
      throw new ManagedExecutorOperationError({
        code: 'stale-snapshot',
        message: `Snapshot ref ${ref} is not present in snapshot ${snapshotId}; it may have been filtered out by search/offset/limit. Take a full page.snapshot (or widen the window) and reuse a ref it lists`,
      })
    }
    // Deliberately do not call first()/nth() here. Playwright strictness must
    // report a changed or ambiguous DOM rather than clicking an arbitrary match.
    return page.locator(locator)
  }

  private async evaluate({
    page,
    code,
    markSideEffectsStarted,
  }: {
    page: Page
    code: string
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    markSideEffectsStarted()
    const value = await page.evaluate((source) => {
      return eval(source) as unknown
    }, wrapCodeForEvaluation(code))
    this.invalidateSnapshot({ page })
    return { value: serializeBrowserJson(value) }
  }

  private async screenshot({
    page,
    path: requestedPath,
    fullPage = false,
    labels = false,
    deadline,
    markSideEffectsStarted,
  }: {
    page: Page
    path?: string
    fullPage?: boolean
    labels?: boolean
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    const outputPath = requestedPath ? resolveArtifactPath({ requestedPath, cwd: this.sessionCwd }) : undefined
    const images: Array<{ data: string; mimeType: string }> = []
    const artifacts: Array<{ path: string; mimeType: string }> = []
    let text = 'Screenshot captured'

    if (labels) {
      const snapshot = await this.snapshot({
        page,
        full: false,
        interactiveOnly: true,
        deadline,
        markSideEffectsStarted,
      })
      const collector: ScreenshotResult[] = []
      try {
        await screenshotWithAccessibilityLabels({ page, collector })
      } finally {
        try {
          await hideAriaRefLabels({ page })
        } catch (error) {
          console.error('[managed-executor] failed to remove screenshot labels:', errorMessage(error))
        }
      }
      const labeled = collector[0]
      if (labeled) {
        appendImage({ images, base64: labeled.base64, mimeType: labeled.mimeType })
        artifacts.push({ path: labeled.path, mimeType: labeled.mimeType })
      }
      if (outputPath) {
        markSideEffectsStarted()
        await page.screenshot({ path: outputPath, fullPage, scale: 'css', type: 'png' })
        artifacts.push({ path: outputPath, mimeType: 'image/png' })
      }
      text = `Screenshot captured with accessibility labels; snapshotId ${String(snapshot.snapshotId)}`
    } else {
      markSideEffectsStarted()
      const buffer = await page.screenshot({
        ...(outputPath ? { path: outputPath } : {}),
        fullPage,
        scale: 'css',
        type: 'png',
      })
      appendImage({ images, base64: buffer.toString('base64'), mimeType: 'image/png' })
      if (outputPath) {
        artifacts.push({ path: outputPath, mimeType: 'image/png' })
      }
    }

    return {
      text,
      images,
      artifacts,
    }
  }

  private network({
    state,
    action,
    filter,
  }: {
    state: ManagedPageState
    action: 'start' | 'list' | 'stop'
    filter?: string
  }): BrowserResultData {
    if (action === 'start') {
      this.stopNetworkCapture({ state })
      const capture: NetworkCapture = {
        page: state.page,
        filter,
        entries: [],
        listener: (response) => {
          try {
            const url = response.url()
            if (capture.filter && !url.includes(capture.filter)) {
              return
            }
            capture.entries.push({
              url,
              method: response.request().method(),
              resourceType: response.request().resourceType(),
              status: response.status(),
            })
            if (capture.entries.length > MAX_NETWORK_ENTRIES) {
              capture.entries.splice(0, capture.entries.length - MAX_NETWORK_ENTRIES)
            }
          } catch (error) {
            console.error('[managed-executor] network listener failed:', errorMessage(error))
          }
        },
      }
      state.network = capture
      state.page.on('response', capture.listener)
      return {
        text: 'Network capture started',
        value: { active: true, filter: filter ?? null, entries: [] },
      }
    }

    if (action === 'list') {
      const entries = state.network?.entries ?? []
      return {
        value: filterEntries({ entries, filter }),
      }
    }

    const entries = state.network?.entries ?? []
    this.stopNetworkCapture({ state })
    return {
      text: 'Network capture stopped',
      value: { active: false, entries: filterEntries({ entries, filter }) },
    }
  }

  private stopNetworkCapture({ state }: { state: ManagedPageState }): void {
    if (!state.network) {
      return
    }
    state.network.page.off('response', state.network.listener)
    state.network = undefined
  }

  private logs({ state, limit }: { state: ManagedPageState; limit?: number }): BrowserResultData {
    const requestedLimit = limit ?? MAX_LOG_RETURN_ENTRIES
    if (!Number.isInteger(requestedLimit) || requestedLimit < 0) {
      throw new ManagedExecutorOperationError({
        code: 'invalid-request',
        message: 'page.logs limit must be a non-negative integer',
      })
    }
    const boundedLimit = Math.min(requestedLimit, MAX_LOG_RETURN_ENTRIES)
    return { logs: boundedLimit === 0 ? [] : state.logs.slice(-boundedLimit) }
  }

  private async executeJavaScript({
    page,
    code,
    deadline,
    markSideEffectsStarted,
  }: {
    page: Page
    code: string
    deadline: number
    markSideEffectsStarted: () => void
  }): Promise<BrowserResultData> {
    const context = this.context
    const browser = this.browser
    if (!context || !browser || !this.facade) {
      throw new ManagedExecutorOperationError({
        code: 'profile-disconnected',
        message: 'Managed profile is not connected',
      })
    }
    const lease = new ManagedExecutionLease()
    const timerScope = new ManagedTimerScope(lease)
    const facade = new ManagedPlaywrightFacade({
      browser,
      context,
      allowedTargetIds: this.allowedTargetIds,
      lease,
    })
    const pageFacade = facade.wrapPage(page)
    const contextFacade = facade.wrapContext(context)
    const operationLogs: string[] = []
    const leasedCdpSessions: LeasedCDPSession[] = []
    const customConsole: RawConsole = {
      log: (...args) => {
        operationLogs.push(formatConsoleLine({ method: 'log', args }))
      },
      info: (...args) => {
        operationLogs.push(formatConsoleLine({ method: 'info', args }))
      },
      warn: (...args) => {
        operationLogs.push(formatConsoleLine({ method: 'warn', args }))
      },
      error: (...args) => {
        operationLogs.push(formatConsoleLine({ method: 'error', args }))
      },
      debug: (...args) => {
        operationLogs.push(formatConsoleLine({ method: 'debug', args }))
      },
    }

    this.userState.page = pageFacade
    this.userState.context = contextFacade
    const snapshot = async (options: SnapshotOptions = {}): Promise<string> => {
      lease.assertActive()
      const targetPage = options.page ? facade.unwrapPage(options.page) : page
      this.assertAllowedPage({ page: targetPage })
      const targetLocator = options.locator ? facade.unwrapLocator(options.locator) : undefined
      const result = await this.snapshot({
        page: targetPage,
        locator: targetLocator,
        search: options.search,
        full: options.full,
        interactiveOnly: options.interactiveOnly,
        offset: options.offset,
        limit: options.limit,
        deadline,
        markSideEffectsStarted,
      })
      return result.text ?? ''
    }
    const refToLocator = ({ ref, page: targetPage }: { ref: string; page?: Page }): string | null => {
      lease.assertActive()
      const rawPage = targetPage ? facade.unwrapPage(targetPage) : page
      this.assertAllowedPage({ page: rawPage })
      return this.requirePageState({ page: rawPage }).latestSnapshot?.refs.get(ref) ?? null
    }
    const getLatestLogs = ({ page: targetPage, count }: { page?: Page; count?: number } = {}): string[] => {
      const rawPage = targetPage ? facade.unwrapPage(targetPage) : page
      const pageState = this.requirePageState({ page: rawPage })
      const requestedCount = count ?? MAX_LOG_RETURN_ENTRIES
      const boundedCount = Math.min(Math.max(requestedCount, 0), MAX_LOG_RETURN_ENTRIES)
      return boundedCount === 0 ? [] : pageState.logs.slice(-boundedCount)
    }
    const getCDPSession = async ({ page: targetPage }: { page: Page }): Promise<ICDPSession> => {
      lease.assertActive()
      const rawPage = facade.unwrapPage(targetPage)
      this.assertAllowedPage({ page: rawPage })
      const session = await getCDPSessionForPage({ page: rawPage })
      const leasedSession = new LeasedCDPSession({ session, lease })
      leasedCdpSessions.push(leasedSession)
      return leasedSession
    }
    const screenshotHelper = async ({ page: targetPage }: { page?: Page } = {}): Promise<void> => {
      lease.assertActive()
      const rawPage = targetPage ? facade.unwrapPage(targetPage) : page
      this.assertAllowedPage({ page: rawPage })
      const collector: ScreenshotResult[] = []
      await screenshotWithAccessibilityLabels({ page: rawPage, collector })
    }
    const vmContextObject: Record<string, unknown> = {
      ...SAFE_NODE_GLOBALS,
      clearInterval: (timer: ReturnType<typeof setInterval>) => {
        timerScope.clearInterval(timer)
      },
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => {
        timerScope.clearTimeout(timer)
      },
      console: customConsole,
      context: contextFacade,
      getCDPSession,
      getLatestLogs,
      page: pageFacade,
      refToLocator,
      screenshotWithAccessibilityLabels: screenshotHelper,
      setInterval: (handler: unknown, delay?: number) => {
        return timerScope.setInterval(handler, delay)
      },
      setTimeout: (handler: unknown, delay?: number) => {
        return timerScope.setTimeout(handler, delay)
      },
      snapshot,
      state: this.userState,
      waitForPageLoad,
      process: this.createProcessFacade(),
    }
    const vmContext = vm.createContext(vmContextObject)
    try {
      const script = new vm.Script(wrapCodeForExecution(code), {
        filename: path.join(this.sessionCwd ?? process.cwd(), '.managed-executor-eval.js'),
      })
      markSideEffectsStarted()
      const result = await script.runInContext(vmContext, {
        timeout: DEFAULT_PAGE_TIMEOUT_MS,
        displayErrors: true,
      })
      this.invalidateSnapshot({ page })
      return {
        value: serializeBrowserJson(result),
        ...(operationLogs.length > 0 ? { logs: operationLogs.slice(-MAX_LOG_RETURN_ENTRIES) } : {}),
      }
    } catch (error) {
      throw new ManagedExecutorOperationError({
        code: 'execution-failed',
        message: `page.execute failed: ${errorMessage(error)}`,
        cause: error,
      })
    } finally {
      lease.release()
      timerScope.dispose()
      leasedCdpSessions.forEach((session) => {
        session.dispose()
      })
      facade.dispose()
    }
  }

  private createProcessFacade(): NodeJS.Process {
    const worker = this
    return new Proxy(process, {
      get(target, property, receiver) {
        if (property === 'exit' || property === 'abort' || property === 'chdir' || property === 'getBuiltinModule') {
          return () => {
            throw new Error(`process.${String(property)} is not available in a managed executor`)
          }
        }
        if (property === 'cwd') {
          return () => worker.sessionCwd ?? target.cwd()
        }
        return Reflect.get(target, property, receiver)
      },
    })
  }

  private assertAllowedPage({ page }: { page: Page }): void {
    const targetId = page.targetId()
    if (!targetId || !this.allowedTargetIds.has(targetId)) {
      throw new ManagedExecutorOperationError({
        code: 'ownership-mismatch',
        message: 'The raw execution context can only access pages authorized by the managed relay',
      })
    }
  }

  private requirePageState({ page }: { page: Page }): ManagedPageState {
    const targetId = page.targetId()
    if (!targetId) {
      throw new ManagedExecutorOperationError({
        code: 'resource-not-found',
        message: 'Selected page has no targetId',
      })
    }
    const state = this.pageStates.get(targetId) ?? this.registerPage(page)
    if (!state) {
      throw new ManagedExecutorOperationError({
        code: 'resource-not-found',
        message: `No page state exists for target ${targetId}`,
      })
    }
    return state
  }

  private invalidateSnapshot({ page }: { page: Page }): void {
    this.requirePageState({ page }).latestSnapshot = undefined
  }

  private async snapshot({
    page,
    locator,
    search,
    full,
    interactiveOnly,
    offset = 0,
    limit,
    deadline,
    markSideEffectsStarted,
  }: SnapshotOptions & { page: Page }): Promise<BrowserResultData> {
    const pageState = this.requirePageState({ page })
    markSideEffectsStarted?.()
    // The default snapshot is the full readable tree (labels, contexts, text).
    // `interactiveOnly` narrows it to interactive elements; `full: true` forces the
    // complete readable tree regardless. Both outputs stay subject to the same
    // search/offset/limit windowing and MAX_SNAPSHOT_LINES/CHARS caps below.
    const useInteractiveOnly = full ? false : (interactiveOnly ?? false)
    const scopeTimeoutMs = deadline
      ? this.nativeOperationTimeout({ deadline, maximumMs: MAX_SELECTOR_TIMEOUT_MS })
      : MAX_SELECTOR_TIMEOUT_MS
    const result = await getAriaSnapshot({
      page,
      locator,
      interactiveOnly: useInteractiveOnly,
      scopeTimeoutMs,
    })
    const selectorByShortRef = new Map(
      result.refs.flatMap((entry) => {
        const selector = result.getSelectorForRef(entry.ref)
        return selector ? [[entry.shortRef, selector] as const] : []
      }),
    )
    // Restrict the returned refs to the same search/offset/limit window applied to
    // the text. No match means empty refs; shortRef identities are preserved.
    const { text, visibleRefs } = formatSnapshotText({
      snapshotLines: result.snapshotLines,
      refs: result.refs,
      search,
      offset,
      limit,
    })
    const snapshotRefs = result.refs.flatMap((entry) => {
      if (!visibleRefs.has(entry.shortRef)) {
        return [] as Array<{ ref: string; role: string; name: string; selector: string }>
      }
      const selector = selectorByShortRef.get(entry.shortRef)
      if (!selector) {
        return [] as Array<{ ref: string; role: string; name: string; selector: string }>
      }
      return [{ ref: entry.shortRef, role: entry.role, name: entry.name, selector }]
    })
    const refs = new Map(snapshotRefs.map((entry) => [entry.ref, entry.selector]))
    pageState.snapshotGeneration += 1
    const snapshotId = [
      'managed',
      pageState.targetId,
      pageState.pageGeneration,
      pageState.snapshotGeneration,
      crypto.randomUUID(),
    ].join(':')
    pageState.latestSnapshot = {
      id: snapshotId,
      pageGeneration: pageState.pageGeneration,
      refs,
    }
    return {
      text,
      snapshotId,
      value: {
        refs: snapshotRefs.map((entry) => {
          return { ref: entry.ref, role: entry.role, name: entry.name }
        }),
      },
    }
  }

  private nativeOperationTimeout({ deadline, maximumMs }: { deadline: number; maximumMs: number }): number {
    const timeout = calculateNativeOperationTimeout({ deadline, now: Date.now(), maximumMs })
    if (timeout > 0) {
      return timeout
    }
    throw new ManagedExecutorOperationError({
      code: 'timeout',
      message: 'Request deadline left no time to start the browser operation',
    })
  }

  private errorResponse({
    requestId,
    error,
    sideEffectsStarted,
  }: {
    requestId: string
    error: unknown
    sideEffectsStarted: boolean
  }): BrowserResponse {
    const requestedOutcome = error instanceof ManagedExecutorOperationError ? error.outcome : 'not-started'
    if (error instanceof ManagedExecutorOperationError) {
      return {
        requestId,
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          outcome: resolveManagedOperationOutcome({ sideEffectsStarted, outcome: requestedOutcome }),
        },
      }
    }
    return {
      requestId,
      ok: false,
      error: {
        code: 'execution-failed',
        message: errorMessage(error),
        outcome: resolveManagedOperationOutcome({ sideEffectsStarted, outcome: requestedOutcome }),
      },
    }
  }
}

export function calculateNativeOperationTimeout({
  deadline,
  now,
  maximumMs,
}: {
  deadline: number
  now: number
  maximumMs: number
}): number {
  return Math.max(0, Math.min(maximumMs, Math.floor(deadline - now - RESPONSE_RESERVE_MS)))
}

export function attachObservedPageInfo({
  data,
  tabId,
  url,
  operationKind,
}: {
  data: BrowserResultData
  tabId: string
  url: string
  operationKind: BrowserPageOperation['kind']
}): BrowserResultData {
  if (data.pageInfo) {
    return data
  }
  const canSupplyTitle = operationKind === 'page.navigate' || operationKind === 'page.back'
  const observedTitle =
    canSupplyTitle &&
    data.value &&
    typeof data.value === 'object' &&
    !Array.isArray(data.value) &&
    typeof data.value.title === 'string'
      ? data.value.title
      : undefined
  return {
    ...data,
    pageInfo: {
      tabId,
      url,
      ...(observedTitle !== undefined ? { title: observedTitle } : {}),
    },
  }
}

export function resolveManagedOperationOutcome({
  sideEffectsStarted,
  outcome,
}: {
  sideEffectsStarted: boolean
  outcome: 'not-started' | 'unknown'
}): 'not-started' | 'unknown' {
  return sideEffectsStarted ? 'unknown' : outcome
}

type SnapshotRefMetadata = {
  shortRef: string
  role: string
  name: string
}

export function formatSnapshotText({
  snapshotLines,
  refs,
  search,
  offset,
  limit,
  maxChars = MAX_SNAPSHOT_CHARS,
  maxBytes = MAX_SNAPSHOT_BYTES,
  maxRefsBytes = MAX_SNAPSHOT_REFS_BYTES,
  maxLines = MAX_SNAPSHOT_LINES,
}: {
  snapshotLines: SnapshotOutputLine[]
  refs: SnapshotRefMetadata[]
  search?: string
  offset: number
  limit?: number
  maxChars?: number
  maxBytes?: number
  maxRefsBytes?: number
  maxLines?: number
}): { text: string; visibleRefs: Set<string> } {
  const searchedLines = search ? selectSearchLines({ lines: snapshotLines, search }) : snapshotLines
  const boundedOffset = Number.isInteger(offset) && offset >= 0 ? offset : 0
  const boundedLimit = limit === undefined ? maxLines : Math.max(0, Math.floor(limit))
  const window = searchedLines.slice(boundedOffset, boundedOffset + Math.min(boundedLimit, maxLines))
  const refByShortRef = new Map(refs.map((entry) => [entry.shortRef, entry]))
  const outputLines: string[] = []
  const outputRefs: SnapshotRefMetadata[] = []
  const visibleRefs = new Set<string>()
  const marker = '[truncated; use search or offset/limit in execute snapshot helper]'
  const textBudgetChars = Math.max(0, maxChars - marker.length - 1)
  const textBudgetBytes = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8') - 1)
  let textChars = 0
  let textBytes = 0
  let budgetTruncated = false

  for (const line of window) {
    const separator = outputLines.length === 0 ? '' : '\n'
    const lineChars = separator.length + line.text.length
    const lineBytes = Buffer.byteLength(`${separator}${line.text}`, 'utf8')
    const ref = line.shortRef ? refByShortRef.get(line.shortRef) : undefined
    const nextRefs = ref && !visibleRefs.has(ref.shortRef) ? [...outputRefs, ref] : outputRefs
    const refsFit = Buffer.byteLength(JSON.stringify({ refs: nextRefs }), 'utf8') <= maxRefsBytes
    if (textChars + lineChars > textBudgetChars || textBytes + lineBytes > textBudgetBytes || !refsFit) {
      budgetTruncated = true
      if (!line.shortRef && textChars < textBudgetChars && textBytes < textBudgetBytes) {
        const prefix = sliceUnicodeText({
          value: `${separator}${line.text}`,
          maxChars: textBudgetChars - textChars,
          maxBytes: textBudgetBytes - textBytes,
        })
        if (prefix) {
          outputLines.push(prefix.slice(separator.length))
        }
      }
      break
    }
    outputLines.push(line.text)
    textChars += lineChars
    textBytes += lineBytes
    if (ref && !visibleRefs.has(ref.shortRef)) {
      outputRefs.push(ref)
      visibleRefs.add(ref.shortRef)
    }
  }

  let text = outputLines.join('\n')
  if (budgetTruncated || window.length < searchedLines.length - boundedOffset) {
    text += `${text ? '\n' : ''}${marker}`
  }
  return { text, visibleRefs }
}

function sliceUnicodeText({
  value,
  maxChars,
  maxBytes,
}: {
  value: string
  maxChars: number
  maxBytes: number
}): string {
  let result = ''
  let chars = 0
  let bytes = 0
  for (const character of value) {
    const characterChars = character.length
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (chars + characterChars > maxChars || bytes + characterBytes > maxBytes) {
      break
    }
    result += character
    chars += characterChars
    bytes += characterBytes
  }
  return result
}

// A synthetic "No matches found" line carries no ref, so refs collapse to empty
// when the search matches nothing.
const NO_SEARCH_MATCHES_LINE: SnapshotOutputLine = { text: 'No matches found' }

function selectSearchLines({ lines, search }: { lines: SnapshotOutputLine[]; search: string }): SnapshotOutputLine[] {
  const matches = lines
    .map((line, index) => ({ line, index }))
    .filter((entry) => entry.line.text.includes(search))
    .slice(0, 10)
  if (matches.length === 0) {
    return [NO_SEARCH_MATCHES_LINE]
  }
  const included = new Set<number>()
  matches.forEach(({ index }) => {
    const start = Math.max(0, index - 5)
    const end = Math.min(lines.length - 1, index + 5)
    for (let current = start; current <= end; current += 1) {
      included.add(current)
    }
  })
  const indices = [...included].sort((left, right) => left - right)
  return indices.reduce<SnapshotOutputLine[]>((result, index, position) => {
    if (position > 0 && indices[position - 1] !== index - 1) {
      result.push({ text: '---' })
    }
    result.push(lines[index])
    return result
  }, [])
}

function normalizeSnapshotRef(selector: string): string | null {
  const normalized = selector.trim()
  if (normalized.startsWith('aria-ref=')) {
    return normalized.slice('aria-ref='.length)
  }
  if (normalized.startsWith('@')) {
    return normalized.slice(1)
  }
  return null
}

function filterEntries({ entries, filter }: { entries: BrowserJson[]; filter?: string }): BrowserJson[] {
  if (!filter) {
    return entries.slice(-MAX_NETWORK_ENTRIES)
  }
  return entries.filter((entry) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false
    }
    return typeof entry.url === 'string' && entry.url.includes(filter)
  })
}

function formatConsoleLine({ method, args }: { method: string; args: unknown[] }): string {
  const values = args.map((arg) => {
    const serialized = serializeBrowserJson(arg)
    return typeof serialized === 'string' ? serialized : JSON.stringify(serialized)
  })
  return truncateString({ value: `[${method}] ${values.join(' ')}`, maxLength: 4_000 })
}

function appendImage({
  images,
  base64,
  mimeType,
}: {
  images: Array<{ data: string; mimeType: string }>
  base64: string
  mimeType: string
}): void {
  if (base64.length <= MAX_INLINE_IMAGE_BASE64) {
    images.push({ data: base64, mimeType })
  }
}

function resolveArtifactPath({ requestedPath, cwd }: { requestedPath: string; cwd: string | null }): string {
  if (!isAbsolutePath(requestedPath)) {
    throw new ManagedExecutorOperationError({
      code: 'invalid-request',
      message: `Screenshot path must be absolute: ${requestedPath}`,
    })
  }
  const normalized = path.normalize(requestedPath)
  try {
    fs.mkdirSync(path.dirname(normalized), { recursive: true })
  } catch (error) {
    throw new ManagedExecutorOperationError({
      code: 'execution-failed',
      message: `Could not create screenshot directory${cwd ? ` for ${cwd}` : ''}: ${errorMessage(error)}`,
      cause: error,
    })
  }
  return normalized
}

function validateNavigationUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (error) {
    throw new ManagedExecutorOperationError({
      code: 'invalid-request',
      message: `Invalid navigation URL: ${errorMessage(error)}`,
      cause: error,
    })
  }
  const allowedProtocols = new Set<string>(['about:', 'data:', 'http:', 'https:'])
  if (!allowedProtocols.has(parsed.protocol)) {
    throw new ManagedExecutorOperationError({
      code: 'invalid-request',
      message: `Navigation URL scheme ${parsed.protocol} is not allowed`,
    })
  }
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function wrapCodeForEvaluation(code: string): string {
  return `(async () => { ${code}\n })()`
}

function wrapCodeForExecution(code: string): string {
  const expression = getAutoReturnExpression(code)
  if (expression) {
    return `(async () => { return await (${expression}) })()`
  }
  return `(async () => { ${code}\n })()`
}

function getAutoReturnExpression(code: string): string | null {
  try {
    const ast = acorn.parse(code, {
      ecmaVersion: 'latest',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      sourceType: 'script',
    })
    if (ast.body.length !== 1) {
      return null
    }
    const statement = ast.body[0]
    if (!statement || statement.type !== 'ExpressionStatement') {
      return null
    }
    if (statement.expression.type === 'AssignmentExpression' || statement.expression.type === 'UpdateExpression') {
      return null
    }
    if (statement.expression.type === 'UnaryExpression' && statement.expression.operator === 'delete') {
      return null
    }
    if (statement.expression.type === 'SequenceExpression') {
      if (statement.expression.expressions.some((expression) => expression.type === 'AssignmentExpression')) {
        return null
      }
    }
    return code.slice(statement.expression.start, statement.expression.end)
  } catch {
    return null
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported managed page operation: ${String(value)}`)
}

function isBrowserPageOperation(operation: BrowserRequest['operation']): operation is BrowserPageOperation {
  return operation.kind.startsWith('page.')
}

export async function runManagedExecutorWorker(): Promise<void> {
  const runtime = new ManagedExecutorWorkerRuntime()
  writeWorkerMessage({
    type: 'ready',
    protocolVersion: 1,
  })
  let buffer = ''
  let commandQueue: Promise<void> = Promise.resolve()
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    try {
      const split = splitManagedWorkerLines({ buffer, chunk })
      buffer = split.remainder
      if (Buffer.byteLength(buffer, 'utf8') > MAX_MANAGED_WORKER_MESSAGE_BYTES) {
        throw new Error('Managed executor worker input exceeded the protocol buffer limit')
      }
      split.lines.forEach((line) => {
        if (Buffer.byteLength(line, 'utf8') > MAX_MANAGED_WORKER_MESSAGE_BYTES) {
          throw new Error('Managed executor worker command exceeded the protocol message limit')
        }
        const message = parseManagedWorkerCommand(line)
        if (!message) {
          return
        }
        commandQueue = commandQueue
          .then(async () => {
            await handleWorkerCommand({ runtime, command: message })
          })
          .catch((error) => {
            writeWorkerMessage({
              type: 'error',
              id: message.id,
              error: { message: errorMessage(error) },
            })
          })
      })
    } catch (error) {
      console.error('[managed-executor] invalid worker input:', errorMessage(error))
      process.exit(1)
    }
  })
  process.stdin.on('end', () => {
    commandQueue = commandQueue.then(async () => {
      await runtime.dispose()
    })
  })
}

async function handleWorkerCommand({
  runtime,
  command,
}: {
  runtime: ManagedExecutorWorkerRuntime
  command: ManagedExecutorWorkerCommand
}): Promise<void> {
  if (command.type === 'execute') {
    const response = await runtime.execute(command.execution)
    writeWorkerMessage({ type: 'response', id: command.id, response })
    return
  }
  await runtime.dispose()
  writeWorkerMessage({ type: 'disposed', id: command.id })
  process.stdout.end(() => {
    process.exit(0)
  })
}

function writeWorkerMessage(message: ManagedExecutorWorkerWireMessage): void {
  let encoded: string
  try {
    encoded = encodeManagedWorkerMessage(message)
  } catch (error) {
    console.error('[managed-executor] could not serialize worker message:', errorMessage(error))
    const fallback =
      message.type === 'response'
        ? {
            type: 'error' as const,
            id: message.id,
            error: { message: 'Managed executor response exceeded the protocol message limit' },
          }
        : {
            type: 'error' as const,
            error: { message: 'Managed executor worker response could not be serialized' },
          }
    try {
      process.stdout.write(encodeManagedWorkerMessage(fallback), () => {
        process.exit(1)
      })
    } catch (fallbackError) {
      console.error('[managed-executor] could not serialize worker fallback:', errorMessage(fallbackError))
      process.exit(1)
    }
    return
  }
  process.stdout.write(encoded)
}

function isWorkerEntry(): boolean {
  const entry = process.argv[1]
  if (!entry) {
    return false
  }
  const entryUrl = url.pathToFileURL(path.resolve(entry)).href
  return entryUrl === import.meta.url
}

if (isWorkerEntry()) {
  void runManagedExecutorWorker().catch((error) => {
    console.error('[managed-executor] worker failed:', errorMessage(error))
    process.exitCode = 1
  })
}
