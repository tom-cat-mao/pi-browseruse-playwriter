#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import url from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const HERE = path.dirname(url.fileURLToPath(import.meta.url))
const WORKTREE = path.resolve(HERE, '..', '..')

const runtimeUrl = process.env.PI_BROWSER_RUNTIME_URL
const expectedVersion = process.env.PI_FIREFOX_EXPECT_VERSION
if (!runtimeUrl || !expectedVersion) {
  console.error('PI_BROWSER_RUNTIME_URL and PI_FIREFOX_EXPECT_VERSION are required; nothing was contacted.')
  process.exit(2)
}
const RUNTIME = new URL(runtimeUrl)
if (RUNTIME.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(RUNTIME.hostname)) {
  console.error(`Refusing to run against non-loopback runtime ${RUNTIME.origin}`)
  process.exit(2)
}
const EXPECTED_VERSION = expectedVersion
const REQUEST_TIMEOUT_MS = 3000
const TRANSPORT_TIMEOUT_MS = 5000
const ASSERT_WAIT_MS = 5000
const POLL_INTERVAL_MS = 200
const SAMPLES_PER_CONDITION = 3
const ONLY = (process.env.PI_DIAG_ONLY ?? '').split(',').map((entry) => entry.trim()).filter(Boolean)
const HARNESS_FILE = path.join(HERE, 'firefox-swarm-acceptance.mjs')

const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
const evidenceDir = path.join(WORKTREE, 'tmp', 'firefox-swarm-acceptance', `snapshot-ref-diagnosis-${runStamp}`)
fs.mkdirSync(evidenceDir, { recursive: true })

const sessionId = crypto.randomUUID()
const created = { groups: new Set(), tabs: new Set() }
const diagEvents = []
const evidence = {
  kind: 'snapshot-ref-diagnosis',
  runtime: RUNTIME.origin,
  expectedVersion: EXPECTED_VERSION,
  sessionId,
  startedAt: new Date().toISOString(),
  preflight: null,
  fixtures: null,
  conditions: [],
  samples: [],
  cleanup: [],
  summary: null,
}

function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize)
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, entry] of Object.entries(value)) {
      if (/token|ticket|secret|cookie|password|authorization/i.test(key)) out[key] = '[redacted]'
      else out[key] = sanitize(entry)
    }
    return out
  }
  return value
}

async function httpJson(method, pathname, body, { timeoutMs = REQUEST_TIMEOUT_MS, base = RUNTIME } = {}) {
  const started = Date.now()
  try {
    const response = await fetch(new URL(pathname, base), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await response.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { parseError: text.slice(0, 400) }
    }
    return { httpStatus: response.status, json, durationMs: Date.now() - started }
  } catch (error) {
    return { httpStatus: 0, json: null, durationMs: Date.now() - started, networkError: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }
  }
}

async function send(operation, { timeoutMs = REQUEST_TIMEOUT_MS, transportMs = TRANSPORT_TIMEOUT_MS } = {}) {
  const requestId = crypto.randomUUID()
  const result = await httpJson('POST', '/browser/v1/request', { requestId, sessionId, timeoutMs, operation }, { timeoutMs: transportMs })
  return { requestId, operation: sanitize(operation), ...result }
}

async function envSnapshot() {
  const [status, profiles] = await Promise.all([
    httpJson('GET', '/extensions/status', undefined, { timeoutMs: 3000 }),
    httpJson('GET', '/browser/v1/profiles', undefined, { timeoutMs: 3000 }),
  ])
  const extension = (status.json?.extensions ?? []).find((entry) => entry.stableKey === `install:Firefox:${evidence.preflight?.profileId}`)
  const profile = (profiles.json?.profiles ?? []).find((entry) => entry.profileId === evidence.preflight?.profileId)
  return { at: new Date().toISOString(), connected: profile?.connected ?? false, epoch: profile?.browserEpoch ?? null, connectionId: extension?.extensionId ?? null, version: extension?.playwriterVersion ?? null }
}

const DIAG_SCRIPT = [
  '(function () {',
  '  var nonce = Math.random().toString(36).slice(2) + "-" + Date.now();',
  '  function report(kind, detail) {',
  '    try {',
  '      fetch("/diag/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: nonce, kind: kind, href: location.href, title: document.title, at: Date.now(), detail: detail }) });',
  '    } catch (e) {}',
  '  }',
  '  report("init", { readyState: document.readyState });',
  '  try {',
  '    var mo = new MutationObserver(function (records) {',
  '      var sample = records.slice(0, 20).map(function (r) {',
  '        return { type: r.type, target: r.target && r.target.nodeName ? r.target.nodeName.toLowerCase() : null, attr: r.attributeName || null, added: r.addedNodes ? r.addedNodes.length : 0, removed: r.removedNodes ? r.removedNodes.length : 0 };',
  '      });',
  '      report("mutation", { count: records.length, sample: sample });',
  '    });',
  '    mo.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });',
  '  } catch (e) { report("mo-error", String(e)); }',
  '  window.addEventListener("DOMContentLoaded", function () { report("domcontentloaded", {}); });',
  '  window.addEventListener("load", function () { report("load", {}); });',
  '  window.addEventListener("pagehide", function () { report("pagehide", {}); });',
  '})();',
].join('\n')

function diagTag() {
  return `<script>\n${DIAG_SCRIPT}\n</script>`
}

function staticHtml() {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8"><title>Static probe</title></head>',
    '<body>',
    '<label>Controlled name <input id="controlled-name" aria-label="Controlled name" value="Alice"></label>',
    diagTag(),
    '</body></html>',
  ].join('\n')
}

function complexHtml(crossOrigin) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Complex probe</title></head>
<body>
<label>Controlled name <input id="controlled-name" aria-label="Controlled name" value="Alice"></label>
<section id="frame-shadow-section">
 <div id="shadow-host"></div>
 <iframe id="local-frame" title="Local frame" src="/frame.html"></iframe>
 <iframe id="cross-frame" title="Cross-origin frame" src="${crossOrigin}/child.html"></iframe>
 <iframe id="padded-frame" title="Padded frame" src="/frame2.html" style="border:12px solid #333;padding:18px;width:320px;height:170px"></iframe>
 <span id="occluded-wrap" style="position:relative;display:inline-block"><iframe id="occluded-frame" title="Occluded frame" src="/frame3.html" style="width:320px;height:160px"></iframe><span id="occluder" style="position:absolute;inset:0;background:#0009;z-index:5"></span></span>
 <iframe id="scaled-frame" title="Scaled frame" src="/frame2.html" style="width:320px;height:170px;transform:perspective(420px) scale(1.3) rotate(7deg);transform-origin:top left"></iframe>
 <iframe id="fraction-frame" title="Fractional frame" src="/frame2.html" style="border:1.5px solid #333;padding:9.5px;margin-left:0.5px;width:319.5px;height:169.5px"></iframe>
</section>
<script>
 const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
 shadow.innerHTML = '<label>Shadow name <input id="shadow-input" value="Inside shadow"></label>';
</script>
${diagTag()}
</body></html>`
}

function frameHtml(title) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
<h2 id="frame-heading">${title} heading</h2>
<label>Frame name <input id="frame-input" value="Inside frame"></label>
${diagTag()}
</body></html>`
}

function realIndexHtml(crossOrigin) {
  const source = fs.readFileSync(HARNESS_FILE, 'utf8')
  const start = source.indexOf('function indexHtml(')
  if (start < 0) throw new Error('indexHtml not found in the acceptance harness')
  const open = source.indexOf('`', start)
  const close = source.indexOf('`', open + 1)
  const template = source.slice(open + 1, close)
  const build = new Function('crossOrigin', 'FIXTURE_TITLE', `return \`${template}\`;`)
  const html = build(crossOrigin, 'Pi Firefox swarm acceptance fixture')
  if (!html.startsWith('<!doctype html>') || !html.includes('id="shadow-host"')) throw new Error('extracted fixture is incomplete')
  return html.replace('</body>', `${diagTag()}\n</body>`)
}

function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port, origin: `http://127.0.0.1:${address.port}` })
    })
  })
}

function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}

function readBody(request) {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => resolve(body))
  })
}

function recordDiag(body) {
  try {
    const parsed = JSON.parse(body)
    diagEvents.push({ rx: Date.now(), nonce: parsed.nonce, kind: parsed.kind, href: parsed.href, title: parsed.title, at: parsed.at, detail: parsed.detail })
  } catch {
    diagEvents.push({ rx: Date.now(), parseError: body.slice(0, 200) })
  }
}

async function preflight() {
  const [status, profiles] = await Promise.all([
    httpJson('GET', '/extensions/status'),
    httpJson('GET', '/browser/v1/profiles'),
  ])
  const firefoxExtensions = (status.json?.extensions ?? []).filter((entry) => entry.browser === 'Firefox')
  const connected = (profiles.json?.profiles ?? []).filter((entry) => entry.browser === 'Firefox' && entry.connected === true)
  evidence.preflight = {
    extensionsHttp: status.httpStatus,
    profilesHttp: profiles.httpStatus,
    firefoxExtensionCount: firefoxExtensions.length,
    firefoxExtensions,
    connectedFirefoxProfileIds: connected.map((entry) => entry.profileId),
  }
  if (connected.length !== 1) return { blocked: `expected exactly one connected Firefox profile, got ${connected.length}` }
  const profile = connected[0]
  evidence.preflight.profileId = profile.profileId
  evidence.preflight.epoch = profile.browserEpoch
  const matching = firefoxExtensions.filter((entry) => entry.stableKey === `install:Firefox:${profile.profileId}`)
  if (matching.length !== 1) return { blocked: 'extension status does not map to the connected profile' }
  evidence.preflight.connectionId = matching[0].extensionId
  evidence.preflight.version = matching[0].playwriterVersion
  if (matching[0].playwriterVersion !== EXPECTED_VERSION) return { blocked: `extension version ${matching[0].playwriterVersion} != ${EXPECTED_VERSION}` }
  return { blocked: null, profileId: profile.profileId }
}

async function createGroupWithRecovery(name) {
  const attempt = await send({ kind: 'groups.create', profileId: evidence.preflight.profileId, name })
  if (attempt.json?.ok === true && typeof attempt.json.data?.group?.groupId === 'string') {
    created.groups.add(attempt.json.data.group.groupId)
    return attempt.json.data.group.groupId
  }
  const listed = await send({ kind: 'groups.list' })
  const found = (listed.json?.data?.groups ?? []).find((group) => group.name === name && group.groupId)
  if (found) created.groups.add(found.groupId)
  return found?.groupId ?? null
}

async function createTabWithRecovery(groupId, targetUrl) {
  const attempt = await send({ kind: 'tabs.create', groupId, url: targetUrl })
  if (attempt.json?.ok === true && typeof attempt.json.data?.tab?.tabId === 'string') {
    created.tabs.add(attempt.json.data.tab.tabId)
    return attempt.json.data.tab
  }
  const listed = await send({ kind: 'tabs.list', groupId })
  const found = (listed.json?.data?.tabs ?? []).find((tab) => typeof tab.url === 'string' && tab.url.startsWith(targetUrl.split('?')[0]))
  if (found) created.tabs.add(found.tabId)
  return found ?? null
}

async function waitFor(predicate, { timeoutMs = ASSERT_WAIT_MS, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await predicate()
    if (last?.done) return last
    await delay(intervalMs)
  }
  return last ?? { done: false }
}

async function waitForTabUrl(tabId, predicate, { timeoutMs = ASSERT_WAIT_MS, intervalMs = 150 } = {}) {
  return waitFor(async () => {
    const resolved = await send({ kind: 'tab.resolve', tabId })
    const tab = resolved.json?.data?.tab
    return tab && predicate(tab.url ?? '') ? { done: true, tab } : { done: false, tab }
  }, { timeoutMs, intervalMs })
}

const CONDITIONS = [
  { id: 'static-url', page: 'static.html', ready: 'url', label: 'static fixture, URL-ready' },
  { id: 'static-load', page: 'static.html', ready: 'load', label: 'static fixture, waitForLoadState(load)' },
  { id: 'complex-url', page: 'complex.html', ready: 'url', label: 'replica complex fixture (iframes+shadow), URL-ready' },
  { id: 'complex-load', page: 'complex.html', ready: 'load', label: 'replica complex fixture (iframes+shadow), waitForLoadState(load)' },
  { id: 'complex-real-url', page: 'real.html', ready: 'url', label: 'real harness index.html fixture, URL-ready' },
  { id: 'complex-real-load', page: 'real.html', ready: 'load', label: 'real harness index.html fixture, waitForLoadState(load)' },
].filter((condition) => ONLY.length === 0 || ONLY.includes(condition.id))

async function runSample({ condition, index, primary, groupId }) {
  const targetUrl = `${primary.origin}/${condition.page}`
  const startEnv = await envSnapshot()
  const tab = await createTabWithRecovery(groupId, targetUrl)
  const sample = {
    condition: condition.id,
    index,
    targetUrl,
    tabId: tab?.tabId ?? null,
    createdAt: new Date().toISOString(),
    startEnv,
    readiness: null,
    snapshots: [],
    measuredSnapshotId: null,
    ref: null,
    fill: null,
    fillAt: null,
    eventsInWindow: [],
    eventsAfterFill: [],
    endEnv: null,
  }
  if (!tab?.tabId) {
    sample.error = 'tab creation failed'
    evidence.samples.push(sample)
    return sample
  }

  if (condition.ready === 'url') {
    const settled = await waitForTabUrl(tab.tabId, (current) => current.startsWith(primary.origin))
    sample.readiness = { mode: 'tab.resolve-url-settle', done: settled.done === true, url: settled.tab?.url ?? null }
    const ready = await waitFor(async () => {
      const snap = await send({ kind: 'page.snapshot', tabId: tab.tabId })
      const refs = snap.json?.data?.value?.refs ?? []
      const nameRef = refs.find((entry) => entry.name === 'Controlled name')
      sample.snapshots.push({ requestId: snap.requestId, at: new Date().toISOString(), startedAt: new Date(Date.now() - snap.durationMs).toISOString(), ok: snap.json?.ok === true, snapshotId: snap.json?.data?.snapshotId ?? null, durationMs: snap.durationMs, refCount: refs.length, hasNameRef: Boolean(nameRef), error: snap.json?.error ?? null })
      return snap.json?.ok === true && nameRef ? { done: true, snap, nameRef } : { done: false, snap, nameRef }
    })
    if (ready.done === true) {
      sample.measuredSnapshotId = ready.snap.json?.data?.snapshotId ?? null
      sample.ref = ready.nameRef?.ref ?? null
      sample.measuredSnapshotAt = sample.snapshots[sample.snapshots.length - 1].startedAt
    }
  } else {
    const exec = await send({ kind: 'page.execute', tabId: tab.tabId, code: `await page.waitForURL(${JSON.stringify(targetUrl)}); await page.waitForLoadState('load'); return page.url()` })
    sample.readiness = { mode: 'execute.waitForURL+waitForLoadState', ok: exec.json?.ok === true, value: exec.json?.data?.value ?? null, durationMs: exec.durationMs, error: exec.json?.error ?? null }
    const snap = await send({ kind: 'page.snapshot', tabId: tab.tabId })
    const refs = snap.json?.data?.value?.refs ?? []
    const nameRef = refs.find((entry) => entry.name === 'Controlled name')
    sample.snapshots.push({ requestId: snap.requestId, at: new Date().toISOString(), startedAt: new Date(Date.now() - snap.durationMs).toISOString(), ok: snap.json?.ok === true, snapshotId: snap.json?.data?.snapshotId ?? null, durationMs: snap.durationMs, refCount: refs.length, hasNameRef: Boolean(nameRef), error: snap.json?.error ?? null })
    if (snap.json?.ok === true && nameRef) {
      sample.measuredSnapshotId = snap.json?.data?.snapshotId ?? null
      sample.ref = nameRef.ref
      sample.measuredSnapshotAt = sample.snapshots[sample.snapshots.length - 1].startedAt
    }
  }

  if (sample.measuredSnapshotId && sample.ref) {
    const measuredAt = Date.parse(sample.measuredSnapshotAt)
    const fill = await send({ kind: 'page.fill', tabId: tab.tabId, selector: `aria-ref=${sample.ref}`, snapshotId: sample.measuredSnapshotId, value: 'RefProbe' })
    sample.fillAt = Date.now()
    sample.fill = {
      requestId: fill.requestId,
      ok: fill.json?.ok === true,
      error: fill.json?.error ?? null,
      networkError: fill.networkError ?? null,
      durationMs: fill.durationMs,
      httpStatus: fill.httpStatus,
    }
    sample.window = { from: measuredAt, to: sample.fillAt }
  } else {
    sample.fill = { skipped: 'no measured snapshot with the Controlled name ref' }
    sample.window = null
  }

  await delay(300)
  const windowFrom = sample.window ? sample.window.from - 20 : null
  const windowTo = sample.window ? sample.window.to : null
  sample.eventsInWindow = windowFrom === null ? [] : diagEvents.filter((event) => event.rx >= windowFrom && event.rx <= windowTo)
  sample.eventsAfterFill = diagEvents.filter((event) => windowTo !== null && event.rx > windowTo && event.rx <= windowTo + 1000)
  sample.endEnv = await envSnapshot()
  evidence.samples.push(sample)
  return sample
}

let primary = null
let secondary = null
let groupId = null
let blocked = null

try {
  primary = await startServer(async (request, response) => {
    const requestUrl = new URL(request.url, primary.origin)
    if (requestUrl.pathname === '/diag/log' && request.method === 'POST') {
      recordDiag(await readBody(request))
      response.writeHead(204)
      response.end()
      return
    }
    if (requestUrl.pathname === '/diag/events') {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(diagEvents))
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    if (requestUrl.pathname === '/static.html') response.end(staticHtml())
    else if (requestUrl.pathname === '/complex.html') response.end(complexHtml(secondary.origin))
    else if (requestUrl.pathname === '/real.html') response.end(realIndexHtml(secondary.origin))
    else if (requestUrl.pathname === '/frame2.html') response.end(frameHtml('Padded frame'))
    else if (requestUrl.pathname === '/frame3.html') response.end(frameHtml('Occluded frame'))
    else response.end(frameHtml('Local frame'))
  })
  secondary = await startServer(async (request, response) => {
    const requestUrl = new URL(request.url, secondary.origin)
    if (requestUrl.pathname === '/diag/log' && request.method === 'POST') {
      recordDiag(await readBody(request))
      response.writeHead(204)
      response.end()
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(frameHtml('Cross-origin child'))
  })
  evidence.fixtures = { primary: primary.origin, secondary: secondary.origin }
  console.log(`fixture primary ${primary.origin} secondary ${secondary.origin}`)

  const pre = await preflight()
  blocked = pre.blocked
  if (!blocked) {
    groupId = await createGroupWithRecovery(`snapshot-ref-diagnosis ${runStamp}`)
    if (!groupId) {
      blocked = 'group creation failed'
    } else {
      for (const condition of CONDITIONS) {
        evidence.conditions.push({ id: condition.id, label: condition.label, page: condition.page, ready: condition.ready, samples: SAMPLES_PER_CONDITION })
        for (let index = 1; index <= SAMPLES_PER_CONDITION; index++) {
          const sample = await runSample({ condition, index, primary, groupId })
          console.log(`[${condition.id} #${index}] tab=${sample.tabId} ref=${sample.ref} fill=${sample.fill?.ok === true ? 'ok' : JSON.stringify(sample.fill?.error ?? sample.fill)} inWindowEvents=${sample.eventsInWindow.map((event) => `${event.href?.split('/').pop()}:${event.kind}`).join(',') || 'none'}`)
        }
      }
      // cleanup tabs, then group
      for (const tabId of [...created.tabs]) {
        const result = await send({ kind: 'tabs.close', tabId })
        evidence.cleanup.push({ kind: 'tab', tabId, ok: result.json?.ok === true, error: result.json?.error ?? null })
      }
      for (const id of [...created.groups]) {
        const result = await send({ kind: 'groups.close', groupId: id })
        evidence.cleanup.push({ kind: 'group', groupId: id, ok: result.json?.ok === true, error: result.json?.error ?? null })
      }
      const remaining = await send({ kind: 'tabs.list' })
      evidence.cleanupRemaining = (remaining.json?.data?.tabs ?? []).map((tab) => ({ tabId: tab.tabId, state: tab.state, url: tab.url }))
      const discovered = await send({ kind: 'tabs.discover', profileId: evidence.preflight.profileId })
      evidence.cleanupLeftoverFixtures = (discovered.json?.data?.candidates ?? []).filter((entry) => typeof entry.url === 'string' && entry.url.startsWith(primary.origin))
    }
  }
} catch (error) {
  console.error(`diagnosis harness error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  blocked = blocked ?? `harness error: ${error instanceof Error ? error.message : String(error)}`
} finally {
  if (primary) await closeServer(primary.server)
  if (secondary) await closeServer(secondary.server)
}

const byCondition = {}
for (const sample of evidence.samples) {
  const entry = (byCondition[sample.condition] ??= { total: 0, stale: 0, ok: 0, inWindowEvents: 0 })
  entry.total += 1
  const code = sample.fill?.error?.code ?? null
  if (code === 'stale-snapshot') entry.stale += 1
  else if (sample.fill?.ok === true) entry.ok += 1
  if ((sample.eventsInWindow ?? []).length > 0) entry.inWindowEvents += 1
}
evidence.summary = {
  blocked,
  byCondition,
  staleSummary: evidence.samples
    .filter((sample) => sample.fill?.error?.code === 'stale-snapshot')
    .map((sample) => ({ condition: sample.condition, index: sample.index, error: sample.fill.error, eventsInWindow: (sample.eventsInWindow ?? []).map((event) => ({ href: event.href, kind: event.kind, rx: event.rx })) })),
}
evidence.finishedAt = new Date().toISOString()
fs.writeFileSync(path.join(evidenceDir, 'diagnosis.json'), JSON.stringify({ evidence, diagEvents }, null, 2))
console.log(JSON.stringify({ blocked, byCondition, evidence: path.join(evidenceDir, 'diagnosis.json') }))
process.exitCode = blocked ? 1 : 0
