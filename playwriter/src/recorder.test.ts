// End-to-end tests for the `playwriter recorder` action recording feature:
// relay /recorder/* endpoints + ActionRecorder JSON output. Trusted input is
// dispatched via raw CDP so it goes through the injected recorder exactly
// like real user interactions.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { chromium } from '@xmorse/playwright-core'
import { getCdpUrl } from './utils.js'
import { getCDPSessionForPage } from './cdp-session.js'
import { parseRecording, projectThinEvent } from './action-recorder.js'
import { setupTestContext, cleanupTestContext, getExtensionServiceWorker, type TestContext } from './test-utils.js'
import './test-declarations.js'

const TEST_PORT = 19997
const SERVER_URL = `http://127.0.0.1:${TEST_PORT}`

const jsonHeaders = { 'Content-Type': 'application/json' }

describe('action recording', () => {
  let testCtx: TestContext | null = null
  let recordingsDir: string | null = null

  beforeAll(async () => {
    // Isolate recordings in a temp dir so tests never pollute the user's real
    // ~/.playwriter/recordings (and never collide with a running relay's ids).
    // The relay runs in-process, so the env var is read by getRecordingsDir().
    recordingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-recordings-test-'))
    process.env.PLAYWRITER_RECORDINGS_DIR = recordingsDir
    testCtx = await setupTestContext({ port: TEST_PORT, tempDirPrefix: 'pw-record-test-', toggleExtension: true })
  }, 600000)

  afterAll(async () => {
    await cleanupTestContext(testCtx, null)
    testCtx = null
    delete process.env.PLAYWRITER_RECORDINGS_DIR
    if (recordingsDir) {
      fs.rmSync(recordingsDir, { recursive: true, force: true })
    }
  })

  it('records user actions with locator strings and state changes', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await new Promise((r) => setTimeout(r, 200))

    // create an executor session on the relay
    const sessionResponse = await fetch(`${SERVER_URL}/cli/session/new`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const session = (await sessionResponse.json()) as { id: string }
    expect(session.id).toBeTruthy()

    // start recording
    const startResponse = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    const start = (await startResponse.json()) as { recordingId: string; file: string; error?: string }
    expect(start.error).toBeUndefined()
    expect(start.recordingId).toBeTruthy()

    // starting again on the same session must fail with 409 Conflict
    const duplicateResponse = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    expect(duplicateResponse.status).toBe(409)

    // inject a form and interact via trusted CDP input like a real user
    const browser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const cdpPage = browser
      .contexts()[0]
      .pages()
      .find((p) => p.url().includes('example.com'))
    expect(cdpPage).toBeDefined()
    await cdpPage!.evaluate(() => {
      document.body.innerHTML = `
        <button id="submit-btn" onclick="localStorage.setItem('submitted', 'yes'); this.textContent = 'Done!'">Submit order</button>
        <input id="email" placeholder="Email address" type="text" />
        <input id="attachment" aria-label="Attachment" type="file" />
      `
    })

    const cdp = await getCDPSessionForPage({ page: cdpPage! })
    const clickAt = async (selector: string) => {
      const box = await cdpPage!.locator(selector).boundingBox()
      expect(box).toBeTruthy()
      const x = box!.x + box!.width / 2
      const y = box!.y + box!.height / 2
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    }

    await clickAt('#submit-btn')
    await clickAt('#email')
    await cdp.send('Input.insertText', { text: 'hi@example.com' })

    // trigger the extra recorded signals: console error, in-page POST fetch
    // (GET is dropped; only mutating xhr/fetch is recorded), and a file upload
    await cdpPage!.evaluate(async () => {
      console.error('recorder-test-error')
      await fetch('/?get-should-be-dropped')
      await fetch('/', { method: 'POST', body: 'recorder-test' }).then((r) => r.text())
    })
    const tmpFile = path.join(os.tmpdir(), 'recorder-test-attachment.txt')
    fs.writeFileSync(tmpFile, 'hello')
    await cdpPage!.locator('#attachment').setInputFiles(tmpFile)
    // another trusted action so the post-action capture picks up the upload diff
    await clickAt('#submit-btn')

    // wait for fill-capture debounce + post-action captures to settle
    await new Promise((r) => setTimeout(r, 3000))

    // status shows the active recording
    const statusResponse = await fetch(`${SERVER_URL}/recorder/status`)
    const status = (await statusResponse.json()) as { recordings: Array<{ recordingId: string; sessionId: string }> }
    expect(status.recordings).toHaveLength(1)
    expect(status.recordings[0].sessionId).toBe(session.id)

    // stop recording
    const stopResponse = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const stop = (await stopResponse.json()) as { recordingId: string; eventCount: number; filePath: string }
    expect(stop.recordingId).toBe(start.recordingId)
    expect(stop.eventCount).toBeGreaterThan(3)

    const events = parseRecording(fs.readFileSync(stop.filePath, 'utf-8'))

    // recorded actions carry generated locator code
    const actionCodes = events.filter((e) => e.type === 'action').map((e) => e.code)
    expect(actionCodes).toMatchInlineSnapshot(`
      [
        "await page1.getByRole('button', { name: 'Submit order' }).click();",
        "await page1.getByRole('textbox', { name: 'Email address' }).click();",
        "await page1.getByRole('textbox', { name: 'Email address' }).fill('hi@example.com');",
        "await page1.getByRole('button', { name: 'Attachment' }).setInputFiles('recorder-test-attachment.txt');",
        "await page1.getByRole('button', { name: 'Done!' }).click();",
      ]
    `)

    const types = new Set(events.map((e) => e.type))
    expect(types.has('recording-started')).toBe(true)
    expect(types.has('recording-stopped')).toBe(true)
    expect(types.has('snapshot-diff')).toBe(false)
    expect(types.has('storage')).toBe(false)
    expect(types.has('focus')).toBe(false)
    expect(types.has('screenshot')).toBe(false)
    const clickActions = events.filter((e) => e.type === 'action' && e.action === 'click')
    expect(clickActions.length).toBeGreaterThan(0)
    expect(clickActions[0].button).toBe('left')
    expect(clickActions[0].x).toBeUndefined()
    const fillActions = events.filter((e) => e.type === 'action' && e.action === 'fill')
    expect(fillActions[0].text).toBe('hi@example.com')
    // console.error was recorded
    const consoleEvents = events.filter((e) => e.type === 'console')
    expect(JSON.stringify(consoleEvents)).toContain('recorder-test-error')
    // mutating in-page fetch captured with its textual response body
    const fetchEvents = events.filter((e) => e.type === 'network' && e.resourceType === 'fetch')
    expect(fetchEvents.length).toBeGreaterThan(0)
    expect(fetchEvents.every((e) => e.method === 'POST')).toBe(true)
    expect(JSON.stringify(fetchEvents)).not.toContain('get-should-be-dropped')
    expect(JSON.stringify(fetchEvents)).toContain('Example Domain')
    const uploadActions = events.filter((e) => e.type === 'action' && String(e.code).includes('setInputFiles'))
    expect(JSON.stringify(uploadActions)).toContain('recorder-test-attachment.txt')
    expect(uploadActions[0].files).toEqual(['recorder-test-attachment.txt'])
    // every event has a sequential id for the drill-down view
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1))
    // thin projection replaces heavy payloads with sizes
    const thinFetch = projectThinEvent(fetchEvents[0])
    expect(thinFetch.responseBody).toBeUndefined()
    expect(typeof thinFetch.responseBodySize).toBe('number')

    // stopping again → 404, no active recording
    const stopAgainResponse = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    expect(stopAgainResponse.status).toBe(404)

    // events are also served over HTTP for remote relays
    const eventsResponse = await fetch(`${SERVER_URL}/recorder/events/${start.recordingId}`)
    expect(eventsResponse.status).toBe(200)
    const remoteEvents = parseRecording(await eventsResponse.text())
    expect(remoteEvents.length).toBe(stop.eventCount)

    // ── second recording on the same session must record actions again ──
    // (regression test for the fork fix: re-enabling the recorder used to
    // leave the cached server recorder in mode 'none')
    const start2Response = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    const start2 = (await start2Response.json()) as { recordingId: string }
    expect(start2.recordingId).not.toBe(start.recordingId)

    await new Promise((r) => setTimeout(r, 300))
    await clickAt('#submit-btn')
    await new Promise((r) => setTimeout(r, 2000))

    const stop2Response = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const stop2 = (await stop2Response.json()) as { filePath: string }
    const events2 = parseRecording(fs.readFileSync(stop2.filePath, 'utf-8'))
    const actions2 = events2.filter((e) => e.type === 'action')
    // exactly one action: duplicate listeners in the fork would produce doubles
    expect(actions2.map((e) => e.code)).toMatchInlineSnapshot(`
      [
        "await page1.getByRole('button', { name: 'Done!' }).click();",
      ]
    `)

    // SPA pushState mid-fill must stay one action with the final text
    const start3Response = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    const start3 = (await start3Response.json()) as { recordingId: string }
    expect(start3.recordingId).toBeTruthy()
    await cdpPage!.evaluate(`
      document.body.innerHTML = '<input id="q" placeholder="Search" type="text" />'
      const input = document.getElementById('q')
      input.addEventListener('input', () => {
        if (input.value.length >= 2) history.pushState({}, '', '/changed')
      })
    `)
    await clickAt('#q')
    await cdp.send('Input.insertText', { text: 'a' })
    await new Promise((r) => setTimeout(r, 50))
    await cdp.send('Input.insertText', { text: 'b' })
    await new Promise((r) => setTimeout(r, 50))
    await cdp.send('Input.insertText', { text: 'c' })
    await new Promise((r) => setTimeout(r, 1500))
    const stop3Response = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const stop3 = (await stop3Response.json()) as { filePath: string }
    const events3 = parseRecording(fs.readFileSync(stop3.filePath, 'utf-8'))
    const fills3 = events3.filter((e) => e.type === 'action' && e.action === 'fill')
    expect(fills3.map((e) => e.code)).toEqual(["await page1.getByRole('textbox', { name: 'Search' }).fill('abc');"])
    expect(fills3[0].text).toBe('abc')

    await browser.close()
  }, 120000)

  it('records one click when a second CDP client also enables the recorder', async () => {
    const browserContext = testCtx!.browserContext
    const serviceWorker = await getExtensionServiceWorker(browserContext)

    const page = await browserContext.newPage()
    await page.goto('https://example.com/')
    await page.bringToFront()
    await serviceWorker.evaluate(async () => {
      await globalThis.toggleExtensionForActiveTab()
    })
    await new Promise((r) => setTimeout(r, 200))

    const sessionResponse = await fetch(`${SERVER_URL}/cli/session/new`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({}),
    })
    const session = (await sessionResponse.json()) as { id: string }
    expect(session.id).toBeTruthy()

    const startResponse = await fetch(`${SERVER_URL}/recorder/start`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ sessionId: session.id }),
    })
    const start = (await startResponse.json()) as { recordingId: string; error?: string }
    expect(start.error).toBeUndefined()

    const extraBrowser = await chromium.connectOverCDP(getCdpUrl({ port: TEST_PORT }))
    const extraContext = extraBrowser.contexts()[0]
    expect(extraContext).toBeDefined()
    await extraContext._enableRecorder({
      language: 'javascript',
      mode: 'recording',
      recorderMode: 'api',
    }, {
      actionAdded: () => {},
      actionUpdated: () => {},
    })

    const cdpPage = extraContext!
      .pages()
      .find((p) => p.url().includes('example.com'))
    expect(cdpPage).toBeDefined()
    await cdpPage!.evaluate(() => {
      document.body.innerHTML = `<button id="only-once">Only once</button>`
    })
    const cdp = await getCDPSessionForPage({ page: cdpPage! })
    const box = await cdpPage!.locator('#only-once').boundingBox()
    expect(box).toBeTruthy()
    const x = box!.x + box!.width / 2
    const y = box!.y + box!.height / 2
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
    await new Promise((r) => setTimeout(r, 1500))

    const stopResponse = await fetch(`${SERVER_URL}/recorder/stop`, {
      method: 'POST',
      headers: jsonHeaders,
      body: JSON.stringify({ recordingId: start.recordingId }),
    })
    const stop = (await stopResponse.json()) as { filePath: string }
    const events = parseRecording(fs.readFileSync(stop.filePath, 'utf-8'))
    const clicks = events.filter((e) => e.type === 'action' && e.action === 'click')
    expect(clicks.map((e) => e.code)).toEqual([
      "await page1.getByRole('button', { name: 'Only once' }).click();",
    ])

    await extraBrowser.close()
  }, 120000)
})
