import { FirefoxDomError, composedParent, isDisabled, isEditable, isVisible } from './firefox-dom-locators'

export function controlForElement(element: Element): Element {
  return element.localName === 'label' ? ((element as HTMLLabelElement).control ?? element) : element
}

export function focusElement(element: Element): void {
  const target = element as HTMLElement | SVGElement
  if (typeof target.focus !== 'function')
    throw new FirefoxDomError({ message: 'The selected element cannot receive focus.' })
  target.focus({ preventScroll: true })
}

function composedContains(options: { ancestor: Element; element: Element }): boolean {
  for (let current: Element | null = options.element; current; current = composedParent(current)) {
    if (current === options.ancestor) return true
  }
  return false
}

export function assertActionable(options: {
  element: Element
  editable?: boolean
  receivesEvents?: boolean
  force?: boolean
}): void {
  const { element } = options
  if (!element.isConnected) throw new FirefoxDomError({ message: 'The selected element is detached.' })
  if (isDisabled(element))
    throw new FirefoxDomError({ message: 'The selected element is disabled or inside an inert subtree.' })
  if (options.editable && !isEditable(element))
    throw new FirefoxDomError({ message: 'The selected element is not editable.' })
  if (!options.force && !isVisible(element))
    throw new FirefoxDomError({ message: 'The selected element is not visible.' })
  if (!options.receivesEvents || options.force) return
  let target = element
  while (true) {
    const rect = target.getBoundingClientRect()
    const view = target.ownerDocument.defaultView
    if (!view) throw new FirefoxDomError({ message: 'The selected document has no active window.' })
    const left = Math.max(rect.left, 0)
    const top = Math.max(rect.top, 0)
    const right = Math.min(rect.right, view.innerWidth)
    const bottom = Math.min(rect.bottom, view.innerHeight)
    if (left >= right || top >= bottom)
      throw new FirefoxDomError({ message: 'The selected element is outside the viewport.' })
    const x = (left + right) / 2
    const y = (top + bottom) / 2
    let hit = target.ownerDocument.elementFromPoint(x, y)
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y)
      if (!inner || inner === hit) break
      hit = inner
    }
    if (
      !hit ||
      (!composedContains({ ancestor: target, element: hit }) && !composedContains({ ancestor: hit, element: target }))
    ) {
      throw new FirefoxDomError({
        message: `The selected element is covered by ${hit ? `<${hit.localName}>` : 'another surface'}.`,
      })
    }
    const frame = view.frameElement
    if (!frame) break
    target = frame
  }
}

function mouseEvent(options: { element: Element; name: string; detail?: number }): boolean {
  const { element, name } = options
  const view = element.ownerDocument.defaultView
  if (!view) throw new FirefoxDomError({ message: 'The document has no active window.' })
  const rect = element.getBoundingClientRect()
  const init: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view,
    detail: options.detail ?? 1,
    button: 0,
    buttons: name.endsWith('down') ? 1 : 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  }
  const event = name.startsWith('pointer')
    ? new view.PointerEvent(name, { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true })
    : new view.MouseEvent(name, init)
  return element.dispatchEvent(event)
}

export function clickElement(options: { element: Element; double?: boolean }): void {
  const { element } = options
  const count = options.double ? 2 : 1
  for (let i = 0; i < count; i += 1) {
    mouseEvent({ element, name: 'pointerover' })
    mouseEvent({ element, name: 'mouseover' })
    const pointerAllowed = mouseEvent({ element, name: 'pointerdown', detail: i + 1 })
    const mouseAllowed = pointerAllowed && mouseEvent({ element, name: 'mousedown', detail: i + 1 })
    if (mouseAllowed && typeof (element as HTMLElement).focus === 'function') focusElement(element)
    mouseEvent({ element, name: 'pointerup', detail: i + 1 })
    if (pointerAllowed) mouseEvent({ element, name: 'mouseup', detail: i + 1 })
    if (typeof (element as HTMLElement).click === 'function' && !options.double) (element as HTMLElement).click()
    else mouseEvent({ element, name: 'click', detail: i + 1 })
  }
  if (options.double) mouseEvent({ element, name: 'dblclick', detail: 2 })
}

export function hoverElement(element: Element): void {
  mouseEvent({ element, name: 'pointerover' })
  mouseEvent({ element, name: 'mouseover' })
  mouseEvent({ element, name: 'pointermove' })
  mouseEvent({ element, name: 'mousemove' })
}

function inputEvent(options: {
  element: Element
  name: 'beforeinput' | 'input'
  data: string | null
  inputType: string
}): boolean {
  const view = options.element.ownerDocument.defaultView
  if (!view) throw new FirefoxDomError({ message: 'The document has no active window.' })
  return options.element.dispatchEvent(
    new view.InputEvent(options.name, {
      bubbles: true,
      composed: true,
      cancelable: options.name === 'beforeinput',
      data: options.data,
      inputType: options.inputType,
    }),
  )
}

function setNativeValue(options: { element: HTMLInputElement | HTMLTextAreaElement; value: string }): void {
  const view = options.element.ownerDocument.defaultView
  const prototype =
    options.element.localName === 'textarea' ? view?.HTMLTextAreaElement.prototype : view?.HTMLInputElement.prototype
  const setter = prototype && Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  if (!setter) throw new FirefoxDomError({ message: 'The native input value setter is unavailable.' })
  setter.call(options.element, options.value)
}

export function fillElement(options: { element: Element; value: string }): void {
  const element = controlForElement(options.element)
  if (!isEditable(element))
    throw new FirefoxDomError({ message: 'fill requires an enabled input, textarea, or contenteditable element.' })
  focusElement(element)
  if (!inputEvent({ element, name: 'beforeinput', data: options.value, inputType: 'insertReplacementText' })) return
  if (element.localName === 'input' || element.localName === 'textarea') {
    setNativeValue({ element: element as HTMLInputElement, value: options.value })
    if ((element as HTMLInputElement).value !== options.value)
      throw new FirefoxDomError({
        message: 'The input rejected or sanitized the supplied value; use a value appropriate for its input type.',
      })
  } else {
    element.replaceChildren(element.ownerDocument.createTextNode(options.value))
    const selection = element.ownerDocument.getSelection()
    const range = element.ownerDocument.createRange()
    range.selectNodeContents(element)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
  inputEvent({ element, name: 'input', data: options.value, inputType: 'insertReplacementText' })
  const view = element.ownerDocument.defaultView
  if (view) element.dispatchEvent(new view.Event('change', { bubbles: true }))
}

export function checkedState(element: Element): boolean {
  const target = controlForElement(element)
  if (target.localName === 'input' && ['checkbox', 'radio'].includes((target as HTMLInputElement).type))
    return (target as HTMLInputElement).checked
  const checked = target.getAttribute('aria-checked')
  if (checked === 'true' || checked === 'false') return checked === 'true'
  throw new FirefoxDomError({ message: 'The selected element is not a checkbox or radio control.' })
}

export function setChecked(options: { element: Element; checked: boolean }): void {
  const element = controlForElement(options.element)
  if (checkedState(element) === options.checked) return
  if (element.localName === 'input' && (element as HTMLInputElement).type === 'radio' && !options.checked)
    throw new FirefoxDomError({ message: 'A radio button cannot be unchecked by clicking it.' })
  clickElement({ element })
  if (checkedState(element) !== options.checked)
    throw new FirefoxDomError({
      message:
        'The DOM click did not produce the requested checked state; this control may require native browser input.',
    })
}

export function selectOptions(options: {
  element: Element
  values: Array<string | { value?: string; label?: string; index?: number }>
}): string[] {
  const element = controlForElement(options.element)
  if (element.localName !== 'select') throw new FirefoxDomError({ message: 'selectOption requires a select element.' })
  const select = element as HTMLSelectElement
  const wanted = options.values.map((value) => {
    const option = Array.from(select.options).find((entry, index) => {
      if (typeof value === 'string') return entry.value === value
      return (
        (value.value === undefined || entry.value === value.value) &&
        (value.label === undefined || entry.label === value.label) &&
        (value.index === undefined || index === value.index)
      )
    })
    if (!option) throw new FirefoxDomError({ message: `No option matches ${JSON.stringify(value)}.` })
    if (isDisabled(option)) throw new FirefoxDomError({ message: 'The selected option is disabled.' })
    return option
  })
  if (!select.multiple && wanted.length > 1)
    throw new FirefoxDomError({ message: 'A single select cannot select multiple options.' })
  for (const option of select.options) option.selected = wanted.includes(option)
  if (wanted.length === 0) select.selectedIndex = -1
  const view = element.ownerDocument.defaultView
  if (view) {
    select.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }))
    select.dispatchEvent(new view.Event('change', { bubbles: true }))
  }
  return Array.from(select.selectedOptions).map((option) => {
    return option.value
  })
}

function replaceSelection(options: { element: Element; text: string; direction?: 'backward' | 'forward' }): void {
  const { element, text } = options
  if (!isEditable(element)) return
  const inputType = options.direction
    ? `deleteContent${options.direction === 'backward' ? 'Backward' : 'Forward'}`
    : 'insertText'
  if (!inputEvent({ element, name: 'beforeinput', data: text || null, inputType })) return
  if (element.localName === 'input' || element.localName === 'textarea') {
    const input = element as HTMLInputElement | HTMLTextAreaElement
    if (input.selectionStart === null || input.selectionEnd === null)
      throw new FirefoxDomError({
        code: 'unsupported-capability',
        message: 'press/type editing requires a text control with a selection range; use fill for this input type.',
      })
    let start = input.selectionStart
    let end = input.selectionEnd
    if (start === end && options.direction === 'backward') start = Math.max(0, start - 1)
    if (start === end && options.direction === 'forward') end = Math.min(input.value.length, end + 1)
    setNativeValue({ element: input, value: input.value.slice(0, start) + text + input.value.slice(end) })
    input.setSelectionRange(start + text.length, start + text.length)
  } else {
    const selection = element.ownerDocument.getSelection()
    if (!selection || selection.rangeCount === 0)
      throw new FirefoxDomError({ message: 'The contenteditable element has no selection.' })
    const range = selection.getRangeAt(0)
    if (!element.contains(range.commonAncestorContainer))
      throw new FirefoxDomError({ message: 'The current selection is outside the contenteditable element.' })
    if (range.collapsed && options.direction) {
      if (range.startContainer.nodeType !== 3)
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message:
            'Deleting across contenteditable element boundaries requires native editing; select the desired text or use fill.',
        })
      if (options.direction === 'backward' && range.startOffset > 0)
        range.setStart(range.startContainer, range.startOffset - 1)
      if (options.direction === 'forward' && range.endOffset < (range.endContainer.textContent?.length ?? 0))
        range.setEnd(range.endContainer, range.endOffset + 1)
    }
    range.deleteContents()
    if (text) {
      const node = element.ownerDocument.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
    }
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  inputEvent({ element, name: 'input', data: text || null, inputType })
}

export function pressKey(options: { element: Element; key: string }): void {
  const element = controlForElement(options.element)
  const view = element.ownerDocument.defaultView
  if (!view) throw new FirefoxDomError({ message: 'The document has no active window.' })
  const parts = options.key.split('+')
  const key = parts.pop() || '+'
  const modifiers = new Set(parts)
  const ctrlKey = modifiers.has('Control') || (modifiers.has('ControlOrMeta') && !/Mac/.test(view.navigator.platform))
  const metaKey = modifiers.has('Meta') || (modifiers.has('ControlOrMeta') && /Mac/.test(view.navigator.platform))
  const shiftKey = modifiers.has('Shift')
  const altKey = modifiers.has('Alt')
  const normalizedKey = key === 'Space' ? ' ' : key
  if (
    ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].includes(key) ||
    ((ctrlKey || metaKey) && /^(c|v|x|l|r|t|w|n)$/i.test(key))
  ) {
    throw new FirefoxDomError({
      code: 'unsupported-capability',
      message:
        'Ordinary Firefox extensions cannot send native browser shortcuts or access the clipboard through synthetic key events.',
    })
  }
  focusElement(element)
  const init: KeyboardEventInit = {
    key: normalizedKey,
    ctrlKey,
    metaKey,
    shiftKey,
    altKey,
    bubbles: true,
    cancelable: true,
    composed: true,
  }
  const allowed = element.dispatchEvent(new view.KeyboardEvent('keydown', init))
  if (allowed) {
    if ((ctrlKey || metaKey) && key.toLowerCase() === 'a') {
      if (element.localName === 'input' || element.localName === 'textarea') (element as HTMLInputElement).select()
      else if (isEditable(element)) {
        const range = element.ownerDocument.createRange()
        range.selectNodeContents(element)
        const selection = element.ownerDocument.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    } else if (key === 'Backspace' || key === 'Delete')
      replaceSelection({ element, text: '', direction: key === 'Backspace' ? 'backward' : 'forward' })
    else if (key === 'Enter') {
      if (
        element.localName === 'textarea' ||
        (isEditable(element) && !['input', 'textarea'].includes(element.localName))
      )
        replaceSelection({ element, text: '\n' })
      else if (element.localName === 'input' && (element as HTMLInputElement).form)
        (element as HTMLInputElement).form?.requestSubmit()
      else if (element.matches('button,a[href],input[type=submit],input[type=button]')) clickElement({ element })
    } else if (normalizedKey === ' ' && element.matches('button,input[type=checkbox],input[type=radio]'))
      clickElement({ element })
    else if (key === 'Tab') {
      const candidates = Array.from(
        element.ownerDocument.querySelectorAll<HTMLElement>(
          'a[href],button,input,select,textarea,[tabindex],[contenteditable=true]',
        ),
      ).filter((candidate) => {
        return candidate.tabIndex >= 0 && !isDisabled(candidate) && isVisible(candidate)
      })
      candidates.sort((left, right) => {
        return (left.tabIndex || Infinity) - (right.tabIndex || Infinity)
      })
      const target = candidates[candidates.indexOf(element as HTMLElement) + (shiftKey ? -1 : 1)]
      if (!target)
        throw new FirefoxDomError({
          code: 'unsupported-capability',
          message: 'Synthetic Tab cannot move focus into browser chrome or another browsing context.',
        })
      focusElement(target)
    } else if (
      ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key) &&
      (element.localName === 'input' || element.localName === 'textarea')
    ) {
      const input = element as HTMLInputElement
      const start = input.selectionStart
      const end = input.selectionEnd
      if (start !== null && end !== null) {
        const next =
          key === 'Home'
            ? 0
            : key === 'End'
              ? input.value.length
              : key === 'ArrowLeft'
                ? Math.max(0, start - 1)
                : Math.min(input.value.length, end + 1)
        input.setSelectionRange(shiftKey ? Math.min(start, next) : next, shiftKey ? Math.max(end, next) : next)
      }
    } else if ([...normalizedKey].length === 1 && !ctrlKey && !metaKey && !altKey) {
      const keypressAllowed = element.dispatchEvent(new view.KeyboardEvent('keypress', init))
      if (keypressAllowed) replaceSelection({ element, text: normalizedKey })
    }
  }
  element.dispatchEvent(new view.KeyboardEvent('keyup', init))
}
