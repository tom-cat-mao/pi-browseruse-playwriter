import { computeAccessibleName, getRole, isInaccessible } from 'dom-accessibility-api'
import type { BrowserDomLocator, BrowserDomLocatorStep, BrowserErrorCode } from 'playwriter/browser-protocol'

export class FirefoxDomError extends Error {
  readonly code: BrowserErrorCode

  constructor(options: { code?: BrowserErrorCode; message: string }) {
    super(options.message)
    this.code = options.code ?? 'execution-failed'
  }
}

export type QueryRoot = Document | ShadowRoot | Element

export function normalizeText(value: string): string {
  return value
    .replace(/[\u200b\u00ad]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function textMatches(options: { actual: string; expected: string; exact?: boolean }): boolean {
  const actual = normalizeText(options.actual)
  const expected = normalizeText(options.expected)
  return options.exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase())
}

export function accessibleName(element: Element): string {
  return computeAccessibleName(element, { computedStyleSupportsPseudoElements: false })
}

export function elementRole(element: Element): string | null {
  return getRole(element)
}

export function composedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root.nodeType === 11 && 'host' in root ? (root as ShadowRoot).host : null
}

export function isDisabled(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.getAttribute('aria-disabled') === 'true' || current.hasAttribute('inert')) return true
  }
  return element.matches(':disabled')
}

export function isEditable(element: Element): boolean {
  if (isDisabled(element) || element.getAttribute('aria-readonly') === 'true') return false
  if (element.localName === 'input' || element.localName === 'textarea') {
    if (element.hasAttribute('readonly')) return false
    return (
      element.localName === 'textarea' ||
      !new Set(['checkbox', 'radio', 'file', 'button', 'submit', 'reset', 'image', 'hidden', 'range', 'color']).has(
        (element as HTMLInputElement).type,
      )
    )
  }
  for (let current: Element | null = element; current; current = composedParent(current)) {
    const editable = current.getAttribute('contenteditable')
    if (editable !== null) return editable === '' || editable === 'true' || editable === 'plaintext-only'
  }
  return false
}

export function isVisible(element: Element): boolean {
  if (!element.isConnected) return false
  for (let current: Element | null = element; current; current = composedParent(current)) {
    const style = current.ownerDocument.defaultView?.getComputedStyle(current)
    if (style?.display === 'none' || style?.visibility === 'hidden' || style?.visibility === 'collapse') return false
  }
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

export function ariaVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (isInaccessible(current) || current.hasAttribute('inert')) return false
  }
  return true
}

export function allElements(root: QueryRoot): Element[] {
  const result: Element[] = []
  const visit = (current: QueryRoot): void => {
    for (const element of current.querySelectorAll('*')) {
      result.push(element)
      if (element.shadowRoot) visit(element.shadowRoot)
    }
  }
  visit(root)
  return result
}

export function elementText(element: Element): string {
  if (['script', 'style', 'noscript', 'template'].includes(element.localName)) return ''
  if (element.localName === 'input' && ['submit', 'button', 'reset'].includes((element as HTMLInputElement).type)) {
    return (element as HTMLInputElement).value
  }
  const parts: string[] = []
  for (const child of element.childNodes) {
    if (child.nodeType === 3) parts.push(child.textContent ?? '')
    if (child.nodeType === 1) parts.push(elementText(child as Element))
  }
  if (element.shadowRoot) {
    for (const child of element.shadowRoot.children) parts.push(elementText(child))
  }
  return normalizeText(parts.join(' '))
}

function labelTexts(element: Element): string[] {
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy) {
    const root = element.getRootNode() as Document | ShadowRoot
    const text = labelledBy
      .split(/\s+/)
      .map((id) => {
        return root.getElementById(id)?.textContent ?? ''
      })
      .join(' ')
    if (text) return [text]
  }
  const ariaLabel = element.getAttribute('aria-label')
  if (ariaLabel) return [ariaLabel]
  if ('labels' in element) {
    const labels = (element as HTMLInputElement).labels
    if (labels)
      return Array.from(labels).map((label) => {
        return elementText(label)
      })
  }
  return []
}

function roleStateMatches(options: {
  element: Element
  step: Extract<BrowserDomLocatorStep, { kind: 'selector' }>
}): boolean {
  const { element, step } = options
  const states = step.options
  if (!states) return true
  if (states.disabled !== undefined && isDisabled(element) !== states.disabled) return false
  if (states.level !== undefined) {
    const level = Number(
      element.getAttribute('aria-level') ?? (/^h[1-6]$/.test(element.localName) ? element.localName.slice(1) : '0'),
    )
    if (level !== states.level) return false
  }
  for (const name of ['checked', 'selected', 'expanded', 'pressed'] as const) {
    const expected = states[name]
    if (expected === undefined) continue
    const attr = element.getAttribute(`aria-${name}`)
    let actual: boolean | undefined
    if (attr === 'true' || attr === 'false') actual = attr === 'true'
    else if (attr === null && name === 'checked' && element.matches('input[type=checkbox],input[type=radio]'))
      actual = (element as HTMLInputElement).checked
    else if (attr === null && name === 'selected' && element.localName === 'option')
      actual = (element as HTMLOptionElement).selected
    else if (
      attr === null &&
      name === 'expanded' &&
      element.localName === 'summary' &&
      element.parentElement?.localName === 'details'
    )
      actual = element.parentElement.hasAttribute('open')
    if (actual !== expected) return false
  }
  return true
}

function selectElements(options: {
  root: QueryRoot
  step: Extract<BrowserDomLocatorStep, { kind: 'selector' }>
}): Element[] {
  const { root, step } = options
  const elements = allElements(root)
  if (step.engine === 'css') {
    const results = new Set<Element>()
    const query = (scope: QueryRoot): void => {
      for (const element of scope.querySelectorAll(step.value)) results.add(element)
    }
    try {
      query(root)
      for (const element of elements) {
        if (element.shadowRoot) query(element.shadowRoot)
      }
    } catch (error) {
      throw new FirefoxDomError({
        code: 'invalid-request',
        message: `Invalid CSS selector ${JSON.stringify(step.value)}: ${String(error)}`,
      })
    }
    return [...results]
  }
  const matches = (element: Element): boolean => {
    if (step.engine === 'role') {
      if (elementRole(element) !== step.value || (!step.options?.includeHidden && !ariaVisible(element))) return false
      if (
        step.name !== undefined &&
        !textMatches({ actual: accessibleName(element), expected: step.name, exact: step.exact })
      )
        return false
      return roleStateMatches({ element, step })
    }
    if (step.engine === 'text')
      return textMatches({ actual: elementText(element), expected: step.value, exact: step.exact })
    if (step.engine === 'label')
      return labelTexts(element).some((text) => {
        return textMatches({ actual: text, expected: step.value, exact: step.exact })
      })
    if (step.engine === 'css') return false
    const attr = { placeholder: 'placeholder', testId: 'data-testid', alt: 'alt', title: 'title' }[step.engine]
    const actual = element.getAttribute(attr)
    return (
      actual !== null &&
      textMatches({ actual, expected: step.value, exact: step.engine === 'testId' ? true : step.exact })
    )
  }
  return elements.filter((element) => {
    if (!matches(element)) return false
    if (step.engine !== 'text') return true
    const children = [...element.children, ...Array.from(element.shadowRoot?.children ?? [])]
    return !children.some((child) => {
      return matches(child)
    })
  })
}

export function locatorForSelector(selector: string): BrowserDomLocator {
  const css = selector.startsWith('css=') ? selector.slice(4) : selector
  if (!selector.startsWith('role=')) return { steps: [{ kind: 'selector', engine: 'css', value: css }] }
  const match = /^role=([\w-]+)(?:\[name=("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')(i|s)?\])?$/.exec(selector)
  if (!match)
    throw new FirefoxDomError({
      code: 'invalid-request',
      message: 'Unsupported role selector syntax; use role=button[name="Save"] or getByRole().',
    })
  const quoted = match[2]
  const name =
    quoted === undefined
      ? undefined
      : quoted.startsWith('"')
        ? (JSON.parse(quoted) as string)
        : quoted.slice(1, -1).replace(/\\(['\\])/g, '$1')
  return { steps: [{ kind: 'selector', engine: 'role', value: match[1], name, exact: match[3] !== 'i' }] }
}

export function resolveLocator(options: {
  root: QueryRoot
  locator: BrowserDomLocator
  elements?: Element[]
}): Element[] {
  let scopes: QueryRoot[] = options.elements ?? [options.root]
  let result: Element[] = options.elements ?? []
  for (const step of options.locator.steps) {
    if (step.kind === 'selector') {
      result = [
        ...new Set(
          scopes.flatMap((root) => {
            return selectElements({ root, step })
          }),
        ),
      ]
    } else if (step.kind === 'nth') {
      const index = step.index < 0 ? result.length + step.index : step.index
      result = result[index] ? [result[index]] : []
    } else if (step.kind === 'filter') {
      result = result.filter((element) => {
        const text = elementText(element)
        if (step.hasText !== undefined && !textMatches({ actual: text, expected: step.hasText })) return false
        if (step.hasNotText !== undefined && textMatches({ actual: text, expected: step.hasNotText })) return false
        if (step.has && resolveLocator({ root: element, locator: step.has }).length === 0) return false
        if (step.hasNot && resolveLocator({ root: element, locator: step.hasNot }).length !== 0) return false
        return true
      })
    } else {
      const frames = scopes.flatMap((root) => {
        return resolveLocator({ root, locator: locatorForSelector(step.selector) })
      })
      if (frames.length !== 1)
        throw new FirefoxDomError({ message: `Frame selector must match exactly one frame; matched ${frames.length}.` })
      const frame = frames[0]
      if (!['iframe', 'frame'].includes(frame.localName))
        throw new FirefoxDomError({ message: 'frameLocator selector does not refer to a frame.' })
      let document: Document | null = null
      try {
        document = (frame as HTMLIFrameElement).contentDocument
      } catch {
        /* Access is restricted by the frame origin. */
      }
      if (!document)
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message:
            'This Firefox DOM driver can enter same-origin frames. Cross-origin or sandboxed frames are inaccessible from the top document.',
        })
      scopes = [document]
      result = []
      continue
    }
    scopes = result
  }
  return result
}

export function strictElement(elements: Element[]): Element {
  if (elements.length !== 1)
    throw new FirefoxDomError({
      message: `Strict locator requires exactly one element; matched ${elements.length}. Refine the selector or use an explicit nth().`,
    })
  return elements[0]
}
