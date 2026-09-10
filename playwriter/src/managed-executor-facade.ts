import type {
  Browser,
  BrowserContext,
  ElementHandle,
  Frame,
  FrameLocator,
  Locator,
  Page,
} from '@xmorse/playwright-core'
import type { ManagedExecutionLease } from './managed-executor-lease.js'

type Callable = (...args: unknown[]) => unknown
type PlaywrightObject = Browser | BrowserContext | ElementHandle | Frame | FrameLocator | Locator | Page

const PAGE_LOCATOR_METHODS = new Set<string>([
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'locator',
])

const PAGE_FRAME_METHODS = new Set<string>(['frame', 'frames', 'mainFrame'])
const PAGE_FRAME_LOCATOR_METHODS = new Set<string>(['frameLocator'])
const PAGE_ELEMENT_METHODS = new Set<string>(['$', '$$', 'waitForSelector'])
const LOCATOR_METHODS = new Set<string>([
  'and',
  'describe',
  'filter',
  'first',
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'last',
  'locator',
  'nth',
  'or',
])
const LOCATOR_ELEMENT_METHODS = new Set<string>(['elementHandle', 'elementHandles'])
const FRAME_LOCATOR_METHODS = new Set<string>([
  'getByAltText',
  'getByLabel',
  'getByPlaceholder',
  'getByRole',
  'getByTestId',
  'getByText',
  'getByTitle',
  'locator',
])
const ELEMENT_METHODS = new Set<string>(['$', '$$', 'contentFrame', 'ownerFrame'])
const EVENT_METHODS = new Set<string>(['addListener', 'on', 'once', 'prependListener'])
const REMOVE_EVENT_METHODS = new Set<string>(['off', 'removeListener'])

export interface ManagedPlaywrightFacadeOptions {
  context: BrowserContext
  browser: Browser
  allowedTargetIds: Set<string>
  lease?: ManagedExecutionLease
}

interface EventSubscription {
  target: PlaywrightObject
  event: string
  listener: Callable
}

/**
 * Keep the escape hatch Playwright-shaped while preventing it from acquiring
 * or destroying browser resources. The relay remains the authoritative target
 * boundary; this facade only prevents the most direct context/browser/page
 * escape paths. It is intentionally not a language sandbox: page.evaluate
 * still runs JavaScript in the selected page, and Playwright objects expose
 * their normal non-destructive APIs.
 */
export class ManagedPlaywrightFacade {
  private readonly context: BrowserContext
  private readonly browser: Browser
  private readonly allowedTargetIds: Set<string>
  private readonly lease?: ManagedExecutionLease
  private readonly pageProxies = new WeakMap<Page, Page>()
  private readonly pageRaws = new WeakMap<Page, Page>()
  private readonly contextProxies = new WeakMap<BrowserContext, BrowserContext>()
  private readonly contextRaws = new WeakMap<BrowserContext, BrowserContext>()
  private readonly browserProxies = new WeakMap<Browser, Browser>()
  private readonly browserRaws = new WeakMap<Browser, Browser>()
  private readonly locatorProxies = new WeakMap<Locator, Locator>()
  private readonly locatorRaws = new WeakMap<Locator, Locator>()
  private readonly frameProxies = new WeakMap<Frame, Frame>()
  private readonly frameRaws = new WeakMap<Frame, Frame>()
  private readonly frameLocatorProxies = new WeakMap<FrameLocator, FrameLocator>()
  private readonly frameLocatorRaws = new WeakMap<FrameLocator, FrameLocator>()
  private readonly elementProxies = new WeakMap<ElementHandle, ElementHandle>()
  private readonly elementRaws = new WeakMap<ElementHandle, ElementHandle>()
  private readonly listenerWrappers = new WeakMap<object, Map<Callable, Callable>>()
  private readonly eventSubscriptions: EventSubscription[] = []

  constructor(options: ManagedPlaywrightFacadeOptions) {
    this.context = options.context
    this.browser = options.browser
    this.allowedTargetIds = options.allowedTargetIds
    this.lease = options.lease
  }

  wrapPage(page: Page): Page {
    const existing = this.pageProxies.get(page)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(page, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (property === 'close') {
          return this.forbidden('page.close')
        }
        if (property === 'keyboard' || property === 'mouse' || property === 'touchscreen') {
          return undefined
        }
        if (property === 'context') {
          return () => {
            this.assertActive()
            return this.wrapContext(target.context())
          }
        }
        if (property === 'locator' || (typeof property === 'string' && PAGE_LOCATOR_METHODS.has(property))) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapLocatorResult(result)
          }
        }
        if (typeof property === 'string' && PAGE_FRAME_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapFrameResult(result)
          }
        }
        if (typeof property === 'string' && PAGE_FRAME_LOCATOR_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapFrameLocator(result as FrameLocator)
          }
        }
        if (typeof property === 'string' && PAGE_ELEMENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapElementResult(result)
          }
        }
        if (typeof property === 'string' && EVENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            return this.invokeEventMethod({ target, property, args })
          }
        }
        if (typeof property === 'string' && REMOVE_EVENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            return this.invokeRemoveEventMethod({ target, property, args })
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          if (property === 'waitForEvent' && args[0] === 'popup') {
            return this.wrapPageResult(result)
          }
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.pageProxies.set(page, proxy)
    this.pageRaws.set(proxy, page)
    return proxy
  }

  wrapContext(context: BrowserContext): BrowserContext {
    const existing = this.contextProxies.get(context)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(context, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (property === 'close' || property === 'newPage' || property === 'newCDPSession') {
          return this.forbidden(`context.${String(property)}`)
        }
        if (property === 'browser') {
          return () => {
            this.assertActive()
            return this.wrapBrowser(target.browser() ?? this.browser)
          }
        }
        if (property === 'pages') {
          return () => {
            this.assertActive()
            return target
              .pages()
              .filter((page) => this.isAllowedPage(page))
              .map((page) => this.wrapPage(page))
          }
        }
        if (typeof property === 'string' && EVENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            return this.invokeEventMethod({ target, property, args })
          }
        }
        if (typeof property === 'string' && REMOVE_EVENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            return this.invokeRemoveEventMethod({ target, property, args })
          }
        }
        if (property === 'getExistingCDPSession') {
          return (...args: unknown[]) => {
            return this.invoke({ target, property, args: this.unwrapArguments(args) })
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          if (property === 'waitForEvent' && args[0] === 'page') {
            return this.wrapPageResult(result)
          }
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.contextProxies.set(context, proxy)
    this.contextRaws.set(proxy, context)
    return proxy
  }

  wrapBrowser(browser: Browser): Browser {
    const existing = this.browserProxies.get(browser)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(browser, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (property === 'close' || property === 'newContext' || property === 'newPage') {
          return this.forbidden(`browser.${String(property)}`)
        }
        if (property === 'contexts') {
          return () => {
            this.assertActive()
            return target.contexts().map((context) => {
              return this.wrapContext(context)
            })
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.browserProxies.set(browser, proxy)
    this.browserRaws.set(proxy, browser)
    return proxy
  }

  wrapLocator(locator: Locator): Locator {
    const existing = this.locatorProxies.get(locator)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(locator, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (property === 'page') {
          return () => {
            this.assertActive()
            return this.wrapPage(target.page())
          }
        }
        if (property === 'ownerFrame') {
          return (...args: unknown[]) => {
            this.assertActive()
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapFrameResult(result)
          }
        }
        if (property === 'contentFrame') {
          return (...args: unknown[]) => {
            this.assertActive()
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapFrameLocatorResult(result)
          }
        }
        if (typeof property === 'string' && LOCATOR_ELEMENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapElementResult(result)
          }
        }
        if (typeof property === 'string' && LOCATOR_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapLocatorResult(result)
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.locatorProxies.set(locator, proxy)
    this.locatorRaws.set(proxy, locator)
    return proxy
  }

  wrapFrame(frame: Frame): Frame {
    const existing = this.frameProxies.get(frame)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(frame, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (property === 'page') {
          return () => {
            this.assertActive()
            return this.wrapPage(target.page())
          }
        }
        if (typeof property === 'string' && FRAME_LOCATOR_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapLocatorResult(result)
          }
        }
        if (property === 'frameLocator') {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapFrameLocator(result as FrameLocator)
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.frameProxies.set(frame, proxy)
    this.frameRaws.set(proxy, frame)
    return proxy
  }

  wrapFrameLocator(frameLocator: FrameLocator): FrameLocator {
    const existing = this.frameLocatorProxies.get(frameLocator)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(frameLocator, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (typeof property === 'string' && FRAME_LOCATOR_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            return this.wrapLocatorResult(result)
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.frameLocatorProxies.set(frameLocator, proxy)
    this.frameLocatorRaws.set(proxy, frameLocator)
    return proxy
  }

  wrapElement(element: ElementHandle): ElementHandle {
    const existing = this.elementProxies.get(element)
    if (existing) {
      return existing
    }

    const proxy = new Proxy(element, {
      get: (target, property) => {
        if (isPrivateProperty(property)) {
          return undefined
        }
        if (typeof property === 'string' && ELEMENT_METHODS.has(property)) {
          return (...args: unknown[]) => {
            const result = this.invoke({ target, property, args: this.unwrapArguments(args) })
            if (property === 'contentFrame' || property === 'ownerFrame') {
              return this.wrapFrameResult(result)
            }
            return this.wrapElementResult(result)
          }
        }

        const value = Reflect.get(target, property, target)
        if (!isCallable(value)) {
          return this.wrapGeneralResult(value)
        }
        return (...args: unknown[]) => {
          const result = this.invoke({ target, property, args: this.unwrapArguments(args), method: value })
          return this.wrapGeneralResult(result)
        }
      },
    })

    this.elementProxies.set(element, proxy)
    this.elementRaws.set(proxy, element)
    return proxy
  }

  unwrapPage(page: Page): Page {
    return this.pageRaws.get(page) ?? page
  }

  assertActive(): void {
    this.lease?.assertActive()
  }

  dispose(): void {
    this.eventSubscriptions.forEach((subscription) => {
      const remover = Reflect.get(subscription.target, 'removeListener', subscription.target)
      if (!isCallable(remover)) {
        return
      }
      try {
        Reflect.apply(remover, subscription.target, [subscription.event, subscription.listener])
      } catch (error) {
        console.error('[managed-executor] failed to remove raw listener:', error)
      }
    })
    this.eventSubscriptions.length = 0
  }

  unwrapContext(context: BrowserContext): BrowserContext {
    return this.contextRaws.get(context) ?? context
  }

  unwrapLocator(locator: Locator): Locator {
    return this.locatorRaws.get(locator) ?? locator
  }

  unwrapFrame(frame: Frame): Frame {
    return this.frameRaws.get(frame) ?? frame
  }

  isAllowedPage(page: Page): boolean {
    this.assertActive()
    const targetId = page.targetId()
    return targetId !== undefined && this.allowedTargetIds.has(targetId)
  }

  private wrapGeneralResult(value: unknown): unknown {
    if (value === this.context) {
      return this.wrapContext(this.context)
    }
    if (value === this.browser) {
      return this.wrapBrowser(this.browser)
    }
    if (isPromiseLike(value)) {
      return value.then((resolved) => {
        return this.wrapGeneralResult(resolved)
      })
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return this.wrapGeneralResult(entry)
      })
    }
    return value
  }

  private wrapPageResult(value: unknown): unknown {
    if (isPromiseLike(value)) {
      return value.then((resolved) => {
        return this.wrapPageResult(resolved)
      })
    }
    if (isPageLike(value)) {
      return this.wrapPage(value)
    }
    return value
  }

  private wrapLocatorResult(value: unknown): unknown {
    if (isPromiseLike(value)) {
      return value.then((resolved) => {
        return this.wrapLocatorResult(resolved)
      })
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return isLocatorLike(entry) ? this.wrapLocator(entry) : this.wrapElementResult(entry)
      })
    }
    if (isLocatorLike(value)) {
      return this.wrapLocator(value)
    }
    return value
  }

  private wrapFrameResult(value: unknown): unknown {
    if (isPromiseLike(value)) {
      return value.then((resolved) => {
        return this.wrapFrameResult(resolved)
      })
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return isFrameLike(entry) ? this.wrapFrame(entry) : entry
      })
    }
    if (isFrameLike(value)) {
      return this.wrapFrame(value)
    }
    return value
  }

  private wrapFrameLocatorResult(value: unknown): unknown {
    if (isPromiseLike(value)) {
      return value.then((resolved) => {
        return this.wrapFrameLocatorResult(resolved)
      })
    }
    if (isFrameLocatorLike(value)) {
      return this.wrapFrameLocator(value)
    }
    return value
  }

  private wrapElementResult(value: unknown): unknown {
    if (isPromiseLike(value)) {
      return value.then((resolved) => {
        return this.wrapElementResult(resolved)
      })
    }
    if (Array.isArray(value)) {
      return value.map((entry) => {
        return isElementLike(entry) ? this.wrapElement(entry) : entry
      })
    }
    if (isElementLike(value)) {
      return this.wrapElement(value)
    }
    return value
  }

  private invokeEventMethod({
    target,
    property,
    args,
  }: {
    target: PlaywrightObject
    property: string
    args: unknown[]
  }): unknown {
    const listener = args.at(-1)
    if (!isCallable(listener)) {
      return this.invoke({ target, property, args: this.unwrapArguments(args) })
    }
    const wrapper: Callable = (...eventArgs: unknown[]) => {
      if (this.lease && !this.lease.isActive()) {
        return undefined
      }
      const wrappedArgs = eventArgs.map((eventArg) => {
        return this.wrapEventValue(eventArg)
      })
      if (wrappedArgs.some((eventArg) => eventArg === null)) {
        return undefined
      }
      return listener(...wrappedArgs)
    }
    this.getListenerMap(target).set(listener, wrapper)
    const event = args[0]
    if (typeof event === 'string') {
      this.eventSubscriptions.push({ target, event, listener: wrapper })
    }
    const nextArgs = [...args.slice(0, -1), wrapper]
    return this.invoke({ target, property, args: this.unwrapArguments(nextArgs) })
  }

  private invokeRemoveEventMethod({
    target,
    property,
    args,
  }: {
    target: PlaywrightObject
    property: string
    args: unknown[]
  }): unknown {
    const listener = args.at(-1)
    const wrappedListener = isCallable(listener) ? this.getListenerMap(target).get(listener) : undefined
    const nextArgs = wrappedListener ? [...args.slice(0, -1), wrappedListener] : args
    const result = this.invoke({ target, property, args: this.unwrapArguments(nextArgs) })
    if (isCallable(listener)) {
      this.getListenerMap(target).delete(listener)
      const event = args[0]
      if (typeof event === 'string' && wrappedListener) {
        const subscriptionIndex = this.eventSubscriptions.findIndex((subscription) => {
          return subscription.target === target && subscription.event === event && subscription.listener === wrappedListener
        })
        if (subscriptionIndex >= 0) {
          this.eventSubscriptions.splice(subscriptionIndex, 1)
        }
      }
    }
    return result
  }

  private getListenerMap(target: PlaywrightObject): Map<Callable, Callable> {
    const object = target as object
    const existing = this.listenerWrappers.get(object)
    if (existing) {
      return existing
    }
    const listeners = new Map<Callable, Callable>()
    this.listenerWrappers.set(object, listeners)
    return listeners
  }

  private wrapEventValue(value: unknown): unknown {
    if (isPageLike(value)) {
      if (!this.isAllowedPage(value)) {
        return null
      }
      return this.wrapPage(value)
    }
    return this.wrapGeneralResult(value)
  }

  private unwrapArguments(args: unknown[]): unknown[] {
    return args.map((value) => {
      if (!isObject(value)) {
        return value
      }
      return (
        this.pageRaws.get(value as Page) ??
        this.contextRaws.get(value as BrowserContext) ??
        this.browserRaws.get(value as Browser) ??
        this.locatorRaws.get(value as Locator) ??
        this.frameRaws.get(value as Frame) ??
        this.frameLocatorRaws.get(value as FrameLocator) ??
        this.elementRaws.get(value as ElementHandle) ??
        value
      )
    })
  }

  private invoke({
    target,
    property,
    args,
    method,
  }: {
    target: PlaywrightObject
    property: string | symbol
    args: unknown[]
    method?: Callable
  }): unknown {
    this.assertActive()
    return invoke({ target, property, args, method })
  }

  private forbidden(operation: string): () => never {
    return () => {
      throw new Error(`${operation} is not available in a managed executor; use the managed tabs API`)
    }
  }
}

function invoke({
  target,
  property,
  args,
  method,
}: {
  target: PlaywrightObject
  property: string | symbol
  args: unknown[]
  method?: Callable
}): unknown {
  const callable = method ?? Reflect.get(target, property, target)
  if (!isCallable(callable)) {
    throw new Error(`Playwright member ${String(property)} is not callable`)
  }
  return Reflect.apply(callable, target, args)
}

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function'
}

function isPrivateProperty(property: string | symbol): boolean {
  return typeof property === 'string' && property.startsWith('_')
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof Reflect.get(value, 'then') === 'function'
}

function isPageLike(value: unknown): value is Page {
  if (!isObject(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.targetId === 'function' &&
    typeof candidate.url === 'function' &&
    typeof candidate.context === 'function'
  )
}

function isLocatorLike(value: unknown): value is Locator {
  if (!isObject(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.click === 'function' && typeof candidate.fill === 'function' && typeof candidate.page === 'function'
}

function isFrameLike(value: unknown): value is Frame {
  if (!isObject(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.frameId === 'function' && typeof candidate.page === 'function'
}

function isFrameLocatorLike(value: unknown): value is FrameLocator {
  if (!isObject(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.locator === 'function' && typeof candidate.getByRole === 'function'
}

function isElementLike(value: unknown): value is ElementHandle {
  if (!isObject(value)) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.evaluate === 'function' && typeof candidate.contentFrame === 'function'
}
