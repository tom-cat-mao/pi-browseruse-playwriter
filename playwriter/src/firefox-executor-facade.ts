import type {
  BrowserDomCommand,
  BrowserDomLocator,
  BrowserDomLocatorAction,
  BrowserDomLocatorStep,
  BrowserJson,
  BrowserResultData,
} from './browser-protocol.js'
import { isFirefoxBrowserJson, isFirefoxWorkerRecord } from './firefox-executor-protocol.js'

export class FirefoxCapabilityError extends Error {
  readonly code = 'unsupported-capability'
}

export interface FirefoxFacadeOptions {
  tabId: string
  initialUrl: string
  deadline: number
  send: (command: BrowserDomCommand) => Promise<BrowserResultData>
  assertActive: () => void
}

export interface FirefoxFacade {
  page: object
  context: object
  globals: Record<string, unknown>
}

type SelectorStep = Extract<BrowserDomLocatorStep, { kind: 'selector' }>

/** Playwright-shaped methods backed by the Firefox extension's explicit-tab DOM transport. */
export function createFirefoxFacade(options: FirefoxFacadeOptions): FirefoxFacade {
  const locators = new WeakMap<object, BrowserDomLocator>()
  let currentUrl = options.initialUrl
  let latestSnapshot: BrowserResultData | undefined
  let defaultTimeout = 5_000
  let page: object
  const send = async (command: BrowserDomCommand): Promise<BrowserResultData> => {
    options.assertActive()
    const data = await options.send(command)
    if (data.pageInfo?.url) {
      currentUrl = data.pageInfo.url
    }
    return data
  }
  const sendValue = async (command: BrowserDomCommand): Promise<BrowserJson> => {
    return (await send(command)).value ?? null
  }
  const operation = async (command: Extract<BrowserDomCommand, { method: 'operation' }>['operation']): Promise<BrowserResultData> => {
    return await send({ method: 'operation', operation: command })
  }
  const action = async ({ locator, name, args }: {
    locator: BrowserDomLocator
    name: BrowserDomLocatorAction
    args: unknown[]
  }): Promise<BrowserJson> => {
    options.assertActive()
    const normalizedArgs = args.map((value) => {
      if (value === undefined) {
        return null
      }
      return jsonArgument(value)
    })
    return await sendValue({ method: 'locator', locator, action: name, args: normalizedArgs })
  }
  const query = ({ base, engine, args }: { base: BrowserDomLocatorStep[]; engine: SelectorStep['engine']; args: unknown[] }): object => {
    options.assertActive()
    const value = stringMatcher(args[0])
    const queryOptions = recordOptions(args[1])
    const roleKeys = ['name', 'exact', 'checked', 'disabled', 'expanded', 'selected', 'pressed', 'level', 'includeHidden']
    assertOptions({ value: queryOptions, keys: engine === 'role' ? roleKeys : ['exact'] })
    const step: SelectorStep = { kind: 'selector', engine, value }
    if (queryOptions.exact !== undefined) {
      step.exact = booleanArgument(queryOptions.exact)
    }
    if (engine === 'role') {
      if (queryOptions.name !== undefined) {
        step.name = stringMatcher(queryOptions.name)
      }
      const roleOptions: NonNullable<SelectorStep['options']> = {}
      for (const key of ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'includeHidden'] as const) {
        if (queryOptions[key] !== undefined) {
          roleOptions[key] = booleanArgument(queryOptions[key])
        }
      }
      if (queryOptions.level !== undefined) {
        roleOptions.level = integerArgument({ value: queryOptions.level, minimum: 1, maximum: 100 })
      }
      if (Object.keys(roleOptions).length > 0) {
        step.options = roleOptions
      }
    }
    return locatorFacade({ steps: [...base, step] })
  }
  const queryMethods = (steps: BrowserDomLocatorStep[]): Record<string, unknown> => {
    const methods: Record<string, unknown> = {}
    const engines = {
      locator: 'css', getByRole: 'role', getByText: 'text', getByLabel: 'label',
      getByPlaceholder: 'placeholder', getByTestId: 'testId', getByAltText: 'alt', getByTitle: 'title',
    } as const
    for (const [method, engine] of Object.entries(engines)) {
      methods[method] = (...args: unknown[]) => {
        return query({ base: steps, engine, args })
      }
    }
    methods.frameLocator = (selector: unknown) => {
      return locatorFacade({ steps: [...steps, { kind: 'frame', selector: stringArgument(selector) }] })
    }
    return methods
  }
  const locatorFacade = (locator: BrowserDomLocator): object => {
    const methods = queryMethods(locator.steps)
    for (const name of [
      'count', 'click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'setChecked',
      'selectOption', 'hover', 'focus', 'blur', 'scrollIntoViewIfNeeded', 'waitFor',
      'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute', 'allTextContents',
      'allInnerTexts', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isEditable', 'isChecked', 'boundingBox',
    ] as const) {
      methods[name] = async (...args: unknown[]) => {
        return await action({ locator, name, args })
      }
    }
    methods.clear = async (actionOptions?: unknown) => {
      return await action({ locator, name: 'fill', args: ['', actionOptions] })
    }
    methods.pressSequentially = async (...args: unknown[]) => {
      return await action({ locator, name: 'type', args })
    }
    methods.nth = (index: unknown) => {
      return locatorFacade({ steps: [...locator.steps, { kind: 'nth', index: integerArgument({ value: index, minimum: 0, maximum: 100_000 }) }] })
    }
    methods.first = () => {
      return locatorFacade({ steps: [...locator.steps, { kind: 'nth', index: 0 }] })
    }
    methods.last = () => {
      return locatorFacade({ steps: [...locator.steps, { kind: 'nth', index: -1 }] })
    }
    methods.filter = (filterOptions: unknown) => {
      options.assertActive()
      const value = recordOptions(filterOptions)
      assertOptions({ value, keys: ['hasText', 'hasNotText', 'has', 'hasNot'] })
      const step: Extract<BrowserDomLocatorStep, { kind: 'filter' }> = { kind: 'filter' }
      if (value.hasText !== undefined) {
        step.hasText = stringMatcher(value.hasText)
      }
      if (value.hasNotText !== undefined) {
        step.hasNotText = stringMatcher(value.hasNotText)
      }
      for (const key of ['has', 'hasNot'] as const) {
        if (value[key] !== undefined) {
          step[key] = localLocator(value[key])
        }
      }
      return locatorFacade({ steps: [...locator.steps, step] })
    }
    methods.all = async () => {
      const count = await action({ locator, name: 'count', args: [] })
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count > 10_000) {
        throw new Error('Locator count exceeds the 10000-element execute limit')
      }
      return Array.from({ length: count }, (_, index) => {
        return locatorFacade({ steps: [...locator.steps, { kind: 'nth', index }] })
      })
    }
    methods.evaluate = async (...args: unknown[]) => {
      return await sendValue({ method: 'evaluate', locator, code: evaluationCode({ input: args[0], arg: args[1], element: true }) })
    }
    methods.ariaSnapshot = async (snapshotOptions?: unknown) => {
      return await snapshot({ ...recordOptions(snapshotOptions), locator: result })
    }
    methods.page = () => {
      options.assertActive()
      return page
    }
    const result = unsupportedProxy({ methods, label: 'locator' })
    locators.set(result, locator)
    return result
  }
  const localLocator = (value: unknown): BrowserDomLocator => {
    if (typeof value !== 'object' || value === null) {
      throw new FirefoxCapabilityError('Expected a locator created by the current Firefox execute request')
    }
    const locator = locators.get(value)
    if (!locator) {
      throw new FirefoxCapabilityError('Locators from a previous execute request or another page cannot be reused; create a fresh locator')
    }
    return locator
  }
  const selectedPage = (value: unknown): void => {
    if (value !== undefined && value !== page) {
      throw new FirefoxCapabilityError('Firefox execute helpers only accept the explicitly selected page')
    }
  }
  const snapshot = async (input: unknown = {}): Promise<string> => {
    const value = recordOptions(input)
    assertOptions({ value, keys: ['page', 'locator', 'selector', 'search', 'full', 'interactiveOnly', 'offset', 'limit', 'showDiffSinceLastCall'] })
    selectedPage(value.page)
    if (value.showDiffSinceLastCall === true) {
      throw new FirefoxCapabilityError('Firefox snapshot diffs are not available; request the current snapshot')
    }
    let selector = value.selector === undefined ? undefined : stringArgument(value.selector)
    if (value.locator !== undefined) {
      const steps = localLocator(value.locator).steps
      const step = steps.length === 1 ? steps[0] : undefined
      if (!step || step.kind !== 'selector' || step.engine !== 'css') {
        throw new FirefoxCapabilityError('Firefox snapshot locator scoping currently requires a single CSS locator; use selector or search')
      }
      selector = step.value
    }
    latestSnapshot = await send({
      method: 'snapshot',
      ...(selector !== undefined ? { selector } : {}),
      ...(value.search !== undefined ? { search: stringArgument(value.search) } : {}),
      ...(value.full !== undefined ? { full: booleanArgument(value.full) } : {}),
      ...(value.interactiveOnly !== undefined ? { interactiveOnly: booleanArgument(value.interactiveOnly) } : {}),
    })
    const lines = (latestSnapshot.text ?? '').split('\n')
    const offset = value.offset === undefined ? 0 : integerArgument({ value: value.offset, minimum: 0, maximum: 100_000 })
    const limit = value.limit === undefined ? lines.length : integerArgument({ value: value.limit, minimum: 0, maximum: 100_000 })
    return lines.slice(offset, offset + limit).join('\n')
  }
  const refToLocator = (input: unknown): string | null => {
    options.assertActive()
    const value = recordOptions(input)
    assertOptions({ value, keys: ['page', 'ref'] })
    selectedPage(value.page)
    const ref = stringArgument(value.ref).replace(/^(?:aria-ref=|@)/, '')
    const data = latestSnapshot?.value
    if (!isFirefoxWorkerRecord(data) || !Array.isArray(data.refs)) {
      return null
    }
    const entry: unknown = data.refs.find((item) => {
      return isFirefoxWorkerRecord(item) && item.ref === ref
    })
    return isFirefoxWorkerRecord(entry) && typeof entry.selector === 'string' ? entry.selector : null
  }
  const screenshot = async (input: unknown = {}): Promise<Buffer> => {
    const value = recordOptions(input)
    assertOptions({ value, keys: ['page', 'path', 'fullPage', 'labels', 'type'] })
    selectedPage(value.page)
    if (value.type !== undefined && value.type !== 'png') {
      throw new FirefoxCapabilityError('Firefox execute screenshots currently use PNG')
    }
    const data = await operation({
      kind: 'page.screenshot', tabId: options.tabId,
      ...(value.path !== undefined ? { path: stringArgument(value.path) } : {}),
      ...(value.fullPage !== undefined ? { fullPage: booleanArgument(value.fullPage) } : {}),
      ...(value.labels !== undefined ? { labels: booleanArgument(value.labels) } : {}),
    })
    const image = data.images?.[0]
    if (!image) {
      throw new Error('Firefox screenshot response did not contain image data')
    }
    return Buffer.from(image.data, 'base64')
  }
  const pageMethods = queryMethods([])
  pageMethods.url = () => {
    options.assertActive()
    return currentUrl
  }
  for (const [method, actionName] of [['title', 'title'], ['content', 'content']] as const) {
    pageMethods[method] = async () => {
      return await sendValue({ method: 'page', action: actionName })
    }
  }
  pageMethods.evaluate = async (...args: unknown[]) => {
    return await sendValue({ method: 'evaluate', code: evaluationCode({ input: args[0], arg: args[1], element: false }) })
  }
  pageMethods.goto = async (...args: unknown[]) => {
    const value = recordOptions(args[1])
    assertOptions({ value, keys: [] })
    await operation({ kind: 'page.navigate', tabId: options.tabId, url: stringArgument(args[0]) })
    return null
  }
  pageMethods.goBack = async (input?: unknown) => {
    assertOptions({ value: recordOptions(input), keys: [] })
    await operation({ kind: 'page.back', tabId: options.tabId })
    return null
  }
  pageMethods.screenshot = screenshot
  pageMethods.ariaSnapshot = snapshot
  pageMethods.isClosed = () => {
    options.assertActive()
    return false
  }
  for (const name of ['click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'selectOption', 'hover', 'focus', 'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled', 'isChecked'] as const) {
    pageMethods[name] = async (...args: unknown[]) => {
      return await action({ locator: { steps: [{ kind: 'selector', engine: 'css', value: stringArgument(args[0]) }] }, name, args: args.slice(1) })
    }
  }
  pageMethods.setDefaultTimeout = (timeout: unknown) => {
    defaultTimeout = integerArgument({ value: timeout, minimum: 1, maximum: 5_000 })
  }
  const waitForFunction = async (...args: unknown[]): Promise<BrowserJson> => {
    const value = recordOptions(args[2])
    assertOptions({ value, keys: ['timeout', 'polling'] })
    const timeout = value.timeout === undefined ? defaultTimeout : integerArgument({ value: value.timeout, minimum: 1, maximum: 5_000 })
    const interval = value.polling === undefined || value.polling === 'raf' ? 50 : integerArgument({ value: value.polling, minimum: 10, maximum: 1_000 })
    const deadline = Math.min(options.deadline, Date.now() + timeout)
    while (Date.now() < deadline) {
      const result = await sendValue({ method: 'evaluate', code: evaluationCode({ input: args[0], arg: args[1], element: false }) })
      if (result) {
        return result
      }
      await new Promise<void>((resolve) => { setTimeout(resolve, interval) })
    }
    throw new Error(`Firefox waitForFunction timed out after ${timeout} ms`)
  }
  pageMethods.waitForFunction = waitForFunction
  pageMethods.waitForLoadState = async (...args: unknown[]) => {
    const state = args[0] ?? 'load'
    if (state !== 'load' && state !== 'domcontentloaded') {
      throw new FirefoxCapabilityError('Firefox supports load and domcontentloaded waits; networkidle needs browser-level instrumentation')
    }
    return await waitForFunction(`return document.readyState ${state === 'load' ? "=== 'complete'" : "!== 'loading'"}`, undefined, args[1])
  }
  const context = unsupportedProxy({ methods: {}, label: 'context' })
  pageMethods.context = () => {
    options.assertActive()
    return context
  }
  page = unsupportedProxy({ methods: pageMethods, label: 'page' })
  const globals: Record<string, unknown> = {
    snapshot, refToLocator,
    getLatestLogs: async (input: unknown = {}) => {
      const value = recordOptions(input)
      assertOptions({ value, keys: ['page', 'count'] })
      selectedPage(value.page)
      const data = await send({ method: 'logs', ...(value.count === undefined ? {} : { limit: integerArgument({ value: value.count, minimum: 0, maximum: 500 }) }) })
      return data.logs ?? []
    },
    screenshotWithAccessibilityLabels: async (input: unknown = {}) => {
      return await screenshot({ ...recordOptions(input), labels: true })
    },
    waitForPageLoad: async (input: unknown = {}) => {
      const value = recordOptions(input)
      assertOptions({ value, keys: ['page', 'timeout'] })
      selectedPage(value.page)
      return await waitForFunction("return document.readyState === 'complete'", undefined, value.timeout === undefined ? {} : { timeout: value.timeout })
    },
    getCDPSession: () => {
      throw new FirefoxCapabilityError('Firefox ordinary extensions do not provide CDP sessions')
    },
  }
  return { page, context, globals }
}

function unsupportedProxy({ methods, label }: { methods: Record<string, unknown>; label: string }): object {
  return new Proxy(Object.freeze(methods), {
    get(target, property) {
      if (property === 'then' || typeof property === 'symbol') {
        return undefined
      }
      if (Object.hasOwn(target, property)) {
        return target[property]
      }
      throw new FirefoxCapabilityError(`Firefox DOM execute does not support ${label}.${property}; use supported page/locator methods or explicit browser tools`)
    },
  })
}

function evaluationCode({ input, arg, element }: { input: unknown; arg: unknown; element: boolean }): string {
  if (typeof input === 'string') {
    if (arg !== undefined) {
      throw new FirefoxCapabilityError('String evaluate code does not accept an argument; use a function with an argument')
    }
    return input
  }
  if (typeof input !== 'function') {
    throw new Error('evaluate expects a JavaScript function or code string with an explicit return')
  }
  const source = Function.prototype.toString.call(input)
  const argument = arg === undefined ? 'undefined' : JSON.stringify(jsonArgument(arg))
  return `return await (${source})(${element ? `element, ${argument}` : argument});`
}

function recordOptions(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) {
    return {}
  }
  if (!isFirefoxWorkerRecord(value)) {
    throw new Error('Expected an options object')
  }
  return value
}

function assertOptions({ value, keys }: { value: Record<string, unknown>; keys: string[] }): void {
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && value[key] !== undefined) {
      throw new FirefoxCapabilityError(`Firefox DOM execute does not support option ${key}`)
    }
  }
}

function stringArgument(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a string')
  }
  return value
}

function stringMatcher(value: unknown): string {
  if (typeof value !== 'string') {
    throw new FirefoxCapabilityError('Firefox DOM locators currently require string matchers; regular expressions are not supported')
  }
  return value
}

function booleanArgument(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Expected a boolean')
  }
  return value
}

function integerArgument({ value, minimum, maximum }: { value: unknown; minimum: number; maximum: number }): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function jsonArgument(value: unknown): BrowserJson {
  if (!isFirefoxBrowserJson(value)) {
    throw new FirefoxCapabilityError('Firefox execute arguments must be finite JSON values; handles, functions and cyclic values are not supported')
  }
  return value
}
