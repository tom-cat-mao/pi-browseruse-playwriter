import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JSDOM } from 'jsdom'
import type {
  BrowserDomCommand,
  BrowserDomLocator,
  BrowserDomRequest,
  BrowserResponse,
} from 'playwriter/browser-protocol'
import fixture from '../test-fixtures/firefox-dom.html?raw'
import { browserJson, createFirefoxDomDriver } from '../src/firefox-dom'
import { firefoxScreenshotCleanupRequest } from '../src/firefox-resources'
import type { FirefoxDomDriver } from '../src/firefox-dom'
import {
  accessibleName,
  isDisabled,
  locatorForSelector,
  resolveLocator,
  strictElement,
} from '../src/firefox-dom-locators'
import { checkedState, clickElement, fillElement, pressKey, selectOptions, setChecked } from '../src/firefox-dom-input'
import { assertFrameTransform, checkFramePoint, mapFramePoint } from '../src/firefox-dom-frame'

let driver: FirefoxDomDriver
let requestSequence = 0
let fixtureDom: JSDOM
let document: Document
let window: Window & typeof globalThis

function request(command: BrowserDomCommand): BrowserDomRequest {
  requestSequence += 1
  return {
    requestId: `request-${requestSequence}`,
    sessionId: 'session-fixture',
    tabId: 'tab-fixture',
    browserEpoch: 'epoch-fixture',
    command,
    timeoutMs: 1000,
  }
}

function success(response: BrowserResponse) {
  if (!response.ok) throw new Error(JSON.stringify(response.error))
  return response.data
}

function select(locator: BrowserDomLocator): Element[] {
  return resolveLocator({ root: document, locator })
}

function element(selector: string): Element {
  return strictElement(select(locatorForSelector(selector)))
}

beforeEach(() => {
  fixtureDom = new JSDOM(fixture, { url: 'https://fixture.test/' })
  window = fixtureDom.window as unknown as Window & typeof globalThis
  document = window.document
  driver = createFirefoxDomDriver(document)
})

afterEach(async () => {
  if (!driver.disposed) await driver.run(request({ method: 'dispose' }))
  fixtureDom.window.close()
})

describe('Firefox DOM locator and accessible name logic', () => {
  test('uses the accessible name algorithm, including hidden aria-labelledby and labels', () => {
    expect(accessibleName(element('#save'))).toBe('Save profile')
    expect(
      select({ steps: [{ kind: 'selector', engine: 'role', value: 'button', name: 'Save profile', exact: true }] }),
    ).toEqual([element('#save')])
    expect(select({ steps: [{ kind: 'selector', engine: 'label', value: 'Display name', exact: true }] })).toEqual([
      element('#name'),
    ])
    expect(select({ steps: [{ kind: 'selector', engine: 'alt', value: 'Company logo', exact: true }] })).toEqual([
      element('#logo'),
    ])
    expect(select({ steps: [{ kind: 'selector', engine: 'placeholder', value: 'records' }] })).toEqual([
      element('#search'),
    ])
    expect(element('role=button[name="Save profile"]')).toBe(element('#save'))
  })

  test('strict selectors reject zero/multiple matches and only explicit nth disambiguates', () => {
    expect(() => {
      element('.missing')
    }).toThrow('matched 0')
    expect(() => {
      element('.repeated')
    }).toThrow('matched 2')
    expect(
      select({
        steps: [
          { kind: 'selector', engine: 'css', value: '.repeated' },
          { kind: 'nth', index: -1 },
        ],
      }),
    ).toEqual([document.querySelectorAll('.repeated')[1]])
    expect(() => {
      select(locatorForSelector('button['))
    }).toThrow('Invalid CSS selector')
    expect(() => {
      locatorForSelector('role=button[name=bad]')
    }).toThrow('Unsupported role selector')
  })

  test('filters relative to each candidate and pierces open shadow roots', () => {
    const shadow = element('#shadow-host').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button aria-label="Shadow action">Shadow</button>'
    expect(
      select({ steps: [{ kind: 'selector', engine: 'role', value: 'button', name: 'Shadow action', exact: true }] }),
    ).toEqual([shadow.querySelector('button')])
    expect(
      select({
        steps: [
          { kind: 'selector', engine: 'css', value: 'li' },
          {
            kind: 'filter',
            hasText: 'beta',
            has: { steps: [{ kind: 'selector', engine: 'role', value: 'button', name: 'Open' }] },
          },
          { kind: 'selector', engine: 'role', value: 'button' },
        ],
      }),
    ).toEqual([element('[data-testid="second-item"] button')])
    expect(select({ steps: [{ kind: 'selector', engine: 'text', value: 'Beta', exact: false }] })).toEqual([
      element('[data-testid="second-item"]'),
    ])
  })

  test('enters explicit same-origin frames and keeps parent queries outside frames', () => {
    const frame = element('#same-origin') as HTMLIFrameElement
    frame.contentDocument!.body.innerHTML = '<button>Frame action</button>'
    expect(
      select({
        steps: [
          { kind: 'frame', selector: '#same-origin' },
          { kind: 'selector', engine: 'role', value: 'button', name: 'Frame action' },
        ],
      }),
    ).toEqual([frame.contentDocument!.querySelector('button')])
    expect(select({ steps: [{ kind: 'selector', engine: 'role', value: 'button', name: 'Frame action' }] })).toEqual([])
    expect(() => {
      select({ steps: [{ kind: 'frame', selector: '#name' }] })
    }).toThrow('does not refer to a frame')
  })

  test('honors native disabled fieldsets and the legend exception', () => {
    expect(isDisabled(element('#disabled-input'))).toBe(true)
    expect(isDisabled(element('#legend-input'))).toBe(false)
    expect(
      select({ steps: [{ kind: 'selector', engine: 'role', value: 'textbox', options: { disabled: true } }] }),
    ).toContain(element('#disabled-input'))
  })
})

describe('Firefox DOM snapshot lifetime and isolation', () => {
  test('snapshot refs have correct names and are invalidated after dynamic replacement', async () => {
    const first = success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    expect(first.text).toContain('button "Save profile"')
    expect(first.snapshotId).toMatch(/^firefox:/)
    const refs = (first.value as { refs: Array<{ ref: string; name: string }> }).refs
    expect(refs).toHaveLength(1)
    element('#save').replaceWith(document.createElement('button'))
    const response = await driver.run(
      request({ method: 'click', selector: `@${refs[0].ref}`, snapshotId: first.snapshotId }),
    )
    expect(response).toMatchObject({ ok: false, error: { code: 'stale-snapshot', outcome: 'not-started' } })
  })

  test('evaluation invalidates old refs even when code only returns a value', async () => {
    const first = success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    const ref = (first.value as { refs: Array<{ ref: string }> }).refs[0].ref
    const evaluated = success(
      await driver.run(request({ method: 'evaluate', code: 'return 42' }), async () => {
        return 42
      }),
    )
    expect(evaluated.value).toBe(42)
    const response = await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId: first.snapshotId }))
    expect(response).toMatchObject({ ok: false, error: { code: 'stale-snapshot' } })
  })

  test('ref locator reads preserve snapshot identity and cannot cross into the evaluation world', async () => {
    const first = success(await driver.run(request({ method: 'snapshot', search: 'Display name' })))
    const ref = (first.value as { refs: Array<{ ref: string }> }).refs[0].ref
    const locator: BrowserDomLocator = {
      steps: [{ kind: 'selector', engine: 'css', value: `aria-ref=${ref}` }],
      snapshotId: first.snapshotId,
    }
    expect(success(await driver.run(request({ method: 'locator', locator, action: 'inputValue' }))).value).toBe(
      'Existing form value',
    )
    expect(success(await driver.run(request({ method: 'locator', locator, action: 'isEditable' }))).value).toBe(true)
    expect(
      await driver.run(request({ method: 'evaluate', locator, code: 'return element.value' }), (element) => {
        return (element as HTMLInputElement).value
      }),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-capability', outcome: 'not-started' } })
    success(await driver.run(request({ method: 'invalidate' })))
    expect(await driver.run(request({ method: 'locator', locator, action: 'inputValue' }))).toMatchObject({
      ok: false,
      error: { code: 'stale-snapshot' },
    })
  })

  test('rejects undefined evaluation results and still invalidates the snapshot', async () => {
    const first = success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    const evaluated = await driver.run(request({ method: 'evaluate', code: 'document.title' }), async () => {})
    expect(evaluated).toMatchObject({ ok: false, error: { code: 'execution-failed', outcome: 'unknown' } })
    if (!evaluated.ok) expect(evaluated.error.message).toContain('explicit return')
    const ref = (first.value as { refs: Array<{ ref: string }> }).refs[0].ref
    expect(
      await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId: first.snapshotId })),
    ).toMatchObject({ ok: false, error: { code: 'stale-snapshot' } })
  })

  test('isolates session/tab/epoch identities and refuses the old driver after dispose', async () => {
    success(await driver.run(request({ method: 'page', action: 'title' })))
    expect(
      await driver.run({ ...request({ method: 'page', action: 'title' }), sessionId: 'another-session' }),
    ).toMatchObject({ ok: false, error: { code: 'ownership-mismatch', outcome: 'not-started' } })
    success(await driver.run(request({ method: 'dispose' })))
    expect(await driver.run(request({ method: 'page', action: 'title' }))).toMatchObject({
      ok: false,
      error: { code: 'resource-released' },
    })
  })

  test('cancellation wakes a pending locator wait before an action can start', async () => {
    const pendingRequest = request({
      method: 'locator',
      locator: locatorForSelector('#not-yet-present'),
      action: 'waitFor',
      args: [{ state: 'attached' }],
    })
    const pending = driver.run(pendingRequest)
    driver.cancel(pendingRequest.requestId)
    const added = document.createElement('button')
    added.id = 'not-yet-present'
    document.body.append(added)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled', outcome: 'not-started' } })
  })

  test('a duplicate pending request cannot detach the original cancellation controller', async () => {
    const pendingRequest = request({
      method: 'locator',
      locator: locatorForSelector('#not-present'),
      action: 'waitFor',
      args: [{ state: 'attached' }],
    })
    const pending = driver.run(pendingRequest)
    expect(await driver.run(pendingRequest)).toMatchObject({ ok: false, error: { code: 'invalid-request' } })
    driver.cancel(pendingRequest.requestId)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'cancelled', outcome: 'not-started' } })
  })

  test('mutations in observed open shadow roots invalidate their real element refs', async () => {
    const shadow = element('#shadow-host').attachShadow({ mode: 'open' })
    shadow.innerHTML = '<button>Shadow action</button>'
    const first = success(await driver.run(request({ method: 'snapshot', search: 'Shadow action' })))
    const ref = (first.value as { refs: Array<{ ref: string }> }).refs[0].ref
    shadow.querySelector('button')!.setAttribute('aria-label', 'Changed action')
    expect(
      await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId: first.snapshotId })),
    ).toMatchObject({ ok: false, error: { code: 'stale-snapshot' } })
  })

  test('frame identity lookups reject the unprivileged evaluation world', async () => {
    expect(
      await driver.run(request({ method: 'frame.resolve', locator: locatorForSelector('#same-origin') })),
    ).toMatchObject({ ok: false, error: { code: 'unsupported-capability', outcome: 'not-started' } })
  })

  test('snapshot searches keep only returned refs and screenshot cleanup preserves DOM content', async () => {
    const result = success(await driver.run(request({ method: 'snapshot', search: 'definitely absent text' })))
    expect((result.value as { refs: unknown[] }).refs).toEqual([])
    const before = document.body.innerHTML
    const prepared = success(await driver.run(request({ method: 'screenshot.prepare', labels: true, fullPage: true })))
    expect(prepared.snapshotId).toBeTruthy()
    expect(prepared.value).toMatchObject({ viewportWidth: window.innerWidth, viewportHeight: window.innerHeight })
    success(await driver.run(request({ method: 'screenshot.cleanup' })))
    expect(document.body.innerHTML).toBe(before)
  })

  test('screenshot cancellation still removes labels through its independent cleanup request', async () => {
    const before = document.documentElement.innerHTML
    const screenshot = request({ method: 'screenshot.prepare', labels: true })
    success(await driver.run(screenshot))
    expect(document.documentElement.innerHTML).not.toBe(before)

    driver.cancel(screenshot.requestId)
    const cleanup = firefoxScreenshotCleanupRequest(screenshot)
    expect(cleanup.requestId).not.toBe(screenshot.requestId)
    expect(cleanup).toMatchObject({
      sessionId: screenshot.sessionId,
      tabId: screenshot.tabId,
      browserEpoch: screenshot.browserEpoch,
    })
    success(await driver.run(cleanup))
    expect(document.documentElement.innerHTML).toBe(before)
    success(await driver.run(firefoxScreenshotCleanupRequest(screenshot)))
    expect(document.documentElement.innerHTML).toBe(before)
  })

  test('captures real DOM error events with bounded logs and states the missing page console bridge', async () => {
    window.dispatchEvent(
      new window.ErrorEvent('error', { message: 'fixture failure', filename: 'fixture.js', lineno: 7 }),
    )
    const result = success(await driver.run(request({ method: 'logs', limit: 1 })))
    expect(result.logs).toHaveLength(1)
    expect(result.logs![0]).toContain('fixture failure fixture.js:7')
    expect(result.text).toContain('console bridge is unavailable')
  })
})

describe('Firefox DOM input logic with real document fixtures', () => {
  test('fills a native input and notifies actual input/change listeners', () => {
    const input = element('#name') as HTMLInputElement
    const events: string[] = []
    input.addEventListener('beforeinput', (event) => {
      events.push(`${event.type}:${event.isTrusted}`)
    })
    input.addEventListener('input', () => {
      events.push(`input:${input.value}`)
    })
    input.addEventListener('change', () => {
      events.push(`change:${input.value}`)
    })
    fillElement({ element: input, value: 'Updated profile' })
    expect(input.value).toBe('Updated profile')
    expect(events).toEqual(['beforeinput:false', 'input:Updated profile', 'change:Updated profile'])
  })

  test('respects beforeinput cancellation and disabled controls', () => {
    const input = element('#name') as HTMLInputElement
    input.addEventListener('beforeinput', (event) => {
      event.preventDefault()
    })
    fillElement({ element: input, value: 'Rejected value' })
    expect(input.value).toBe('Existing form value')
    expect(() => {
      fillElement({ element: element('#disabled-input'), value: 'Invalid' })
    }).toThrow('enabled input')
  })

  test('fills contenteditable safely and edits input selections with synthetic keys', () => {
    fillElement({ element: element('#draft'), value: '<b>Literal draft</b>' })
    expect(element('#draft').textContent).toBe('<b>Literal draft</b>')
    expect(element('#draft').querySelector('b')).toBeNull()
    const input = element('#name') as HTMLInputElement
    pressKey({ element: input, key: 'Control+a' })
    pressKey({ element: input, key: 'Backspace' })
    pressKey({ element: input, key: 'X' })
    expect(input.value).toBe('X')
    expect(() => {
      pressKey({ element: input, key: 'Control+v' })
    }).toThrow('clipboard')
  })

  test('uses real checkbox activation and validates requested state', () => {
    const checkbox = element('#notifications')
    const states: boolean[] = []
    checkbox.addEventListener('change', () => {
      states.push(checkedState(checkbox))
    })
    setChecked({ element: checkbox, checked: true })
    setChecked({ element: checkbox, checked: true })
    setChecked({ element: checkbox, checked: false })
    expect(states).toEqual([true, false])
    expect(checkedState(checkbox)).toBe(false)
  })

  test('selects by value/label/index and rejects unavailable or disabled options', () => {
    expect(selectOptions({ element: element('#theme'), values: [{ label: 'Dark mode' }] })).toEqual(['dark'])
    expect(selectOptions({ element: element('#tags'), values: ['one', { index: 2 }] })).toEqual(['one', 'three'])
    expect(selectOptions({ element: element('#tags'), values: [] })).toEqual([])
    expect(() => {
      selectOptions({ element: element('#theme'), values: ['missing'] })
    }).toThrow('No option matches')
    expect(() => {
      selectOptions({ element: element('#theme'), values: ['locked'] })
    }).toThrow('disabled')
  })

  test('click callbacks run with explicitly untrusted DOM events', () => {
    let trusted: boolean | undefined
    element('#save').addEventListener('click', (event) => {
      trusted = event.isTrusted
    })
    clickElement({ element: element('#save') })
    expect(trusted).toBe(false)
  })

  test('clicking a label retains native activation of its associated hidden checkbox', () => {
    const checkbox = element('#notifications') as HTMLInputElement
    checkbox.hidden = true
    clickElement({ element: checkbox.parentElement! })
    expect(checkbox.checked).toBe(true)
  })

  test('prepared pointer coordinates are used by click events and retain checkbox activation', () => {
    const checkbox = element('#notifications') as HTMLInputElement
    const points: Array<{ x: number; y: number }> = []
    checkbox.addEventListener('click', (event) => {
      points.push({ x: event.clientX, y: event.clientY })
    })
    clickElement({ element: checkbox, point: { x: 24, y: 36 } })
    expect(points).toEqual([{ x: 24, y: 36 }])
    expect(checkbox.checked).toBe(true)
  })

  test('Enter activates the selected input button/reset/submit before considering implicit form submission', () => {
    const form = document.createElement('form')
    form.innerHTML =
      '<input id="enter-text" value="original"><input id="enter-button" type="button"><input id="enter-reset" type="reset"><input id="enter-submit" type="submit">'
    document.body.append(form)
    const clicked: string[] = []
    const submitted: string[] = []
    form.addEventListener('click', (event) => {
      clicked.push((event.target as Element).id)
    })
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted.push((event.submitter as Element).id)
    })
    pressKey({ element: element('#enter-button'), key: 'Enter' })
    expect(clicked).toEqual(['enter-button'])
    expect(submitted).toEqual([])
    const input = element('#enter-text') as HTMLInputElement
    input.value = 'changed'
    pressKey({ element: element('#enter-reset'), key: 'Enter' })
    expect(input.value).toBe('original')
    expect(submitted).toEqual([])
    pressKey({ element: element('#enter-submit'), key: 'Enter' })
    expect(submitted).toEqual(['enter-submit'])
    pressKey({ element: input, key: 'Enter' })
    expect(submitted).toEqual(['enter-submit', 'enter-submit'])
  })
})

describe('Firefox DOM JSON response serialization', () => {
  test('preserves valid JSON and rejects cycles, nodes, unsupported values, and excessive output', () => {
    expect(browserJson({ items: [1, true, null, 'text'] })).toEqual({ items: [1, true, null, 'text'] })
    const cyclic: { self?: object } = {}
    cyclic.self = cyclic
    expect(() => {
      browserJson(cyclic)
    }).toThrow('circular')
    expect(() => {
      browserJson(document.body)
    }).toThrow('DOM nodes')
    expect(() => {
      browserJson(undefined)
    }).toThrow('explicit return')
    expect(() => {
      browserJson(Number.NaN)
    }).toThrow('finite number')
    expect(() => {
      browserJson('x'.repeat(1_000_001))
    }).toThrow('exceeds 1 MB')
  })
})

describe('Firefox frame action point mapping', () => {
  test('frame checks/preparation are unavailable without the trusted callback and forged preparation IDs cannot act', async () => {
    const locator = locatorForSelector('#same-origin')
    expect(await driver.run(request({ method: 'frame.check', locator, point: { x: 1, y: 1 } }))).toMatchObject({
      ok: false,
      error: { code: 'unsupported-capability', outcome: 'not-started' },
    })
    expect(await driver.run(request({ method: 'frame.actionPoint', locator, action: 'click' }))).toMatchObject({
      ok: false,
      error: { code: 'unsupported-capability', outcome: 'not-started' },
    })
    expect(
      await driver.run(
        request({
          method: 'locator',
          locator,
          action: 'click',
          expectedPoint: { x: 1, y: 1 },
          preparationId: 'invented',
        }),
      ),
    ).toMatchObject({ ok: false, error: { code: 'execution-failed', outcome: 'not-started' } })
  })
  test('maps a child viewport point through the actual content quad with border offsets and positive scales', () => {
    expect(
      mapFramePoint({
        point: { x: 25, y: 40 },
        viewport: { width: 300, height: 100 },
        quad: { p1: { x: 110, y: 220 }, p2: { x: 710, y: 220 }, p3: { x: 710, y: 420 }, p4: { x: 110, y: 420 } },
      }),
    ).toEqual({ x: 160, y: 300 })
  })

  test('carries the actual child point through multiple ancestors instead of checking their centers', () => {
    const intermediate = mapFramePoint({
      point: { x: 8, y: 12 },
      viewport: { width: 100, height: 100 },
      quad: { p1: { x: 20, y: 30 }, p2: { x: 120, y: 30 }, p3: { x: 120, y: 130 }, p4: { x: 20, y: 130 } },
    })
    expect(
      mapFramePoint({
        point: intermediate,
        viewport: { width: 200, height: 200 },
        quad: { p1: { x: 200, y: 100 }, p2: { x: 600, y: 100 }, p3: { x: 600, y: 500 }, p4: { x: 200, y: 500 } },
      }),
    ).toEqual({ x: 256, y: 184 })
  })

  test('rejects invalid viewport points and non-axis-aligned quads without approximating them', () => {
    const quad = { p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, p3: { x: 100, y: 100 }, p4: { x: 0, y: 100 } }
    const viewport = { width: 100, height: 100 }
    expect(() => {
      mapFramePoint({ point: { x: -1, y: 2 }, quad, viewport })
    }).toThrow('outside the child')
    expect(() => {
      mapFramePoint({ point: { x: 100, y: 2 }, quad, viewport })
    }).toThrow('outside the child')
    expect(() => {
      mapFramePoint({ point: { x: Number.NaN, y: 2 }, quad, viewport })
    }).toThrow('outside the child')
    expect(() => {
      mapFramePoint({ point: { x: 2, y: 2 }, quad: { ...quad, p2: { x: 100, y: 3 } }, viewport })
    }).toThrow('rotated, skewed')
    expect(() => {
      mapFramePoint({
        point: { x: 2, y: 2 },
        quad: { ...quad, p2: { x: -100, y: 0 }, p3: { x: -100, y: 100 } },
        viewport,
      })
    }).toThrow('reflected')
  })

  test('rejects rotation, skew, 3D transforms and motion paths and permits positive axis scaling', () => {
    const style = { transform: 'none', rotate: 'none', perspective: 'none', offsetPath: 'none' }
    expect(() => {
      assertFrameTransform({ ...style, transform: 'matrix(2, 0, 0, 3, 40, 50)' })
    }).not.toThrow()
    expect(() => {
      assertFrameTransform({ ...style, transform: 'matrix(1, 0.2, 0, 1, 0, 0)' })
    }).toThrow('skew')
    expect(() => {
      assertFrameTransform({ ...style, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' })
    }).toThrow('3D')
    expect(() => {
      assertFrameTransform({ ...style, rotate: '10deg' })
    }).toThrow('rotation')
    expect(() => {
      assertFrameTransform({ ...style, perspective: '1000px' })
    }).toThrow('perspective')
    expect(() => {
      assertFrameTransform({ ...style, offsetPath: 'path("M0 0 L10 10")' })
    }).toThrow('motion paths')
    expect(() => {
      checkFramePoint({ frame: element('#name'), point: { x: 1, y: 1 } })
    }).toThrow('iframe or frame')
  })
})
