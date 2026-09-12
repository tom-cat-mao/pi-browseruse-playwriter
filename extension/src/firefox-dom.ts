import type {
  BrowserDomCommand,
  BrowserDomLocator,
  BrowserDomLocatorAction,
  BrowserDomRequest,
  BrowserJson,
  BrowserResponse,
  BrowserResultData,
} from 'playwriter/browser-protocol'
import {
  FirefoxDomError,
  accessibleName,
  ariaVisible,
  elementRole,
  isDisabled,
  isEditable,
  isVisible,
  locatorForSelector,
  normalizeText,
  resolveLocator,
  strictElement,
} from './firefox-dom-locators'
import {
  assertActionable,
  checkedState,
  clickElement,
  controlForElement,
  elementActionPoint,
  fillElement,
  focusElement,
  hoverElement,
  pressKey,
  selectOptions,
  setChecked,
} from './firefox-dom-input'
import { checkFramePoint } from './firefox-dom-frame'
import type { FramePoint } from './firefox-dom-frame'

type Evaluator = (element?: Element) => unknown | Promise<unknown>
type SnapshotRef = { ref: string; role: string; name: string; element: Element }
type Snapshot = { id: string; url: string; refs: Map<string, SnapshotRef> }
type Execution = { request: BrowserDomRequest; deadline: number; signal: AbortSignal; started: boolean }
type ActionOptions = { timeout?: number; force?: boolean; trial?: boolean; delay?: number }
type PreparedAction = {
  element: Element
  actionElement: Element
  requestId: string
  signature: string
  point: FramePoint
  expiresAt: number
}

export interface FirefoxDomDriver {
  readonly version: 1
  readonly disposed: boolean
  run(
    request: BrowserDomRequest,
    evaluator?: Evaluator,
    frameIdForElement?: (element: Element) => number,
  ): Promise<BrowserResponse>
  cancel(requestId: string): void
}

declare global {
  var __piFirefoxDom: FirefoxDomDriver | undefined
}

declare const exportFunction:
  | undefined
  | ((
      callback: (...args: unknown[]) => unknown,
      target: object,
      options?: { defineAs?: string },
    ) => (...args: unknown[]) => unknown)

const MAX_SNAPSHOT_LINES = 500
const MAX_SNAPSHOT_CHARS = 60000
const MAX_JSON_CHARS = 1_000_000
const INTERACTIVE_ROLES = new Set([
  'button',
  'checkbox',
  'combobox',
  'link',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'radio',
  'scrollbar',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'textbox',
  'treeitem',
])
const READ_ACTIONS = new Set<BrowserDomLocatorAction>([
  'count',
  'textContent',
  'innerText',
  'innerHTML',
  'inputValue',
  'getAttribute',
  'allTextContents',
  'allInnerTexts',
  'isVisible',
  'isHidden',
  'isEnabled',
  'isDisabled',
  'isEditable',
  'isChecked',
  'boundingBox',
  'waitFor',
])

export function browserJson(value: unknown): BrowserJson {
  const seen = new Set<object>()
  const convert = (current: unknown, depth: number): BrowserJson => {
    if (depth > 64) throw new FirefoxDomError({ message: 'The returned value exceeds the JSON nesting limit.' })
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current
    if (typeof current === 'number' && Number.isFinite(current)) return current
    if (typeof current !== 'object')
      throw new FirefoxDomError({
        message:
          'The evaluation result must be JSON: use an explicit return with a finite number, string, boolean, null, array, or plain object.',
      })
    if (seen.has(current)) throw new FirefoxDomError({ message: 'The returned value contains a circular reference.' })
    seen.add(current)
    try {
      if (Array.isArray(current))
        return current.map((entry) => {
          return convert(entry, depth + 1)
        })
      const prototype = Object.getPrototypeOf(current) as object | null
      if (
        Object.prototype.toString.call(current) !== '[object Object]' ||
        (prototype !== null && Object.getPrototypeOf(prototype) !== null)
      )
        throw new FirefoxDomError({
          message: 'DOM nodes and class instances cannot be returned; select explicit JSON fields.',
        })
      const result: { [key: string]: BrowserJson } = Object.create(null) as { [key: string]: BrowserJson }
      for (const [key, entry] of Object.entries(current)) result[key] = convert(entry, depth + 1)
      return result
    } finally {
      seen.delete(current)
    }
  }
  const result = convert(value, 0)
  if (JSON.stringify(result).length > MAX_JSON_CHARS)
    throw new FirefoxDomError({ message: 'The returned JSON exceeds 1 MB; return a smaller selection of fields.' })
  return result
}

function stringArg(options: { args: BrowserJson[]; index?: number; name: string }): string {
  const value = options.args[options.index ?? 0]
  if (typeof value !== 'string')
    throw new FirefoxDomError({ code: 'invalid-request', message: `${options.name} must be a string.` })
  return value
}

function actionOptions(options: { args: BrowserJson[]; index: number }): ActionOptions {
  const value = options.args[options.index]
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new FirefoxDomError({ code: 'invalid-request', message: 'Action options must be an object.' })
  const result: ActionOptions = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'timeout' || key === 'delay') {
      if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)
        throw new FirefoxDomError({ code: 'invalid-request', message: `${key} must be a finite, non-negative number.` })
      result[key] = entry
    } else if (key === 'force' || key === 'trial') {
      if (typeof entry !== 'boolean')
        throw new FirefoxDomError({ code: 'invalid-request', message: `${key} must be boolean.` })
      result[key] = entry
    } else if (key === 'noWaitAfter' && typeof entry === 'boolean') {
      // DOM actions return an immediate observation; navigation is checked by a following page operation.
    } else if ((key === 'button' && entry === 'left') || (key === 'clickCount' && entry === 1)) {
      // These are the default DOM click semantics.
    } else {
      throw new FirefoxDomError({
        code: 'unsupported-capability',
        message: `Firefox DOM input does not implement the ${key} action option.`,
      })
    }
  }
  return result
}

export function createFirefoxDomDriver(document: Document): FirefoxDomDriver {
  const view = document.defaultView
  if (!view) throw new FirefoxDomError({ message: 'The document has no active window.' })
  const documentId = view.crypto.randomUUID()
  const active = new Map<string, AbortController>()
  const cancelled = new Set<string>()
  const observers = new Map<Document | ShadowRoot, MutationObserver>()
  const cleanups: Array<() => void> = []
  const overlayNodes = new WeakSet<Node>()
  const logs: string[] = []
  const preparations = new Map<string, PreparedAction>()
  let binding: { sessionId: string; tabId: string; browserEpoch: string } | undefined
  let snapshot: Snapshot | undefined
  let overlay: HTMLElement | undefined
  let disposed = false
  let consoleAvailable = false

  const invalidate = (): void => {
    snapshot = undefined
    preparations.clear()
  }
  const checkActive = (execution: Execution): void => {
    if (execution.signal.aborted)
      throw new FirefoxDomError({
        code: 'cancelled',
        message: 'The Firefox DOM request was cancelled; no further action will start.',
      })
    if (Date.now() >= execution.deadline)
      throw new FirefoxDomError({ code: 'timeout', message: 'The Firefox DOM request reached its deadline.' })
  }
  const mutationIsOurs = (mutation: MutationRecord): boolean => {
    if (overlayNodes.has(mutation.target)) return true
    if (mutation.type !== 'childList') return false
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes]
    return (
      nodes.length > 0 &&
      nodes.every((node) => {
        return overlayNodes.has(node)
      })
    )
  }
  const observe = (root: Document | ShadowRoot): void => {
    if (observers.has(root)) return
    const observer = new view.MutationObserver((mutations) => {
      if (
        mutations.some((mutation) => {
          return !mutationIsOurs(mutation)
        })
      )
        invalidate()
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    observers.set(root, observer)
  }
  const flushMutations = (): void => {
    for (const observer of observers.values()) {
      if (
        observer.takeRecords().some((mutation) => {
          return !mutationIsOurs(mutation)
        })
      )
        invalidate()
    }
    if (snapshot && snapshot.url !== document.URL) invalidate()
  }
  observe(document)
  const recordLog = (line: string): void => {
    logs.push(`${new Date().toISOString()} ${line.slice(0, 4000)}`)
    if (logs.length > 500) logs.splice(0, logs.length - 500)
  }
  const formatLogValue = (value: unknown): string => {
    if (typeof value === 'string') return value
    try {
      return JSON.stringify(value)?.slice(0, 4000) ?? String(value)
    } catch {
      return '[unserializable value]'
    }
  }
  const onError = (event: ErrorEvent): void => {
    recordLog(`[error] ${event.message} ${event.filename}:${event.lineno}:${event.colno}`)
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    recordLog(`[unhandledrejection] ${formatLogValue(event.reason)}`)
  }
  view.addEventListener('error', onError)
  view.addEventListener('unhandledrejection', onRejection)
  view.addEventListener('pagehide', invalidate)
  view.addEventListener('popstate', invalidate)
  view.addEventListener('hashchange', invalidate)
  cleanups.push(() => {
    view.removeEventListener('error', onError)
    view.removeEventListener('unhandledrejection', onRejection)
    view.removeEventListener('pagehide', invalidate)
    view.removeEventListener('popstate', invalidate)
    view.removeEventListener('hashchange', invalidate)
  })
  const pageView = (view as Window & { wrappedJSObject?: Window & typeof globalThis }).wrappedJSObject
  if (pageView && typeof exportFunction === 'function') {
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      try {
        const original = pageView.console[method]
        const wrapped = exportFunction((...args: unknown[]) => {
          try {
            recordLog(`[console.${method}] ${args.map(formatLogValue).join(' ')}`)
          } catch {
            /* Logging must not interrupt the page. */
          }
          return original.apply(pageView.console, args)
        }, pageView.console)
        pageView.console[method] = wrapped
        consoleAvailable = true
        cleanups.push(() => {
          if (pageView.console[method] === wrapped) pageView.console[method] = original
        })
      } catch {
        /* Firefox restricts access on privileged pages; report the missing bridge in logs. */
      }
    }
  }
  const pause = async (options: { execution: Execution; delay?: number }): Promise<void> => {
    checkActive(options.execution)
    const delay = Math.min(options.delay ?? 40, Math.max(0, options.execution.deadline - Date.now()))
    await new Promise<void>((resolve) => {
      const done = (): void => {
        view.clearTimeout(timer)
        options.execution.signal.removeEventListener('abort', done)
        resolve()
      }
      const timer = view.setTimeout(done, delay)
      options.execution.signal.addEventListener('abort', done, { once: true })
    })
    checkActive(options.execution)
  }
  const startAction = (execution: Execution): void => {
    checkActive(execution)
    execution.started = true
    invalidate()
  }
  const resolveRef = (options: { selector: string; snapshotId?: string }): Element[] | null => {
    const selector = options.selector.trim()
    const ref = selector.startsWith('@')
      ? selector.slice(1)
      : selector.startsWith('aria-ref=')
        ? selector.slice(9)
        : null
    if (ref === null) return null
    flushMutations()
    const entry = snapshot?.refs.get(ref)
    let currentDocument: Document | undefined
    try {
      currentDocument = entry?.element.ownerDocument.defaultView?.document
    } catch {
      /* A frame may have navigated to another origin since the snapshot. */
    }
    if (
      !options.snapshotId ||
      !snapshot ||
      snapshot.id !== options.snapshotId ||
      !entry ||
      !entry.element.isConnected ||
      currentDocument !== entry.element.ownerDocument
    ) {
      throw new FirefoxDomError({
        code: 'stale-snapshot',
        message: `Snapshot ref ${selector} is missing or stale. Take a fresh snapshot and pass its snapshotId with a ref shown in that snapshot.`,
      })
    }
    return [entry.element]
  }
  const locate = (options: { selector: string; snapshotId?: string }): Element[] => {
    return resolveRef(options) ?? resolveLocator({ root: document, locator: locatorForSelector(options.selector) })
  }
  const resolveProgram = (locator: BrowserDomLocator): Element[] => {
    const first = locator.steps[0]
    if (first?.kind === 'selector' && first.engine === 'css') {
      const refs = resolveRef({ selector: first.value, snapshotId: locator.snapshotId })
      if (refs) return resolveLocator({ root: document, locator: { steps: locator.steps.slice(1) }, elements: refs })
    }
    return resolveLocator({ root: document, locator })
  }
  const takeSnapshot = (command: Extract<BrowserDomCommand, { method: 'snapshot' }>): BrowserResultData => {
    flushMutations()
    const roots = command.selector
      ? [strictElement(locate({ selector: command.selector }))]
      : [document.body ?? document.documentElement]
    const lines: Array<{ text: string; ref?: SnapshotRef }> = []
    const visited = new Set<Node>()
    let count = 0
    const visit = (options: { node: Node; depth: number }): void => {
      if (visited.has(options.node) || lines.length >= MAX_SNAPSHOT_LINES || count >= 20000) return
      visited.add(options.node)
      count += 1
      if (options.node.nodeType === 3) {
        const text = normalizeText(options.node.textContent ?? '')
        if (text && (!command.interactiveOnly || command.full))
          lines.push({
            text: `${'  '.repeat(Math.min(options.depth, 16))}- text: ${JSON.stringify(text.slice(0, 2000))}`,
          })
        return
      }
      if (options.node.nodeType !== 1) return
      const element = options.node as Element
      if (
        overlayNodes.has(element) ||
        !ariaVisible(element) ||
        ['script', 'style', 'noscript', 'template', 'head'].includes(element.localName)
      )
        return
      const role = elementRole(element)
      const name = accessibleName(element).slice(0, 2000)
      let depth = options.depth
      if (
        role &&
        role !== 'none' &&
        role !== 'presentation' &&
        (!command.interactiveOnly || command.full || INTERACTIVE_ROLES.has(role))
      ) {
        const ref = `e${lines.length + 1}`
        const entry = { ref, role, name, element }
        const states: string[] = []
        if (isDisabled(element)) states.push('disabled')
        if (element.getAttribute('aria-expanded') !== null)
          states.push(`expanded=${element.getAttribute('aria-expanded')}`)
        if (element.getAttribute('aria-checked') !== null)
          states.push(`checked=${element.getAttribute('aria-checked')}`)
        else if (element.matches('input[type=checkbox],input[type=radio]'))
          states.push(`checked=${(element as HTMLInputElement).checked}`)
        if (
          (element.localName === 'input' && (element as HTMLInputElement).type !== 'password') ||
          element.localName === 'textarea'
        )
          states.push(`value=${JSON.stringify((element as HTMLInputElement).value.slice(0, 2000))}`)
        lines.push({
          text: `${'  '.repeat(Math.min(depth, 16))}- ${role}${name ? ` ${JSON.stringify(name.slice(0, 2000))}` : ''} [ref=${ref}]${states
            .map((state) => {
              return ` [${state}]`
            })
            .join('')}`,
          ref: entry,
        })
        depth += 1
      }
      if (element.shadowRoot) {
        observe(element.shadowRoot)
        for (const child of element.shadowRoot.childNodes) visit({ node: child, depth })
      } else if (element.localName === 'slot' && (element as HTMLSlotElement).assignedNodes().length) {
        for (const child of (element as HTMLSlotElement).assignedNodes({ flatten: true })) visit({ node: child, depth })
      } else {
        for (const child of element.childNodes) visit({ node: child, depth })
      }
      if (element.localName === 'iframe' || element.localName === 'frame') {
        let childDocument: Document | null = null
        try {
          childDocument = (element as HTMLIFrameElement).contentDocument
        } catch {
          /* Cross-origin documents are not exposed to this content world. */
        }
        if (childDocument?.documentElement) {
          observe(childDocument)
          visit({ node: childDocument.documentElement, depth: depth + 1 })
        } else
          lines.push({
            text: `${'  '.repeat(Math.min(depth, 16))}- iframe [cross-origin or sandboxed content unavailable]`,
          })
      }
    }
    for (const root of roots) visit({ node: root, depth: 0 })
    const selected = command.search
      ? lines.filter((line) => {
          return line.text.toLowerCase().includes(command.search!.toLowerCase())
        })
      : lines
    const refs = new Map<string, SnapshotRef>()
    const output: string[] = []
    let chars = 0
    for (const line of selected) {
      if (chars + line.text.length > MAX_SNAPSHOT_CHARS) break
      output.push(line.text)
      chars += line.text.length + 1
      if (line.ref) refs.set(line.ref.ref, line.ref)
    }
    if (count >= 20000 || lines.length >= MAX_SNAPSHOT_LINES || output.length < selected.length)
      output.push('[Snapshot truncated; narrow selector/search to inspect additional content.]')
    snapshot = { id: `firefox:${documentId}:${view.crypto.randomUUID()}`, refs, url: document.URL }
    return {
      text: output.join('\n') || '(No matching accessible content.)',
      snapshotId: snapshot.id,
      value: {
        refs: [...refs.values()].map((entry) => {
          return { ref: entry.ref, role: entry.role, name: entry.name }
        }),
        snapshotMode: 'dom-aria',
      },
    }
  }
  const prepareScreenshot = (
    command: Extract<BrowserDomCommand, { method: 'screenshot.prepare' }>,
  ): BrowserResultData => {
    overlay?.remove()
    overlay = undefined
    const width = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0, view.innerWidth)
    const height = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0, view.innerHeight)
    const result = command.labels ? takeSnapshot({ method: 'snapshot', interactiveOnly: true }) : {}
    if (command.labels && snapshot) {
      overlay = document.createElement('div')
      overlayNodes.add(overlay)
      overlay.setAttribute('aria-hidden', 'true')
      overlay.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;'
      for (const entry of snapshot.refs.values()) {
        const rect = entry.element.getBoundingClientRect()
        if (entry.element.ownerDocument !== document || rect.width <= 0 || rect.height <= 0) continue
        if (
          !command.fullPage &&
          (rect.bottom < 0 || rect.top > view.innerHeight || rect.right < 0 || rect.left > view.innerWidth)
        )
          continue
        const label = document.createElement('span')
        overlayNodes.add(label)
        label.textContent = entry.ref
        label.style.cssText = `position:absolute;left:${Math.max(0, rect.left + view.scrollX)}px;top:${Math.max(0, rect.top + view.scrollY)}px;background:#ffe500;color:#111;font:700 12px/16px monospace;border:1px solid #111;border-radius:2px;padding:0 2px;white-space:nowrap;pointer-events:none;`
        overlay.append(label)
      }
      document.documentElement.append(overlay)
    }
    return {
      ...result,
      value: {
        width,
        height,
        viewportWidth: view.innerWidth,
        viewportHeight: view.innerHeight,
        scrollX: view.scrollX,
        scrollY: view.scrollY,
        devicePixelRatio: view.devicePixelRatio,
      },
    }
  }

  const waitElement = async (options: {
    execution: Execution
    resolve: () => Element[]
    actionable?: boolean
    editable?: boolean
    enabled?: boolean
    retargetControl?: boolean
    force?: boolean
  }): Promise<Element> => {
    let lastError: unknown
    while (true) {
      checkActive(options.execution)
      const elements = options.resolve()
      if (elements.length > 1) return strictElement(elements)
      if (elements.length === 1) {
        try {
          if (options.actionable)
            assertActionable({
              element: options.retargetControl ? controlForElement(elements[0]) : elements[0],
              editable: options.editable,
              enabled: options.enabled,
              force: options.force,
            })
          return elements[0]
        } catch (error) {
          lastError = error
        }
      }
      try {
        await pause({ execution: options.execution })
      } catch (error) {
        if (lastError instanceof Error && !options.execution.signal.aborted)
          throw new FirefoxDomError({ code: 'timeout', message: lastError.message })
        throw error
      }
    }
  }
  const performLocator = async (options: {
    execution: Execution
    locator: BrowserDomLocator
    action: BrowserDomLocatorAction
    args: BrowserJson[]
    resolve?: () => Element[]
    prepareOnly?: boolean
    expectedPoint?: FramePoint
    preparationId?: string
  }): Promise<BrowserResultData> => {
    const { action, args, execution } = options
    const signature = JSON.stringify({ locator: options.locator, action, args })
    let prepared: PreparedAction | undefined
    if (options.preparationId) {
      prepared = preparations.get(options.preparationId)
      preparations.delete(options.preparationId)
      if (
        !prepared ||
        prepared.expiresAt <= Date.now() ||
        prepared.requestId !== execution.request.requestId ||
        prepared.signature !== signature ||
        !options.expectedPoint ||
        options.expectedPoint.x !== prepared.point.x ||
        options.expectedPoint.y !== prepared.point.y
      ) {
        throw new FirefoxDomError({
          message: 'The prepared Firefox frame action is expired, stale, or belongs to another request.',
        })
      }
    }
    if (options.expectedPoint && !prepared)
      throw new FirefoxDomError({
        code: 'invalid-request',
        message: 'A checked frame action point requires its preparationId.',
      })
    if (options.prepareOnly && READ_ACTIONS.has(action))
      throw new FirefoxDomError({
        code: 'invalid-request',
        message: 'Frame action preparation requires an input or focus action.',
      })
    const first = options.locator.steps[0]
    const referenceProgram =
      first?.kind === 'selector' &&
      first.engine === 'css' &&
      (first.value.startsWith('@') || first.value.startsWith('aria-ref='))
    const resolve =
      options.resolve ??
      (() => {
        if (prepared && referenceProgram) return [prepared.element]
        return resolveProgram(options.locator)
      })
    if (action === 'count') return { value: resolve().length }
    if (action === 'allTextContents' || action === 'allInnerTexts')
      return {
        value: resolve().map((element) => {
          return action === 'allTextContents'
            ? (element.textContent ?? '')
            : ((element as HTMLElement).innerText ?? element.textContent ?? '')
        }),
      }
    if (action === 'isVisible' || action === 'isHidden') {
      const elements = resolve()
      const visible = elements.length > 0 && isVisible(strictElement(elements))
      return { value: action === 'isVisible' ? visible : !visible }
    }
    if (action === 'waitFor') {
      const value = args[0]
      if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)))
        throw new FirefoxDomError({ code: 'invalid-request', message: 'waitFor options must be an object.' })
      const object = value as { [key: string]: BrowserJson } | undefined
      const state = object?.state ?? 'visible'
      if (!['attached', 'detached', 'visible', 'hidden'].includes(String(state)))
        throw new FirefoxDomError({
          code: 'invalid-request',
          message: 'waitFor state must be attached, detached, visible, or hidden.',
        })
      if (typeof object?.timeout === 'number' && object.timeout > 0)
        execution.deadline = Math.min(execution.deadline, Date.now() + object.timeout)
      while (true) {
        checkActive(execution)
        const elements = resolve()
        const element = elements.length ? strictElement(elements) : undefined
        const visible = element !== undefined && isVisible(element)
        if (
          (state === 'attached' && element) ||
          (state === 'detached' && !element) ||
          (state === 'visible' && visible) ||
          (state === 'hidden' && !visible)
        )
          return { value: null }
        await pause({ execution })
      }
    }
    const optionIndex = ['fill', 'type', 'press', 'setChecked', 'selectOption', 'getAttribute'].includes(action) ? 1 : 0
    const settings = actionOptions({ args, index: optionIndex })
    if (settings.timeout && settings.timeout > 0)
      execution.deadline = Math.min(execution.deadline, Date.now() + settings.timeout)
    const mutating = !READ_ACTIONS.has(action)
    const retargetControl = !['click', 'dblclick', 'hover', 'scrollIntoViewIfNeeded'].includes(action)
    const requiresEnabled = !['hover', 'scrollIntoViewIfNeeded', 'focus', 'blur'].includes(action)
    const element = await waitElement({
      execution,
      resolve,
      actionable: mutating && action !== 'blur',
      editable: action === 'fill' || action === 'type',
      enabled: requiresEnabled,
      retargetControl,
      force: settings.force,
    })
    const control = controlForElement(element)
    const actionElement = retargetControl ? control : element
    if (
      prepared &&
      (prepared.element !== element ||
        prepared.actionElement !== actionElement ||
        !element.isConnected ||
        element.ownerDocument !== document)
    )
      throw new FirefoxDomError({ message: 'The prepared frame action no longer identifies the same live element.' })
    if (action === 'textContent') return { value: element.textContent }
    if (action === 'innerText') return { value: (element as HTMLElement).innerText ?? element.textContent ?? '' }
    if (action === 'innerHTML') return { value: element.innerHTML }
    if (action === 'getAttribute') return { value: element.getAttribute(stringArg({ args, name: 'Attribute name' })) }
    if (action === 'inputValue') {
      if (!['input', 'textarea', 'select'].includes(control.localName))
        throw new FirefoxDomError({ message: 'inputValue requires an input, textarea, or select.' })
      return { value: (control as HTMLInputElement).value }
    }
    if (action === 'isEnabled') return { value: !isDisabled(control) }
    if (action === 'isDisabled') return { value: isDisabled(control) }
    if (action === 'isEditable') return { value: isEditable(control) }
    if (action === 'isChecked') return { value: checkedState(control) }
    if (action === 'boundingBox') {
      if (!isVisible(element)) return { value: null }
      const rect = element.getBoundingClientRect()
      return { value: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
    }
    startAction(execution)
    if (!['focus', 'blur'].includes(action)) {
      actionElement.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
      checkActive(execution)
      if (!settings.force && ['click', 'dblclick', 'check', 'uncheck', 'setChecked', 'hover'].includes(action)) {
        let previous = actionElement.getBoundingClientRect()
        while (true) {
          await pause({ execution, delay: 20 })
          const current = actionElement.getBoundingClientRect()
          if (
            current.x === previous.x &&
            current.y === previous.y &&
            current.width === previous.width &&
            current.height === previous.height
          )
            break
          previous = current
        }
      }
      assertActionable({
        element: actionElement,
        editable: action === 'fill' || action === 'type',
        enabled: requiresEnabled,
        receivesEvents: ['click', 'dblclick', 'check', 'uncheck', 'setChecked', 'hover'].includes(action),
        force: settings.force,
      })
    }
    const point =
      options.prepareOnly ||
      prepared ||
      ['click', 'dblclick', 'check', 'uncheck', 'setChecked', 'hover'].includes(action)
        ? elementActionPoint(actionElement)
        : undefined
    if (prepared && (!point || point.x !== prepared.point.x || point.y !== prepared.point.y))
      throw new FirefoxDomError({
        message: 'The prepared Firefox frame action point moved before dispatch; take a fresh action preparation.',
      })
    if (options.prepareOnly) {
      if (!point) throw new FirefoxDomError({ message: 'The Firefox frame action has no visible input point.' })
      const preparationId = view.crypto.randomUUID()
      for (const [id, record] of preparations) {
        if (record.expiresAt <= Date.now()) preparations.delete(id)
      }
      if (preparations.size >= 32) preparations.delete(preparations.keys().next().value!)
      preparations.set(preparationId, {
        element,
        actionElement,
        requestId: execution.request.requestId,
        signature,
        point,
        expiresAt: Date.now() + 5000,
      })
      return { value: { point: { x: point.x, y: point.y }, preparationId } }
    }
    if (settings.trial) return { text: 'DOM actionability checks passed.', value: null }
    if (action === 'click' || action === 'dblclick') clickElement({ element, double: action === 'dblclick', point })
    else if (action === 'fill') fillElement({ element: control, value: stringArg({ args, name: 'Fill value' }) })
    else if (action === 'press') pressKey({ element: control, key: stringArg({ args, name: 'Key' }) })
    else if (action === 'type') {
      focusElement(control)
      for (const key of stringArg({ args, name: 'Text' })) {
        checkActive(execution)
        pressKey({ element: control, key })
        if (settings.delay) await pause({ execution, delay: settings.delay })
      }
    } else if (action === 'check' || action === 'uncheck' || action === 'setChecked') {
      if (action === 'setChecked' && typeof args[0] !== 'boolean')
        throw new FirefoxDomError({ code: 'invalid-request', message: 'setChecked requires a boolean.' })
      setChecked({
        element: control,
        checked: action === 'setChecked' ? (args[0] as boolean) : action === 'check',
        point,
      })
    } else if (action === 'selectOption') {
      const values = args[0] === null ? [] : Array.isArray(args[0]) ? args[0] : [args[0]]
      const parsed = values.map((value) => {
        if (typeof value === 'string') return value
        if (
          value === null ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !Object.keys(value).length ||
          Object.keys(value).some((key) => {
            return !['value', 'label', 'index'].includes(key)
          })
        )
          throw new FirefoxDomError({
            code: 'invalid-request',
            message: 'selectOption expects strings or objects with value, label, or index.',
          })
        if (
          (value.value !== undefined && typeof value.value !== 'string') ||
          (value.label !== undefined && typeof value.label !== 'string') ||
          (value.index !== undefined &&
            (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0))
        )
          throw new FirefoxDomError({ code: 'invalid-request', message: 'Invalid selectOption descriptor.' })
        return value as { value?: string; label?: string; index?: number }
      })
      return { value: selectOptions({ element: control, values: parsed }) }
    } else if (action === 'hover') hoverElement({ element, point })
    else if (action === 'focus') focusElement(control)
    else if (action === 'blur') (control as HTMLElement).blur()
    else if (action !== 'scrollIntoViewIfNeeded')
      throw new FirefoxDomError({
        code: 'unsupported-capability',
        message: `Unknown Firefox DOM locator action ${String(action)}.`,
      })
    return { text: `Completed ${action} using DOM input.`, value: null }
  }
  const execute = async (options: {
    execution: Execution
    evaluator?: Evaluator
    frameIdForElement?: (element: Element) => number
  }): Promise<BrowserResultData> => {
    const { execution, evaluator } = options
    const command = execution.request.command
    if (command.method === 'frame.check') {
      if (!options.frameIdForElement)
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message: 'Parent frame checks require the trusted Firefox extension world.',
        })
      const frame = await waitElement({
        execution,
        resolve: () => {
          return resolveProgram(command.locator)
        },
      })
      if (!['iframe', 'frame'].includes(frame.localName))
        throw new FirefoxDomError({ message: 'The frame selector does not refer to an iframe or frame element.' })
      const frameId = options.frameIdForElement(frame)
      if (!Number.isInteger(frameId) || frameId <= 0)
        throw new FirefoxDomError({
          code: 'resource-not-found',
          message: 'The ancestor iframe no longer has a live Firefox frame identity.',
        })
      const point = checkFramePoint({ frame, point: command.point })
      return { value: { frameId, x: point.x, y: point.y } }
    }
    if (command.method === 'frame.actionPoint') {
      if (!options.frameIdForElement)
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message: 'Frame action preparation requires the trusted Firefox extension world.',
        })
      return performLocator({
        execution,
        locator: command.locator,
        action: command.action,
        args: command.args ?? [],
        prepareOnly: true,
      })
    }
    if (command.method === 'frame.resolve') {
      if (!options.frameIdForElement)
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message:
            'Frame routing requires the trusted Firefox extension world; evaluate cannot resolve browser frame identities.',
        })
      const frame = await waitElement({
        execution,
        resolve: () => {
          return resolveProgram(command.locator)
        },
      })
      if (!['iframe', 'frame'].includes(frame.localName))
        throw new FirefoxDomError({ message: 'The frame selector does not refer to an iframe or frame element.' })
      const frameId = options.frameIdForElement(frame)
      if (!Number.isInteger(frameId) || frameId <= 0)
        throw new FirefoxDomError({
          code: 'resource-not-found',
          message: 'Firefox could not resolve a live child frame for this element.',
        })
      return { value: { frameId } }
    }
    if (command.method === 'snapshot') return takeSnapshot(command)
    if (command.method === 'screenshot.prepare') return prepareScreenshot(command)
    if (command.method === 'screenshot.cleanup') {
      overlay?.remove()
      overlay = undefined
      return { value: null }
    }
    if (command.method === 'invalidate') {
      invalidate()
      return { value: null }
    }
    if (command.method === 'dispose') {
      disposed = true
      invalidate()
      overlay?.remove()
      for (const observer of observers.values()) observer.disconnect()
      for (const cleanup of cleanups) cleanup()
      for (const [requestId, controller] of active) {
        if (requestId !== execution.request.requestId) controller.abort()
      }
      logs.length = 0
      return { value: null }
    }
    if (command.method === 'logs') {
      if (command.limit !== undefined && (!Number.isInteger(command.limit) || command.limit < 1 || command.limit > 500))
        throw new FirefoxDomError({ code: 'invalid-request', message: 'logs limit must be between 1 and 500.' })
      return {
        logs: logs.slice(-(command.limit ?? 100)),
        text: consoleAvailable
          ? 'Console/error logs captured since this document was attached; earlier logs are unavailable.'
          : 'Error/rejection logs captured since attach. The Firefox page console bridge is unavailable in this document; page console output is incomplete.',
      }
    }
    if (command.method === 'page') {
      if (command.action === 'title') return { value: document.title }
      if (command.action === 'readyState') return { value: document.readyState }
      if (command.action === 'url') return { value: document.URL }
      if (command.action === 'content')
        return {
          value: `${document.doctype ? new view.XMLSerializer().serializeToString(document.doctype) : ''}${document.documentElement.outerHTML}`,
        }
      throw new FirefoxDomError({ code: 'invalid-request', message: 'Unknown page read action.' })
    }
    if (command.method === 'evaluate') {
      if (!evaluator)
        throw new FirefoxDomError({
          code: 'invalid-request',
          message: 'The extension must supply a compiled evaluator; the DOM driver does not evaluate code strings.',
        })
      const first = command.locator?.steps[0]
      if (
        first?.kind === 'selector' &&
        first.engine === 'css' &&
        (first.value.startsWith('@') || first.value.startsWith('aria-ref='))
      ) {
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message:
            'Snapshot refs are bound to the trusted DOM world and cannot be passed to the separate evaluation world. Use a strict CSS or role locator for evaluate.',
        })
      }
      const element = command.locator
        ? await waitElement({
            execution,
            resolve: () => {
              return resolveProgram(command.locator!)
            },
          })
        : undefined
      startAction(execution)
      try {
        return {
          value: browserJson(await evaluator(element)),
          text: 'Evaluated in the Firefox isolated USER_SCRIPT world without extension APIs.',
        }
      } finally {
        invalidate()
      }
    }
    if (command.method === 'locator')
      return performLocator({
        execution,
        locator: command.locator,
        action: command.action,
        args: command.args ?? [],
        expectedPoint: command.expectedPoint,
        preparationId: command.preparationId,
      })
    if (command.method === 'click' || command.method === 'fill') {
      const selector = command.selector
      return performLocator({
        execution,
        locator: locatorForSelector('html'),
        action: command.method,
        args: command.method === 'fill' ? [command.value] : [],
        resolve: () => {
          return locate({ selector, snapshotId: command.snapshotId })
        },
      })
    }
    if (command.method === 'operation')
      throw new FirefoxDomError({
        code: 'unsupported-capability',
        message: `${command.operation.kind} must be routed through the Firefox extension resource manager.`,
      })
    throw new FirefoxDomError({ code: 'invalid-request', message: 'Unknown Firefox DOM command.' })
  }
  return {
    version: 1,
    get disposed() {
      return disposed
    },
    cancel(requestId) {
      cancelled.add(requestId)
      if (cancelled.size > 500) cancelled.delete(cancelled.values().next().value!)
      active.get(requestId)?.abort()
    },
    async run(request, evaluator, frameIdForElement) {
      const execution: Execution = {
        request,
        started: false,
        deadline: Date.now() + Math.min(5000, request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 5000),
        signal: new AbortController().signal,
      }
      let registered = false
      try {
        if (disposed)
          throw new FirefoxDomError({
            code: 'resource-released',
            message: 'This Firefox DOM driver was disposed; attach the tab before using it.',
          })
        if (
          ![request.requestId, request.sessionId, request.tabId, request.browserEpoch].every((id) => {
            return typeof id === 'string' && id.length > 0 && id.length <= 512
          })
        )
          throw new FirefoxDomError({
            code: 'invalid-request',
            message: 'A Firefox DOM request requires explicit request/session/tab/epoch identities.',
          })
        if (
          binding &&
          (binding.sessionId !== request.sessionId ||
            binding.tabId !== request.tabId ||
            binding.browserEpoch !== request.browserEpoch)
        )
          throw new FirefoxDomError({
            code: 'ownership-mismatch',
            message: 'This document is bound to another managed tab, session, or browser epoch.',
          })
        if (cancelled.has(request.requestId))
          throw new FirefoxDomError({ code: 'cancelled', message: 'This request was cancelled before DOM execution.' })
        if (active.has(request.requestId))
          throw new FirefoxDomError({
            code: 'invalid-request',
            message: 'Duplicate Firefox DOM requestId is already active.',
          })
        binding ??= { sessionId: request.sessionId, tabId: request.tabId, browserEpoch: request.browserEpoch }
        const controller = new AbortController()
        execution.signal = controller.signal
        active.set(request.requestId, controller)
        registered = true
        flushMutations()
        checkActive(execution)
        const data = await execute({ execution, evaluator, frameIdForElement })
        checkActive(execution)
        if (data.value !== undefined) data.value = browserJson(data.value)
        return {
          requestId: request.requestId,
          ok: true,
          data: { ...data, pageInfo: { tabId: request.tabId, url: document.URL, title: document.title } },
        }
      } catch (error) {
        return {
          requestId: request.requestId,
          ok: false,
          error: {
            code: error instanceof FirefoxDomError ? error.code : 'execution-failed',
            message: error instanceof Error ? error.message : String(error),
            outcome: execution.started ? 'unknown' : 'not-started',
          },
        }
      } finally {
        if (registered) active.delete(request.requestId)
      }
    },
  }
}

if (typeof document !== 'undefined' && (!globalThis.__piFirefoxDom || globalThis.__piFirefoxDom.disposed))
  globalThis.__piFirefoxDom = createFirefoxDomDriver(document)
