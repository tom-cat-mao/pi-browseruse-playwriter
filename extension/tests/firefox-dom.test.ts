import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { JSDOM } from 'jsdom'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import childProcess from 'node:child_process'
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
  ariaVisible,
  isDisabled,
  locatorForSelector,
  resolveLocator,
  strictElement,
} from '../src/firefox-dom-locators'
import { checkedState, clickElement, fillElement, pressKey, selectOptions, setChecked } from '../src/firefox-dom-input'
import {
  assertFrameTransform,
  assertStaticFrameTransform,
  checkFramePoint,
  frameContentQuad,
  mapFramePoint,
  untransformedFrameContentBox,
} from '../src/firefox-dom-frame'
import { assertFirefoxCsp } from '../../scripts/firefox-csp.mjs'

const repoRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../..')

describe('Firefox distribution CSP', () => {
  function packageFixture(policy?: { extension_pages: string } | null) {
    const tempRoot = path.join(repoRoot, 'tmp')
    fs.mkdirSync(tempRoot, { recursive: true })
    const root = fs.mkdtempSync(path.join(tempRoot, 'firefox-csp-'))
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension/manifest.firefox.json'), 'utf8'))
    manifest.content_security_policy = policy
    const bundle = path.join(root, 'playwriter/dist/extension-firefox')
    fs.mkdirSync(bundle, { recursive: true })
    fs.mkdirSync(path.join(root, 'extension/scripts'), { recursive: true })
    fs.mkdirSync(path.join(root, 'scripts'))
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(root, 'node_modules'), 'dir')
    for (const script of ['package-extension.mjs', 'firefox-csp.mjs']) {
      fs.copyFileSync(path.join(repoRoot, 'scripts', script), path.join(root, 'scripts', script))
    }
    fs.copyFileSync(
      path.join(repoRoot, 'extension/scripts/build-firefox.mjs'),
      path.join(root, 'extension/scripts/build-firefox.mjs'),
    )
    fs.copyFileSync(path.join(repoRoot, 'playwriter/package.json'), path.join(root, 'playwriter/package.json'))
    fs.copyFileSync(path.join(repoRoot, 'extension/manifest.json'), path.join(root, 'extension/manifest.json'))
    fs.writeFileSync(path.join(root, 'extension/manifest.firefox.json'), JSON.stringify(manifest))
    fs.writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify(manifest))
    fs.cpSync(path.join(repoRoot, 'extension/icons'), path.join(bundle, 'icons'), { recursive: true })
    for (const page of ['firefox-popup.html', 'firefox-tutorial.html', 'firefox-tutorial.css']) {
      fs.copyFileSync(path.join(repoRoot, 'extension/src', page), path.join(bundle, page))
    }
    fs.writeFileSync(path.join(bundle, 'firefox-build.json'), JSON.stringify({ host: '127.0.0.1', port: 19989 }))
    fs.writeFileSync(path.join(bundle, 'firefox-background.js'), 'const PORT = 19989;')
    fs.writeFileSync(path.join(bundle, 'firefox-dom.js'), '')
    fs.writeFileSync(path.join(bundle, 'firefox-popup.js'), '')
    fs.writeFileSync(path.join(bundle, 'firefox-tutorial.js'), '')
    return root
  }

  test('packages the real explicit script policy and verifies the generated ZIP/XPI', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'extension/manifest.firefox.json'), 'utf8'))
    expect(() => {
      assertFirefoxCsp(manifest)
    }).not.toThrow()
    const root = packageFixture(manifest.content_security_policy)
    try {
      const result = childProcess.spawnSync(process.execPath, ['scripts/package-extension.mjs', '--firefox'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
      })
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('-unsigned.xpi.sha256')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test.each([
    undefined,
    null,
    { extension_pages: '' },
    { extension_pages: "script-src 'self'; upgrade-insecure-requests;" },
    { extension_pages: "script-src 'self'; object-src 'self'; upgrade-insecure-requests;" },
    { extension_pages: "script-src 'self' 'unsafe-eval'; object-src 'self';" },
    { extension_pages: "script-src 'self' 'unsafe-inline'; object-src 'self';" },
    { extension_pages: "script-src 'self' https://example.com; object-src 'self';" },
    { extension_pages: "script-src 'self'; object-src 'self'; script-src-elem *;" },
  ])('build and package reject missing, upgrading or unsafe CSP: %j', (policy) => {
    const root = packageFixture(policy)
    try {
      for (const args of [['extension/scripts/build-firefox.mjs'], ['scripts/package-extension.mjs', '--firefox']]) {
        const result = childProcess.spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 5000 })
        expect(result.status).toBe(1)
        expect(result.stderr).toContain('Firefox extension CSP must explicitly use')
        expect(fs.existsSync(path.join(root, 'dist-release'))).toBe(false)
        expect(fs.existsSync(path.join(root, 'extension/dist-firefox'))).toBe(false)
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})

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

  test('resolves a chained locator into the root element own open shadow root', () => {
    const host = element('#shadow-host')
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<input id="shadow-input" aria-label="Shadow field" /><button>Shadow action</button>'
    expect(
      select({
        steps: [
          { kind: 'selector', engine: 'css', value: '#shadow-host' },
          { kind: 'selector', engine: 'css', value: 'input' },
        ],
      }),
    ).toEqual([shadow.querySelector('input')])
    expect(
      select({
        steps: [
          { kind: 'selector', engine: 'css', value: '#shadow-host' },
          { kind: 'selector', engine: 'role', value: 'textbox', name: 'Shadow field', exact: true },
        ],
      }),
    ).toEqual([shadow.querySelector('input')])
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

describe('Firefox DOM ARIA visibility from the element own document', () => {
  test('excludes display:none, visibility:hidden, aria-hidden ancestors and inert subtrees', () => {
    const host = document.createElement('div')
    host.innerHTML = [
      '<div id="vis">Visible</div>',
      '<div id="none" style="display:none">Display none</div>',
      '<div id="invisible" style="visibility:hidden">Visibility hidden</div>',
      '<div id="aria" aria-hidden="true">Aria hidden<button id="aria-child">Inside</button></div>',
      '<div id="inert" inert><button id="inert-child">Inside</button></div>',
    ].join('')
    document.body.append(host)
    expect(ariaVisible(document.getElementById('vis')!)).toBe(true)
    expect(ariaVisible(document.getElementById('none')!)).toBe(false)
    expect(ariaVisible(document.getElementById('invisible')!)).toBe(false)
    expect(ariaVisible(document.getElementById('aria')!)).toBe(false)
    expect(ariaVisible(document.getElementById('aria-child')!)).toBe(false)
    expect(ariaVisible(document.getElementById('inert')!)).toBe(false)
    expect(ariaVisible(document.getElementById('inert-child')!)).toBe(false)
  })

  test('resolves computed style through the element own same-origin iframe document', () => {
    const iframe = document.createElement('iframe')
    document.body.append(iframe)
    const frameDocument = iframe.contentDocument
    expect(frameDocument).not.toBeNull()
    expect(frameDocument!.defaultView).not.toBe(window)
    frameDocument!.body.innerHTML =
      '<div id="frame-visible">Visible</div><div id="frame-hidden" style="display:none">Hidden</div>'
    expect(ariaVisible(frameDocument!.getElementById('frame-visible')!)).toBe(true)
    expect(ariaVisible(frameDocument!.getElementById('frame-hidden')!)).toBe(false)
  })

  test('role locators apply the same aria visibility filter', () => {
    const host = document.createElement('div')
    host.innerHTML = [
      '<button id="shown" aria-label="Shown">A</button>',
      '<div aria-hidden="true"><button id="buried" aria-label="Buried">B</button></div>',
    ].join('')
    document.body.append(host)
    expect(
      select({ steps: [{ kind: 'selector', engine: 'role', value: 'button', name: 'Shown', exact: true }] }),
    ).toEqual([document.getElementById('shown')])
    expect(
      select({ steps: [{ kind: 'selector', engine: 'role', value: 'button', name: 'Buried', exact: true }] }),
    ).toEqual([])
  })
})

describe('Firefox DOM snapshot lifetime and isolation', () => {
  test('derives document and snapshot identities from page crypto without the secure-context-only randomUUID', async () => {
    const shape =
      /^firefox:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/
    const first = success(await driver.run(request({ method: 'snapshot' })))
    const second = success(await driver.run(request({ method: 'snapshot' })))
    expect(first.snapshotId).toMatch(shape)
    expect(second.snapshotId).toMatch(shape)
    expect(first.snapshotId).not.toBe(second.snapshotId)
    expect(first.snapshotId!.split(':')[1]).toBe(second.snapshotId!.split(':')[1])
  })

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

describe('Firefox DOM stale snapshot diagnostics', () => {
  function staleMessage(response: BrowserResponse): string {
    if (response.ok) throw new Error('expected a stale-snapshot rejection')
    expect(response.error).toMatchObject({ code: 'stale-snapshot', outcome: 'not-started' })
    return response.error.message
  }

  async function snapshotRef(): Promise<{ snapshotId: string; ref: string }> {
    const result = success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    const refs = (result.value as { refs: Array<{ ref: string }> }).refs
    return { snapshotId: result.snapshotId!, ref: refs[0].ref }
  }

  test('reports a missing snapshotId without weakening the stale-snapshot rejection', async () => {
    const { ref } = await snapshotRef()
    const response = await driver.run(request({ method: 'click', selector: `@${ref}` }))
    expect(staleMessage(response)).toContain('reason: missing-snapshot-id')
  })

  test('reports a ref that the current snapshot does not contain', async () => {
    const first = await snapshotRef()
    const second = success(await driver.run(request({ method: 'snapshot', search: 'definitely absent text' })))
    const response = await driver.run(
      request({ method: 'click', selector: `@${first.ref}`, snapshotId: second.snapshotId }),
    )
    expect(staleMessage(response)).toContain('reason: ref-not-in-snapshot')
  })

  test('reports a snapshot replaced by a newer snapshot', async () => {
    const first = await snapshotRef()
    const second = success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    expect(second.snapshotId).not.toBe(first.snapshotId)
    const response = await driver.run(
      request({ method: 'click', selector: `@${first.ref}`, snapshotId: first.snapshotId }),
    )
    expect(staleMessage(response)).toContain('reason: snapshot-replaced')
  })

  test('reports unknown when the supersede record was overwritten by another snapshot', async () => {
    const first = await snapshotRef()
    success(await driver.run(request({ method: 'invalidate' })))
    const second = success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    expect(second.snapshotId).not.toBe(first.snapshotId)
    success(await driver.run(request({ method: 'invalidate' })))
    success(await driver.run(request({ method: 'snapshot', search: 'Save profile' })))
    const response = await driver.run(
      request({ method: 'click', selector: `@${first.ref}`, snapshotId: first.snapshotId }),
    )
    expect(staleMessage(response)).toContain('reason: unknown')
  })

  test('reports unknown for a snapshotId this driver never generated', async () => {
    const { snapshotId, ref } = await snapshotRef()
    const unseen = `${snapshotId.split(':').slice(0, 2).join(':')}:00000000-0000-4000-8000-000000000000`
    expect(unseen).not.toBe(snapshotId)
    const response = await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId: unseen }))
    expect(staleMessage(response)).toContain('reason: unknown')
  })

  test('reports the DOM mutation that invalidated the requested snapshot', async () => {
    const { snapshotId, ref } = await snapshotRef()
    element('#save').setAttribute('data-changed', 'yes')
    const response = await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId }))
    expect(staleMessage(response)).toContain('reason: invalidated:dom-mutation')
  })

  test('reports the navigation event that invalidated the requested snapshot', async () => {
    const { snapshotId, ref } = await snapshotRef()
    window.dispatchEvent(new window.Event('hashchange'))
    const response = await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId }))
    expect(staleMessage(response)).toContain('reason: invalidated:navigation')
  })

  test('reports the explicit invalidate command that cleared the requested snapshot', async () => {
    const { snapshotId, ref } = await snapshotRef()
    success(await driver.run(request({ method: 'invalidate' })))
    const response = await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId }))
    expect(staleMessage(response)).toContain('reason: invalidated:explicit-invalidate')
  })

  test('reports the evaluation that invalidated the requested snapshot', async () => {
    const { snapshotId, ref } = await snapshotRef()
    const evaluated = success(
      await driver.run(request({ method: 'evaluate', code: 'return 1' }), async () => {
        return 1
      }),
    )
    expect(evaluated.value).toBe(1)
    const response = await driver.run(request({ method: 'click', selector: `@${ref}`, snapshotId }))
    expect(staleMessage(response)).toContain('reason: invalidated:evaluate')
  })

  test('reports the action that invalidated the requested snapshot and still refuses the reused ref', async () => {
    const { snapshotId, ref } = await snapshotRef()
    const locator: BrowserDomLocator = {
      steps: [{ kind: 'selector', engine: 'css', value: `aria-ref=${ref}` }],
      snapshotId,
    }
    success(await driver.run(request({ method: 'locator', locator, action: 'blur' })))
    const response = await driver.run(request({ method: 'locator', locator, action: 'blur' }))
    expect(staleMessage(response)).toContain('reason: invalidated:action')
  })

  test('reports a snapshotId owned by another document driver as different-document', async () => {
    const otherDom = new JSDOM(fixture, { url: 'https://fixture.test/' })
    const otherWindow = otherDom.window as unknown as Window & typeof globalThis
    const otherDriver = createFirefoxDomDriver(otherWindow.document)
    try {
      const other = success(await otherDriver.run(request({ method: 'snapshot', search: 'Save profile' })))
      const otherRef = (other.value as { refs: Array<{ ref: string }> }).refs[0].ref
      const response = await driver.run(
        request({ method: 'click', selector: `@${otherRef}`, snapshotId: other.snapshotId }),
      )
      expect(staleMessage(response)).toContain('reason: different-document')
    } finally {
      if (!otherDriver.disposed) await otherDriver.run(request({ method: 'dispose' }))
      otherDom.window.close()
    }
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

  test('derives an untransformed frame content quad from provable border/client geometry', () => {
    expect(
      frameContentQuad({
        box: { left: 100, top: 50, width: 320, height: 220 },
        client: { left: 2, top: 3, width: 316, height: 217 },
        border: { left: 2, right: 2, top: 3, bottom: 0 },
        padding: { left: 8, right: 6, top: 4, bottom: 5 },
      }),
    ).toEqual({
      quad: {
        p1: { x: 110, y: 57 },
        p2: { x: 412, y: 57 },
        p3: { x: 412, y: 265 },
        p4: { x: 110, y: 265 },
      },
      viewport: { width: 302, height: 208 },
    })
  })

  test('rejects frame boxes that cannot be proven exact without getBoxQuads', () => {
    const base = {
      box: { left: 100, top: 50, width: 320, height: 220 },
      client: { left: 2, top: 3, width: 316, height: 217 },
      border: { left: 2, right: 2, top: 3, bottom: 0 },
      padding: { left: 8, right: 6, top: 4, bottom: 5 },
    }
    expect(() => {
      frameContentQuad({ ...base, box: { ...base.box, width: 0 } })
    }).toThrow('non-degenerate')
    expect(() => {
      frameContentQuad({ ...base, box: { ...base.box, left: Number.NaN } })
    }).toThrow('non-degenerate')
    expect(() => {
      frameContentQuad({ ...base, border: { ...base.border, left: 2.5 } })
    }).toThrow('rounded client offset')
    expect(() => {
      frameContentQuad({ ...base, box: { ...base.box, width: 321 } })
    }).toThrow('disagree')
    expect(() => {
      frameContentQuad({ ...base, padding: { ...base.padding, right: 316 } })
    }).toThrow('positive content box')
  })

  test('requires a strictly untransformed frame chain for the getBoxQuads-free path', () => {
    const neutral = {
      transform: 'none',
      rotate: 'none',
      scale: 'none',
      translate: 'none',
      zoom: '1',
      perspective: 'none',
      offsetPath: 'none',
    }
    for (const style of [
      neutral,
      { ...neutral, transform: '' },
      { ...neutral, transform: 'matrix(1, 0, 0, 1, 0, 0)' },
      { ...neutral, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)' },
      { ...neutral, rotate: '0deg', scale: '1 1', translate: '0px 0px', zoom: '100%' },
      { ...neutral, rotate: '', scale: '', translate: '', zoom: '' },
    ]) {
      expect(() => {
        assertStaticFrameTransform(style)
      }).not.toThrow()
    }
    for (const style of [
      { ...neutral, transform: 'matrix(2, 0, 0, 2, 0, 0)' },
      { ...neutral, transform: 'matrix(1, 0, 0, 1, 40, 0)' },
      { ...neutral, transform: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1.5)' },
      { ...neutral, rotate: '45deg' },
      { ...neutral, scale: '2' },
      { ...neutral, translate: '10px' },
      { ...neutral, zoom: '1.5' },
      { ...neutral, perspective: '1000px' },
      { ...neutral, offsetPath: 'path("M0 0 L10 10")' },
    ]) {
      expect(() => {
        assertStaticFrameTransform(style)
      }).toThrow('without getBoxQuads')
    }
  })

  test('refuses a frame action when the frame has no provable layout box without getBoxQuads', () => {
    expect(() => {
      untransformedFrameContentBox({ frame: element('#same-origin') })
    }).toThrow('single unfragmented frame box')
  })
})
