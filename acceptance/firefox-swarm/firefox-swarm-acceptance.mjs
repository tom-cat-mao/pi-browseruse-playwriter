#!/usr/bin/env node

import crypto from 'node:crypto'
import dns from 'node:dns/promises'
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
  console.error('PI_BROWSER_RUNTIME_URL and PI_FIREFOX_EXPECT_VERSION are required (no implicit defaults); nothing was contacted.')
  process.exit(2)
}

const RUNTIME = new URL(runtimeUrl)
const EXPECTED_VERSION = expectedVersion
const SKIP_IDLE = process.env.PI_ACCEPT_SKIP_IDLE === '1'

const REQUEST_TIMEOUT_MS = 3000
const TRANSPORT_TIMEOUT_MS = 5000
const ASSERT_WAIT_MS = 5000
const POLL_INTERVAL_MS = 250
const IDLE_SAMPLE_COUNT = 24
const IDLE_INTERVAL_MS = 4000

if (RUNTIME.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(RUNTIME.hostname)) {
  console.error(`Refusing to run against non-loopback runtime ${RUNTIME.origin}`)
  process.exit(2)
}

const runStamp = new Date().toISOString().replace(/[:.]/g, '-')
const evidenceDir = path.join(WORKTREE, 'tmp', 'firefox-swarm-acceptance', `evidence-${runStamp}`)
fs.mkdirSync(evidenceDir, { recursive: true })

const sessionId = crypto.randomUUID()
const secondSessionId = crypto.randomUUID()

const RETEST_WATCH_ITEMS = [
  'inject/attach must not ignore frame-level executeScript.error or a missing target frame',
  'frame routing/injection wait paths must observe cancellation after the wait',
  'tab resolve/persist path must observe cancellation after persistence',
  'tabs.create must persist the native tabId in the request context so the post-create release check is not weakened',
  'network concurrent in-flight chunks are not counted against the 2 MiB total budget; budget unit is raw in-flight bytes + retained UTF-8 bytes, not an OS memory cap (owner is fixing the real logic)',
  'network response filter forwarding must be complete even when the recorded body is truncated — covered by the network-filter suite (bounded concurrency, UTF-8, large body, stop/restart)',
  'iframe getBoxQuads: no-transform, exactly provable client/rect/border/padding boxes only; fractional/transformed/scaled geometry must be explicitly refused. iframe-geometry re-checks the positive no-transform case plus occlusion and geometry-negatives',
  'console bridge: firefox-dom.ts original.apply(pageView.console, args) with a content-script rest array (platform owner)',
  'open shadow DOM: compound cross-shadow CSS is an explicit non-goal this round (per-root native CSS; cross-host via chained/role/label/text). Chained traversal is required and must actually succeed; the two are asserted separately',
  'non-secure HTTP origin: DOM driver must not depend on view.crypto.randomUUID (SecureContext) — owner switching to getRandomValues',
  'page.back response pageInfo.url must equal the completed navigation URL (Codex fix); re-check returned data against page.url()',
  'navigation chain: page.navigate must follow post-commit meta refresh / location.replace to the final document and return the real final pageInfo.url; load-time history.replaceState or hash change must settle (no wait on a load that already fired); same-document fragment and back included',
  'cancellation: a real request.cancel of a delayed page.execute must return a structured result and must not late-dispatch the action; verified with a fixture counter plus a positive control. NOT a reproduction of the frame-injection race',
  'network: page realm must confirm complete original receipt (large body + UTF-8); retained capture bytes do not prove the in-flight memory budget, which is pure-logic provable only',
  'transient new-tab injection race (about:blank/document swap during create) — NOT RUN unless a real deterministic trigger exists',
]
const evidence = {
  kind: 'firefox-swarm-acceptance',
  runtime: RUNTIME.origin,
  expectedVersion: EXPECTED_VERSION,
  sessionId,
  secondSessionId,
  startedAt: new Date().toISOString(),
  preflight: null,
  results: [],
  findings: [],
  retestWatchItems: RETEST_WATCH_ITEMS,
  requests: [],
  samples: [],
  cleanup: [],
  summary: null,
}

const created = { groups: new Set(), tabs: new Set(), attachedGroups: new Set(), attachedTabs: new Set() }

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

function record(area, name, status, details = {}) {
  const entry = { area, name, status, at: new Date().toISOString(), ...details }
  evidence.results.push(entry)
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP'
  console.log(`[${mark}] ${area} :: ${name}${details.note ? ` — ${details.note}` : ''}`)
  return entry
}

function check(area, name, condition, details = {}) {
  return record(area, name, condition ? 'PASS' : 'FAIL', {
    expected: details.expected,
    actual: details.actual,
    request: details.request,
    error: details.error,
    minimalRepro: details.minimalRepro,
    note: details.note,
  })
}

function skip(area, name, details = {}) {
  return record(area, name, 'SKIP', details)
}

function finding(area, title, details = {}) {
  const entry = { area, title, at: new Date().toISOString(), ...details }
  evidence.findings.push(entry)
  console.log(`[FINDING] ${area} :: ${title}${details.note ? ` — ${details.note}` : ''}`)
  return entry
}

async function httpJson(method, pathname, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now()
  try {
    const response = await fetch(new URL(pathname, RUNTIME), {
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
    return {
      httpStatus: 0,
      json: null,
      durationMs: Date.now() - started,
      networkError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }
  }
}

async function send(session, operation, { timeoutMs = REQUEST_TIMEOUT_MS, transportMs = TRANSPORT_TIMEOUT_MS, area = 'request' } = {}) {
  const requestId = crypto.randomUUID()
  const body = { requestId, sessionId: session, timeoutMs, operation }
  const result = await httpJson('POST', '/browser/v1/request', body, { timeoutMs: transportMs })
  const entry = {
    at: new Date().toISOString(),
    area,
    requestId,
    sessionId,
    operation: sanitize(operation),
    deadlineMs: timeoutMs,
    transportMs,
    httpStatus: result.httpStatus,
    durationMs: result.durationMs,
    ok: result.json?.ok === true,
    error: result.json?.ok === false ? sanitize(result.json.error) : undefined,
    networkError: result.networkError,
  }
  evidence.requests.push(entry)
  return { requestId, operation, ...result }
}

async function runtimeGet(pathname, { timeoutMs = 3000 } = {}) {
  return httpJson('GET', pathname, undefined, { timeoutMs })
}

const FIXTURE_TITLE = 'Pi Firefox swarm acceptance fixture'

function indexHtml({ crossOrigin }) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${FIXTURE_TITLE}</title>
<style>
 body{font:16px system-ui;margin:24px auto;max-width:900px;padding:0 20px}
 section{border:1px solid #bbb;border-radius:8px;padding:16px;margin:16px 0}
 label{display:block;margin:10px 0}
 input,textarea,select,button{font:inherit;padding:6px}
 pre{white-space:pre-wrap;overflow-wrap:anywhere}
 .covered{position:relative;display:inline-block}
 .cover{position:absolute;inset:0;background:#ddd8;z-index:2}
 #scroll-target{margin-top:1200px}
</style></head>
<body>
<h1 id="page-heading">${FIXTURE_TITLE}</h1>
<p id="build-marker">harness fixture, fixture-owned data only</p>

<section id="form-section">
 <h2>Form controls</h2>
 <label>Existing note <input id="existing-note" value="Keep this text while attaching"></label>
 <label>Controlled name <input id="controlled-name" data-testid="controlled-name" value="Alice"></label>
 <label>Notes <textarea id="notes">Initial notes</textarea></label>
 <label><input id="enabled-feature" type="checkbox"> Enable feature</label>
 <label>Choice <select id="choice"><option value="alpha">Alpha</option><option value="beta">Beta</option><option value="gamma">Gamma</option></select></label>
 <div id="rich-text" role="textbox" aria-label="Rich text" contenteditable="true">Initial rich text</div>
 <button id="submit">Save values</button>
 <pre id="saved-values" aria-live="polite"></pre>
</section>

<section id="strict-section">
 <h2>Strict selectors and hidden state</h2>
 <button id="dup-one" aria-label="Duplicate">First duplicate</button>
 <button id="dup-two" aria-label="Duplicate">Second duplicate</button>
 <button id="disabled-action" disabled>Disabled action</button>
 <button id="hidden-action" hidden>Hidden action</button>
 <div id="aria-hidden-area" aria-hidden="true"><button id="aria-hidden-action">Aria hidden action</button></div>
 <div id="inert-area" inert><button id="inert-action">Inert action</button></div>
 <div class="covered" id="covered-wrap"><button id="covered-action">Covered action</button><div class="cover"></div></div>
 <div id="replace-area"><button id="replaceable">Original element</button></div>
 <button id="replace">Replace the original element</button>
</section>

<section id="frame-shadow-section">
 <h2>Frames and shadow DOM</h2>
 <div id="shadow-host"></div>
 <iframe id="local-frame" title="Local frame" src="/frame.html"></iframe>
 <iframe id="cross-frame" title="Cross-origin frame" src="${crossOrigin}/child.html"></iframe>
 <iframe id="padded-frame" title="Padded frame" src="/frame2.html" style="border:12px solid #333;padding:18px;width:320px;height:170px"></iframe>
 <span id="occluded-wrap" style="position:relative;display:inline-block">
  <iframe id="occluded-frame" title="Occluded frame" src="/frame3.html" style="width:320px;height:160px"></iframe>
  <span id="occluder" style="position:absolute;inset:0;background:#0009;z-index:5"></span>
 </span>
 <iframe id="scaled-frame" title="Scaled frame" src="/frame2.html" style="width:320px;height:170px;transform:perspective(420px) scale(1.3) rotate(7deg);transform-origin:top left"></iframe>
 <iframe id="fraction-frame" title="Fractional frame" src="/frame2.html" style="border:1.5px solid #333;padding:9.5px;margin-left:0.5px;width:319.5px;height:169.5px"></iframe>
</section>

<section id="nav-section">
 <h2>Navigation, new tabs, network and logs</h2>
 <a id="new-tab" target="_blank" href="?child=1">Open fixture child</a>
 <a id="history-link" href="?history=next">Navigate within fixture</a>
 <button id="network">Fetch fixture</button>
 <button id="log">Emit page log</button>
 <button id="run-concurrent">Run concurrent fetches</button>
 <button id="run-utf8">Run UTF-8 fetch</button>
 <button id="run-big">Run large fetch</button>
 <button id="run-restart">Run restart probe</button>
 <button id="run-filter-match">Run filtered match fetch</button>
 <button id="run-filter-big">Run filtered large fetch</button>
 <pre id="event-log" aria-label="Observed events"></pre>
 <pre id="net-concurrent-result" aria-label="Concurrent fetch result"></pre>
 <pre id="net-utf8-result" aria-label="UTF-8 fetch result"></pre>
 <pre id="net-big-result" aria-label="Large fetch result"></pre>
 <pre id="net-restart-result" aria-label="Restart probe result"></pre>
 <pre id="net-filter-match-result" aria-label="Filtered match fetch result"></pre>
 <pre id="net-filter-big-result" aria-label="Filtered large fetch result"></pre>
</section>

<section id="cancel-section">
 <h2>Cancellation</h2>
 <button id="cancel-counter">Increment counter</button>
 <span id="cancel-count" aria-label="cancel count">0</span>
</section>

<section id="scroll-target"><h2>Scroll marker</h2><p>Scroll marker body.</p></section>

<script>
 const eventLog = document.querySelector('#event-log');
 const controlled = document.querySelector('#controlled-name');
 const state = { name: controlled.value };
 const append = (m) => { eventLog.textContent += m + '\\n'; };
 controlled.addEventListener('input', (e) => { state.name = controlled.value; append('input value=' + controlled.value + ' trusted=' + e.isTrusted); });
 controlled.addEventListener('change', (e) => { append('change trusted=' + e.isTrusted); });
 document.querySelector('#submit').addEventListener('click', (e) => {
   document.querySelector('#saved-values').textContent = JSON.stringify({
     name: state.name,
     existingNote: document.querySelector('#existing-note').value,
     notes: document.querySelector('#notes').value,
     enabled: document.querySelector('#enabled-feature').checked,
     choice: document.querySelector('#choice').value,
     richText: document.querySelector('#rich-text').textContent,
     clickTrusted: e.isTrusted,
   }, null, 2);
 });
 document.querySelector('#replace').addEventListener('click', () => {
   const b = document.createElement('button'); b.id = 'replaceable'; b.textContent = 'Replacement element';
   document.querySelector('#replace-area').replaceChildren(b);
 });
 const shadow = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
 shadow.innerHTML = '<h3>Shadow heading</h3><label>Shadow name <input id="shadow-input" value="Inside shadow"></label><button id="shadow-button">Shadow action</button>';
 shadow.querySelector('#shadow-button').addEventListener('click', () => { append('shadow button clicked'); });
 document.querySelector('#network').addEventListener('click', async () => {
   const r = await fetch('?capture=fixture');
   append('network status=' + r.status + ' bytes=' + (await r.text()).length);
 });
 document.querySelector('#log').addEventListener('click', () => { console.log('Pi Firefox swarm fixture page log'); append('page console.log emitted'); });
 document.querySelector('#run-concurrent').addEventListener('click', async () => {
   const results = await Promise.all([0, 1, 2, 3, 4, 5].map(async (i) => {
     const r = await fetch('/api/echo?n=' + i);
     return { i, text: await r.text() };
   }));
   document.querySelector('#net-concurrent-result').textContent = JSON.stringify(results.map((entry) => ({ i: entry.i, length: entry.text.length })));
 });
 document.querySelector('#run-utf8').addEventListener('click', async () => {
   const r = await fetch('/api/echo?n=200');
   const text = await r.text();
   document.querySelector('#net-utf8-result').textContent = JSON.stringify({ n: JSON.parse(text).n, text, utf8Bytes: new TextEncoder().encode(text).length });
 });
 document.querySelector('#run-big').addEventListener('click', async () => {
   const r = await fetch('/api/big?kb=3072');
   const text = await r.text();
   document.querySelector('#net-big-result').textContent = JSON.stringify({ chars: text.length, tail: text.slice(-7), utf8Bytes: new TextEncoder().encode(text).length });
 });
 document.querySelector('#run-restart').addEventListener('click', async () => {
   const r = await fetch('/api/echo?n=100');
   const text = await r.text();
   document.querySelector('#net-restart-result').textContent = JSON.stringify({ n: JSON.parse(text).n, length: text.length });
 });
 document.querySelector('#run-filter-match').addEventListener('click', async () => {
   const r = await fetch('/api/echo?n=42');
   const text = await r.text();
   document.querySelector('#net-filter-match-result').textContent = JSON.stringify({ n: JSON.parse(text).n, text, utf8Bytes: new TextEncoder().encode(text).length });
 });
 document.querySelector('#run-filter-big').addEventListener('click', async () => {
   const r = await fetch('/api/big?kb=3072');
   const text = await r.text();
   document.querySelector('#net-filter-big-result').textContent = JSON.stringify({ chars: text.length, tail: text.slice(-7), utf8Bytes: new TextEncoder().encode(text).length });
 });
 let cancelCount = 0;
 document.querySelector('#cancel-counter').addEventListener('click', () => { cancelCount += 1; document.querySelector('#cancel-count').textContent = String(cancelCount); });
</script>
</body></html>`
}

const FRAME_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Local frame</title></head>
<body>
<h2 id="frame-heading">Local frame heading</h2>
<label>Frame name <input id="frame-input" value="Inside frame"></label>
<button id="frame-button">Frame action</button>
<script>
 document.querySelector('#frame-button').addEventListener('click', () => { document.querySelector('#frame-heading').textContent = 'Local frame clicked'; });
</script>
</body></html>`

const CROSS_CHILD_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cross-origin child</title></head>
<body>
<h2 id="xo-heading">Cross-origin child heading</h2>
<label>Cross name <input id="xo-input" value="Inside cross origin"></label>
<button id="xo-button">Cross origin action</button>
<script>
 document.querySelector('#xo-button').addEventListener('click', () => { document.querySelector('#xo-heading').textContent = 'Cross-origin clicked'; });
</script>
</body></html>`

const FRAME2_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Padded frame</title>
<style>body{margin:0;padding:24px}</style></head>
<body>
<h2 id="padded-heading">Padded frame heading</h2>
<input id="padded-input" value="Inside padded">
<button id="padded-button">Padded action</button>
<script>
 document.querySelector('#padded-button').addEventListener('click', () => { document.querySelector('#padded-heading').textContent = 'Padded clicked'; });
</script>
</body></html>`

const FRAME3_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Occluded frame</title></head>
<body>
<h2 id="occluded-heading">Occluded frame heading</h2>
<button id="occluded-button">Occluded action</button>
<script>
 document.querySelector('#occluded-button').addEventListener('click', () => { document.querySelector('#occluded-heading').textContent = 'Occluded clicked'; });
</script>
</body></html>`

const SECURE_PROBE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Secure-context probe</title></head>
<body>
<h1 id="probe-heading">Secure-context probe</h1>
<p id="secure-probe" aria-label="secure probe report">pending</p>
<button id="probe-button">Probe action</button>
<pre id="probe-log"></pre>
<script>
  const report = {
    isSecureContext: String(window.isSecureContext),
    randomUUID: typeof crypto.randomUUID,
    getRandomValues: typeof crypto.getRandomValues,
    origin: location.origin,
    protocol: location.protocol,
  };
  document.querySelector('#secure-probe').textContent = JSON.stringify(report);

  document.title = JSON.stringify(report);
  document.querySelector('#probe-button').addEventListener('click', () => {
    document.querySelector('#probe-log').textContent += 'probe clicked; ';
  });
</script>
</body></html>`

const NAV_META_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Meta refresh start</title>
<meta http-equiv="refresh" content="0; url=/nav/final.html?via=meta"></head>
<body><h1 id="start-heading">Meta refresh start</h1></body></html>`

const NAV_LOCATION_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Location replace start</title></head>
<body><h1 id="start-heading">Location replace start</h1>
<script>location.replace('/nav/final.html?via=location')</script></body></html>`

const NAV_FINAL_HTML = (via) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Final page via ${via}</title></head>
<body><h1 id="final-heading">Final page</h1><p id="final-via">via=${via}</p></body></html>`

const NAV_REPLACE_STATE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Replace state</title></head>
<body><h1 id="rs-heading">Replace state</h1>
<script>history.replaceState(null, '', '/nav/replace-state.html?replaced=1'); document.title = 'Replace state replaced'</script></body></html>`

const NAV_HASH_CHANGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hash change</title></head>
<body><h1 id="hc-heading">Hash change</h1>
<script>location.hash = '#frag'; document.title = 'Hash change frag'</script></body></html>`

const NAV_HASH_TARGET_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hash target</title></head>
<body>
<h1 id="ht-heading">Hash target</h1>
<a id="section2-link" href="#section2">Go to section 2</a>
<div style="height:1400px"></div>
<h2 id="section2">Section 2</h2>
</body></html>`

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

async function recoverGroupByName(name) {
  const listed = await send(sessionId, { kind: 'groups.list' }, { area: 'recovery' })
  const groups = listed.json?.data?.groups ?? []
  return groups.find((group) => group.name === name && group.groupId)
}

async function createGroupWithRecovery(name) {
  const attempt = await send(sessionId, { kind: 'groups.create', profileId: state.profileId, name }, { area: 'groups' })
  if (attempt.json?.ok === true && typeof attempt.json.data?.group?.groupId === 'string') {
    created.groups.add(attempt.json.data.group.groupId)
    return { groupId: attempt.json.data.group.groupId, recovered: false, attempt }
  }
  if (attempt.json?.ok === false || attempt.networkError || attempt.httpStatus !== 200) {
    const recovered = await recoverGroupByName(name)
    if (recovered) {
      created.groups.add(recovered.groupId)
      return { groupId: recovered.groupId, recovered: true, attempt }
    }
  }
  return { groupId: null, recovered: false, attempt }
}

async function recoverTabInGroup(groupId, urlPrefix) {
  const listed = await send(sessionId, { kind: 'tabs.list', groupId }, { area: 'recovery' })
  const tabs = listed.json?.data?.tabs ?? []
  return tabs.find((tab) => typeof tab.url === 'string' && tab.url.startsWith(urlPrefix) && tab.tabId)
}

async function createTabWithRecovery(groupId, targetUrl) {
  const attempt = await send(sessionId, { kind: 'tabs.create', groupId, url: targetUrl }, { area: 'tabs' })
  if (attempt.json?.ok === true && typeof attempt.json.data?.tab?.tabId === 'string') {
    created.tabs.add(attempt.json.data.tab.tabId)
    return { tab: attempt.json.data.tab, recovered: false, attempt }
  }
  const recovered = await recoverTabInGroup(groupId, targetUrl.split('?')[0])
  if (recovered) {
    created.tabs.add(recovered.tabId)
    return { tab: recovered, recovered: true, attempt }
  }
  return { tab: null, recovered: false, attempt }
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
    const resolved = await send(sessionId, { kind: 'tab.resolve', tabId }, { area: 'recovery' })
    const tab = resolved.json?.data?.tab
    return tab && predicate(tab.url ?? '') ? { done: true, tab } : { done: false, tab }
  }, { timeoutMs, intervalMs })
}

const state = { profileId: null, connectionId: null, epoch: null, version: null, groupId: null, tabId: null, baseUrl: null, insecureOrigin: null }

async function preflight() {
  const area = 'preflight'
  const [status, profiles, capabilities] = await Promise.all([
    runtimeGet('/extensions/status'),
    runtimeGet('/browser/v1/profiles'),
    runtimeGet('/browser/v1/capabilities'),
  ])
  const extensions = status.json?.extensions ?? []
  const firefoxExtensions = extensions.filter((entry) => entry.browser === 'Firefox')
  const profileList = profiles.json?.profiles ?? []
  const connectedFirefox = profileList.filter((entry) => entry.browser === 'Firefox' && entry.connected === true)

  const recordPreflight = {
    extensionsHttp: status.httpStatus,
    profilesHttp: profiles.httpStatus,
    capabilitiesHttp: capabilities.httpStatus,
    firefoxExtensionCount: firefoxExtensions.length,
    firefoxExtensions,
    connectedFirefoxProfileIds: connectedFirefox.map((entry) => entry.profileId),
  }
  evidence.preflight = recordPreflight

  if (connectedFirefox.length !== 1) {
    record(area, 'exactly one connected Firefox profile', 'FAIL', {
      expected: 1,
      actual: connectedFirefox.length,
      request: 'GET /browser/v1/profiles',
      note: 'Ambiguous or missing Firefox connection; refusing to proceed.',
    })
    return { blocked: 'Firefox connection is ambiguous or absent' }
  }
  const profile = connectedFirefox[0]
  state.profileId = profile.profileId
  state.epoch = profile.browserEpoch

  const matching = firefoxExtensions.filter((entry) => entry.stableKey === `install:Firefox:${profile.profileId}`)
  if (matching.length !== 1) {
    record(area, 'extension status matches profile install key', 'FAIL', {
      expected: 1,
      actual: matching.length,
      request: 'GET /extensions/status',
    })
    return { blocked: 'Extension status does not map to the connected profile' }
  }
  state.connectionId = matching[0].extensionId
  state.version = matching[0].playwriterVersion

  record(area, 'connected Firefox profile present', 'PASS', {
    actual: { profileId: profile.profileId, epoch: profile.browserEpoch, connectionId: state.connectionId },
  })
  check(area, `extension version is ${EXPECTED_VERSION}`, state.version === EXPECTED_VERSION, {
    expected: EXPECTED_VERSION,
    actual: state.version,
    request: 'GET /extensions/status',
  })
  if (state.version !== EXPECTED_VERSION) return { blocked: `Extension version ${state.version} != ${EXPECTED_VERSION}` }

  const caps = profile.capabilities ?? {}
  check(area, 'capabilities report webextension/dom/isolated', caps.backend === 'webextension' && caps.inputMode === 'dom' && caps.snapshotMode === 'dom-aria' && caps.executeMode === 'dom-compatible' && caps.evaluateWorld === 'isolated', {
    actual: { backend: caps.backend, inputMode: caps.inputMode, snapshotMode: caps.snapshotMode, executeMode: caps.executeMode, evaluateWorld: caps.evaluateWorld },
  })
  check(area, 'profiles endpoint has no extra connected Firefox profile', connectedFirefox.length === 1, { actual: connectedFirefox.length })
  return { blocked: null }
}

async function areaIsolationEmpty() {
  const area = 'session-isolation'
  const groups = await send(sessionId, { kind: 'groups.list' })
  const tabs = await send(sessionId, { kind: 'tabs.list' })
  const groupList = groups.json?.data?.groups ?? []
  const tabList = tabs.json?.data?.tabs ?? []
  check(area, 'fresh session lists no foreign groups', groupList.every((group) => group.sessionId === sessionId), {
    actual: groupList.map((group) => ({ groupId: group.groupId, sessionId: group.sessionId })),
  })
  check(area, 'fresh session lists no tabs', tabList.length === 0, { actual: tabList.length })
}

async function areaGroupAndTab() {
  const area = 'create'
  const groupResult = await createGroupWithRecovery(`swarm-acceptance ${runStamp}`)
  check(area, 'groups.create returns a groupId', typeof groupResult.groupId === 'string', {
    actual: groupResult.attempt.json?.data ?? groupResult.attempt.json?.error ?? groupResult.attempt.networkError,
    request: { kind: 'groups.create' },
    note: groupResult.recovered ? 'recovered the group via groups.list after an unknown result' : undefined,
  })
  if (!groupResult.groupId) return false
  state.groupId = groupResult.groupId

  const tabResult = await createTabWithRecovery(state.groupId, `${state.baseUrl}/index.html`)
  check(area, 'tabs.create returns a tabId', typeof tabResult.tab?.tabId === 'string', {
    actual: tabResult.attempt.json?.data ?? tabResult.attempt.json?.error ?? tabResult.attempt.networkError,
    request: { kind: 'tabs.create', groupId: state.groupId, url: `${state.baseUrl}/index.html` },
    note: tabResult.recovered ? 'recovered the tab via tabs.list after an unknown result' : undefined,
  })
  if (!tabResult.tab?.tabId) return false
  state.tabId = tabResult.tab.tabId
  const tab = tabResult.tab
  check(area, 'created tab binds to the group/profile', tab.groupId === state.groupId && tab.state !== 'released', {
    actual: { groupId: tab.groupId, url: tab.url, state: tab.state },
  })

  const settled = await waitForTabUrl(state.tabId, (currentUrl) => currentUrl.startsWith(state.baseUrl))
  check(area, 'created tab navigates to the fixture URL', settled.done === true && settled.tab?.url?.includes('/index.html'), {
    expected: `${state.baseUrl}/index.html`,
    actual: tab.url,
    note: 'tabs.create returned before navigation settled (about:blank transition)',
  })
  return true
}

async function areaSnapshotAndRef() {
  const area = 'snapshot-ref'

  let snap = null
  let data = null
  const ready = await waitFor(async () => {
    snap = await send(sessionId, { kind: 'page.snapshot', tabId: state.tabId })
    data = snap.json?.data
    const refs = data?.value?.refs
    return snap.json?.ok === true && Array.isArray(refs) && refs.some((entry) => entry.name === 'Controlled name')
      ? { done: true }
      : { done: false }
  })
  check(area, 'page.snapshot returns snapshotId + refs', snap.json?.ok === true && typeof data?.snapshotId === 'string' && data.snapshotId.length > 0 && Array.isArray(data?.value?.refs) && data.value.refs.length > 0, {
    actual: snap.json?.ok === true ? { snapshotId: data.snapshotId, refCount: data.value?.refs?.length, textLength: data.text?.length } : snap.json?.error ?? snap.networkError,
    request: { kind: 'page.snapshot', tabId: state.tabId },
  })
  if (snap.json?.ok !== true) return
  const refs = data.value.refs
  const unique = new Set(refs.map((entry) => entry.ref))
  check(area, 'snapshot refs are unique and carry role/name', unique.size === refs.length && refs.every((entry) => typeof entry.ref === 'string' && typeof entry.role === 'string'), {
    actual: refs.slice(0, 8),
  })
  check(area, 'snapshot text is non-empty and shaped as lines', typeof data.text === 'string' && data.text.trim().length > 0, {
    actual: (data.text ?? '').slice(0, 200),
  })

  const nameRef = refs.find((entry) => entry.name === 'Controlled name')
  if (!nameRef) {
    record(area, 'find a ref for the Controlled name textbox', 'FAIL', { actual: refs, note: ready.done === true ? undefined : 'snapshot accessibles never contained the expected textbox within 5s' })
    return
  }
  const fillByRef = await send(sessionId, { kind: 'page.fill', tabId: state.tabId, selector: `aria-ref=${nameRef.ref}`, snapshotId: data.snapshotId, value: 'RefAlice' })
  check(area, 'page.fill by snapshot ref succeeds', fillByRef.json?.ok === true, {
    actual: fillByRef.json?.ok === true ? fillByRef.json.data : fillByRef.json?.error ?? fillByRef.networkError,
    request: { kind: 'page.fill', selector: `aria-ref=${nameRef.ref}`, snapshotId: data.snapshotId },
  })

  const readValue = await execute(`return await page.locator('#controlled-name').inputValue()`)
  check(area, 'DOM value reflects the ref-based fill', readValue.ok === true && readValue.value === 'RefAlice', {
    actual: readValue.raw,
  })

  const stale = await send(sessionId, { kind: 'page.click', tabId: state.tabId, selector: `aria-ref=${nameRef.ref}`, snapshotId: data.snapshotId })
  check(area, 'reusing a ref after DOM change is refused as stale', stale.json?.ok === false && ['stale-snapshot', 'execution-failed', 'resource-not-found'].includes(stale.json?.error?.code), {
    expected: 'stale-snapshot',
    actual: stale.json?.error ?? stale.networkError,
    request: { kind: 'page.click', selector: `aria-ref=${nameRef.ref}`, snapshotId: data.snapshotId },
  })

  const dup = await send(sessionId, { kind: 'page.click', tabId: state.tabId, selector: 'button[aria-label="Duplicate"]' })
  check(area, 'strict selector with two matches is refused (no .first fallback)', dup.json?.ok === false, {
    actual: dup.json?.error ?? dup.networkError,
    request: { kind: 'page.click', selector: 'button[aria-label="Duplicate"]' },
  })

  const hidden = await execute(`await page.locator('#hidden-action').click(); return 'clicked'`, { area: 'snapshot-ref' })
  check(area, 'click on a hidden element is refused', hidden.ok === false, {
    actual: hidden.error ?? hidden.networkError,
    request: { kind: 'page.execute', code: "page.locator('#hidden-action').click()" },
  })
}

async function execute(code, { area = 'execute', timeoutMs = REQUEST_TIMEOUT_MS, transportMs = TRANSPORT_TIMEOUT_MS, tabId = state.tabId } = {}) {
  const result = await send(sessionId, { kind: 'page.execute', tabId, code }, { area, timeoutMs, transportMs })
  if (result.json?.ok === true) {
    return { ok: true, value: result.json.data?.value, text: result.json.data?.text, raw: result.json.data, requestId: result.requestId }
  }
  return { ok: false, error: result.json?.error ?? null, networkError: result.networkError, raw: result.json ?? result.networkError, requestId: result.requestId }
}

async function areaRoleAndForms() {
  const area = 'role-forms'
  const code = `
    const out = {};
    const name = page.getByRole('textbox', { name: 'Controlled name' });
    await name.fill('RoleAlice');
    out.roleNameValue = await name.inputValue();

    const note = page.getByLabel('Existing note');
    out.noteValue = await note.inputValue();

    await page.locator('#notes').fill('Role notes');
    out.notesValue = await page.locator('#notes').inputValue();

    const check = page.getByLabel('Enable feature');
    await check.check();
    out.checked = await check.isChecked();

    const select = page.getByLabel('Choice');
    await select.selectOption('beta');
    out.choice = await select.inputValue();

    const rich = page.getByRole('textbox', { name: 'Rich text' });
    await rich.fill('Role rich text');
    out.richText = await rich.textContent();

    await page.getByRole('button', { name: 'Save values' }).click();
    out.saved = await page.locator('#saved-values').textContent();
    out.testIdValue = await page.getByTestId('controlled-name').inputValue();
    return out;
  `
  const result = await execute(code, { area })
  if (result.ok !== true) {
    record(area, 'role locators + form actions execute', 'FAIL', { actual: result.raw })
    return
  }
  const value = result.value ?? {}
  check(area, 'getByRole textbox fill updates inputValue', value.roleNameValue === 'RoleAlice', { actual: value.roleNameValue })
  check(area, 'getByLabel reads the existing note', value.noteValue === 'Keep this text while attaching', { actual: value.noteValue })
  check(area, 'textarea fill updates value', value.notesValue === 'Role notes', { actual: value.notesValue })
  check(area, 'checkbox check() reports checked', value.checked === true, { actual: value.checked })
  check(area, 'select selectOption("beta") updates value', value.choice === 'beta', { actual: value.choice })
  check(area, 'contenteditable fill updates text', value.richText === 'Role rich text', { actual: value.richText })
  check(area, 'getByTestId resolves data-testid', value.testIdValue === 'RoleAlice', { actual: value.testIdValue })

  let saved = null
  try {
    saved = typeof value.saved === 'string' ? JSON.parse(value.saved) : null
  } catch {
    saved = null
  }
  check(area, 'submit click produced the page DOM result', saved !== null, { actual: value.saved })
  if (saved) {
    check(area, 'saved form state reflects DOM actions', saved.name === 'RoleAlice' && saved.notes === 'Role notes' && saved.enabled === true && saved.choice === 'beta' && saved.richText === 'Role rich text', {
      actual: saved,
    })
    check(area, 'DOM click is not a trusted native event (documented boundary)', saved.clickTrusted === false, { actual: saved.clickTrusted })
  }
}

async function areaHiddenFiltering() {
  const area = 'hidden-filtering'
  const snap = await send(sessionId, { kind: 'page.snapshot', tabId: state.tabId })
  const text = snap.json?.data?.text ?? ''
  check(area, 'snapshot includes a visible control', text.includes('Save values'), { actual: text.slice(0, 300) })
  check(area, 'snapshot excludes hidden/aria-hidden/inert controls', !text.includes('Hidden action') && !text.includes('Aria hidden action') && !text.includes('Inert action'), {
    actual: { hidden: text.includes('Hidden action'), ariaHidden: text.includes('Aria hidden action'), inert: text.includes('Inert action') },
  })
  const counts = await execute(`
    return {
      ariaHidden: await page.getByRole('button', { name: 'Aria hidden action' }).count(),
      inert: await page.getByRole('button', { name: 'Inert action' }).count(),
      hidden: await page.getByRole('button', { name: 'Hidden action' }).count(),
      visible: await page.getByRole('button', { name: 'Save values' }).count(),
      hiddenVisible: await page.locator('#hidden-action').isVisible(),
    }
  `, { area })
  check(area, 'role locator filters aria-hidden/inert/hidden elements', counts.ok === true && counts.value?.ariaHidden === 0 && counts.value?.inert === 0 && counts.value?.hidden === 0 && counts.value?.visible === 1 && counts.value?.hiddenVisible === false, {
    actual: counts.ok === true ? counts.value : counts.raw,
  })
}

async function areaShadowDom() {
  const area = 'shadow-dom'

  const result = await execute(`
    const box = page.getByRole('textbox', { name: 'Shadow name' });
    await box.fill('Shadow v2');
    const value = await box.inputValue();
    const byLabel = await page.getByLabel('Shadow name').count();
    const buttonText = await page.getByRole('button', { name: 'Shadow action' }).textContent();
    await page.getByRole('button', { name: 'Shadow action' }).click();
    const clicked = await page.locator('#event-log').textContent();
    return { value, byLabel, buttonText, clicked };
  `, { area })
  check(area, 'open shadow DOM input is fillable/readable via role+label', result.ok === true && result.value?.value === 'Shadow v2' && result.value?.byLabel === 1 && result.value?.buttonText === 'Shadow action', {
    actual: result.ok === true ? result.value : result.raw,
  })
  check(area, 'open shadow DOM button is clickable and mutates the DOM', result.ok === true && typeof result.value?.clicked === 'string' && result.value.clicked.includes('shadow button clicked'), {
    actual: result.value?.clicked,
  })

  const compound = await execute(`return await page.locator('#shadow-host input').count()`, { area })
  skip(area, 'compound CSS selector crosses the shadow boundary', {
    actual: compound.ok === true ? { count: compound.value } : compound.error ?? compound.networkError,
    request: { kind: 'page.execute', code: "page.locator('#shadow-host input').count()" },
    note: 'Not delivered this round: native CSS matches per document/shadow root; cross-host access uses explicit chained locators or role/label/text. Baseline recorded count 0 — listed as a limitation, not fixed.',
  })
  finding(area, 'compound cross-shadow CSS is an explicit non-goal for this round', {
    expected: 'native CSS matches within each document/shadow root; cross-host requires chained or role/label/text',
    actual: compound.ok === true ? compound.value : compound.error ?? compound.networkError,
    minimalRepro: "page.locator('#shadow-host input').count() against an open shadow root",
    note: 'Undelivered by design this round. Do not report it fixed; the integrated model/guide will state the per-root CSS rule.',
  })

  const chained = await execute(`return await page.locator('#shadow-host').locator('input').count()`, { area })
  check(area, 'chained locator traverses the host element shadowRoot', chained.ok === true && chained.value === 1, {
    actual: chained.ok === true ? { count: chained.value } : chained.error ?? chained.networkError,
    request: { kind: 'page.execute', code: "page.locator('#shadow-host').locator('input').count()" },
  })
  if (!(chained.ok === true && chained.value === 1)) {
    finding(area, 'chained locator misses the host element shadowRoot', {
      expected: 'chaining from an element traverses its open shadowRoot',
      actual: chained.ok === true ? chained.value : chained.error ?? chained.networkError,
      minimalRepro: "page.locator('#shadow-host').locator('input').count() against an open shadow root",
      note: 'Chained traversal is a required capability and must actually succeed; independent of the undelivered compound-CSS case.',
    })
  }
}

async function areaSameOriginFrame() {
  const area = 'iframe-same-origin'
  const read = await execute(`
    const frame = page.frameLocator('#local-frame');
    const heading = await frame.locator('#frame-heading').textContent();
    const value = await frame.locator('#frame-input').inputValue();
    return { heading, value };
  `, { area })
  check(area, 'same-origin iframe locator reads content', read.ok === true && read.value?.heading === 'Local frame heading' && read.value?.value === 'Inside frame', {
    actual: read.ok === true ? read.value : read.raw,
  })

  const action = await execute(`
    const frame = page.frameLocator('#local-frame');
    await frame.locator('#frame-input').fill('Frame v2');
    return await frame.locator('#frame-input').inputValue();
  `, { area })
  if (action.ok === true) {
    check(area, 'same-origin iframe locator fills content', action.value === 'Frame v2', { actual: action.value })
  } else {

    check(area, 'same-origin iframe locator fills content', false, {
      actual: action.error ?? action.networkError,
      request: { kind: 'page.execute', code: "page.frameLocator('#local-frame').locator('#frame-input').fill(...)" },
    })
    finding(area, 'same-origin iframe actions are refused for missing getBoxQuads', {
      expected: 'frameLocator fill/click works per the Firefox guide',
      actual: action.error,
      request: { kind: 'page.execute', code: "page.frameLocator('#local-frame').locator('#frame-input').fill(...)" },
      minimalRepro: "page.frameLocator('#local-frame').locator('#frame-input').fill('Frame v2')",
      note: 'Frame read works; action is refused because Element.getBoxQuads is unavailable on stock Firefox.',
    })
  }
}

async function areaCrossOriginFrame() {
  const area = 'iframe-cross-origin'
  const read = await execute(`
    const frame = page.frameLocator('#cross-frame');
    const heading = await frame.locator('#xo-heading').textContent();
    return { heading };
  `, { area })
  if (read.ok === true) {
    check(area, 'cross-origin iframe read works', read.value?.heading === 'Cross-origin child heading', { actual: read.value })
  } else {
    skip(area, 'cross-origin iframe read', { actual: read.error ?? read.networkError, note: 'Cross-origin frame content unavailable.' })
  }

  const action = await execute(`
    const frame = page.frameLocator('#cross-frame');
    await frame.locator('#xo-input').fill('Cross v2');
    return await frame.locator('#xo-input').inputValue();
  `, { area })
  if (action.ok === true) {
    check(area, 'cross-origin iframe fill works', action.value === 'Cross v2', { actual: action.value })
  } else {
    check(area, 'cross-origin iframe fill works', false, {
      actual: action.error ?? action.networkError,
      request: { kind: 'page.execute', code: "page.frameLocator('#cross-frame').locator('#xo-input').fill(...)" },
    })
    finding(area, 'cross-origin iframe actions are refused for missing getBoxQuads', {
      expected: 'cross-origin iframe actions work per the Firefox guide',
      actual: action.error,
      request: { kind: 'page.execute', code: "page.frameLocator('#cross-frame').locator('#xo-input').fill(...)" },
      minimalRepro: "page.frameLocator('#cross-frame').locator('#xo-input').fill('Cross v2')",
      note: 'Explicit refusal; likely the same getBoxQuads requirement.',
    })
  }
}

async function areaIframeGeometry() {
  const area = 'iframe-geometry'

  const padded = await execute(`
    const frame = page.frameLocator('#padded-frame');
    await frame.getByRole('button', { name: 'Padded action' }).click();
    return await frame.locator('#padded-heading').textContent();
  `, { area })
  check(area, 'click in a bordered/padded no-transform frame hits the target', padded.ok === true && padded.value === 'Padded clicked', {
    actual: padded.ok === true ? padded.value : padded.error ?? padded.networkError,
    request: { code: "frameLocator('#padded-frame').getByRole('button',{name:'Padded action'}).click()" },
  })

  const transformed = await execute(`
    const frame = page.frameLocator('#scaled-frame');
    await frame.getByRole('button', { name: 'Padded action' }).click();
    return await frame.locator('#padded-heading').textContent();
  `, { area })
  check(area, 'transformed frame action is explicitly refused (no approximation)', transformed.ok === false && transformed.error?.code === 'unsupported-capability', {
    expected: 'unsupported-capability',
    actual: transformed.ok === true ? { heading: transformed.value } : transformed.error ?? transformed.networkError,
    request: { code: "frameLocator('#scaled-frame').getByRole('button',{name:'Padded action'}).click()" },
  })

  const fractional = await execute(`
    const frame = page.frameLocator('#fraction-frame');
    await frame.getByRole('button', { name: 'Padded action' }).click();
    return await frame.locator('#padded-heading').textContent();
  `, { area })
  check(area, 'fractional-geometry frame action is explicitly refused (no approximation)', fractional.ok === false && fractional.error?.code === 'unsupported-capability', {
    expected: 'unsupported-capability',
    actual: fractional.ok === true ? { heading: fractional.value } : fractional.error ?? fractional.networkError,
    request: { code: "frameLocator('#fraction-frame').getByRole('button',{name:'Padded action'}).click()" },
  })

  const occluded = await execute(`
    const frame = page.frameLocator('#occluded-frame');
    await frame.getByRole('button', { name: 'Occluded action' }).click();
    return await frame.locator('#occluded-heading').textContent();
  `, { area })
  check(area, 'occluded frame action is refused or does not activate the target', occluded.ok === false || occluded.value === 'Occluded frame heading', {
    expected: 'refused, or the target is not activated',
    actual: occluded.ok === true ? { heading: occluded.value } : occluded.error ?? occluded.networkError,
    request: { code: "frameLocator('#occluded-frame').getByRole('button',{name:'Occluded action'}).click()" },
  })
  if (occluded.ok === true && occluded.value === 'Occluded clicked') {
    finding(area, 'occluded frame action clicked through a parent overlay', {
      expected: 'parent-level occlusion must block frame actions',
      actual: { heading: occluded.value },
      minimalRepro: "frameLocator('#occluded-frame').getByRole('button',{name:'Occluded action'}).click() under a full-cover overlay",
    })
  }
}

async function areaNavigateBack() {
  const area = 'navigate-back'
  const target = `${state.baseUrl}/index.html?history=next`
  const nav = await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: target })
  check(area, 'page.navigate succeeds', nav.json?.ok === true, {
    actual: nav.json?.error ?? nav.networkError,
    request: { kind: 'page.navigate' },
  })
  const afterNav = await execute(`return page.url()`, { area })
  check(area, 'page.navigate really reaches the target URL', afterNav.ok === true && afterNav.value === target, {
    expected: target,
    actual: afterNav.value ?? afterNav.raw,
    note: `navigate pageInfo.url=${nav.json?.data?.pageInfo?.url ?? 'n/a'}`,
  })

  const back = await send(sessionId, { kind: 'page.back', tabId: state.tabId })
  check(area, 'page.back succeeds', back.json?.ok === true, { actual: back.json?.error ?? back.networkError })
  const afterBack = await execute(`return page.url()`, { area })
  check(area, 'page.back really returns to the prior URL', afterBack.ok === true && afterBack.value?.endsWith('/index.html') === true, {
    expected: `${state.baseUrl}/index.html`,
    actual: afterBack.value ?? afterBack.raw,
  })

  const backReported = back.json?.data?.pageInfo?.url
  if (back.json?.ok === true && afterBack.ok === true) {
    check(area, 'page.back response URL matches the completed navigation', backReported === afterBack.value, {
      expected: afterBack.value,
      actual: backReported,
      request: { kind: 'page.back' },
    })
  }
  if (typeof backReported === 'string' && backReported !== afterBack.value) {
    finding(area, 'page.back response reports the pre-navigation URL', {
      expected: 'pageInfo.url should equal the URL after going back',
      actual: { responseUrl: backReported, actualUrl: afterBack.value },
      request: { kind: 'page.back' },
      minimalRepro: 'navigate to ?history=next then page.back; response pageInfo.url still contains ?history=next',
      note: 'page.url() afterwards is correct; only the back response metadata is stale. Handed to Codex for the fix; re-check the returned data matches the completed navigation.',
    })
  }

  if (!(afterBack.ok === true && afterBack.value?.endsWith('/index.html'))) {
    await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: `${state.baseUrl}/index.html` })
    await waitForTabUrl(state.tabId, (currentUrl) => currentUrl.endsWith('/index.html'))
  }
}

async function areaNavigationChain() {
  const area = 'navigation-chain'

  const redirects = [
    { id: 'meta-refresh', start: '/nav/meta-refresh.html', final: '/nav/final.html?via=meta' },
    { id: 'location-replace', start: '/nav/location-replace.html', final: '/nav/final.html?via=location' },
  ]
  for (const item of redirects) {
    const nav = await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: `${state.baseUrl}${item.start}` }, { area })
    const reported = nav.json?.data?.pageInfo?.url ?? null
    check(area, `page.navigate follows a ${item.id} redirect and returns the final URL`, nav.json?.ok === true && typeof reported === 'string' && reported.endsWith(item.final), {
      expected: `${state.baseUrl}${item.final}`,
      actual: nav.json?.ok === true ? { reported } : nav.json?.error ?? nav.networkError,
      request: { kind: 'page.navigate', url: `${state.baseUrl}${item.start}` },
    })
    const observed = await execute(`return page.url()`, { area })
    check(area, `final document really loaded for the ${item.id} redirect`, observed.ok === true && String(observed.value).endsWith(item.final), {
      expected: `${state.baseUrl}${item.final}`,
      actual: observed.value ?? observed.raw,
    })
  }

  const replaceStateUrl = `${state.baseUrl}/nav/replace-state.html`
  const replaceState = await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: replaceStateUrl }, { area })
  const replaceStateReported = replaceState.json?.data?.pageInfo?.url ?? null
  check(area, 'page.navigate settles after history.replaceState on load', replaceState.json?.ok === true && typeof replaceStateReported === 'string' && replaceStateReported.endsWith('/nav/replace-state.html?replaced=1'), {
    expected: `${replaceStateUrl}?replaced=1`,
    actual: replaceState.json?.ok === true ? { reported: replaceStateReported } : replaceState.json?.error ?? replaceState.networkError,
    request: { kind: 'page.navigate' },
  })
  const replaceStateActual = await execute(`return page.url()`, { area })
  check(area, 'replaceState URL matches the final document', replaceStateActual.ok === true && String(replaceStateActual.value).endsWith('/nav/replace-state.html?replaced=1'), {
    actual: replaceStateActual.value ?? replaceStateActual.raw,
  })

  const hashChangeUrl = `${state.baseUrl}/nav/hash-change.html`
  const hashChange = await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: hashChangeUrl }, { area })
  const hashChangeReported = hashChange.json?.data?.pageInfo?.url ?? null
  check(area, 'page.navigate settles after a load-time hash change', hashChange.json?.ok === true && typeof hashChangeReported === 'string' && hashChangeReported.endsWith('#frag'), {
    expected: `${hashChangeUrl}#frag`,
    actual: hashChange.json?.ok === true ? { reported: hashChangeReported } : hashChange.json?.error ?? hashChange.networkError,
    request: { kind: 'page.navigate' },
  })
  const hashChangeActual = await execute(`return page.url()`, { area })
  check(area, 'hash-change URL matches the final document', hashChangeActual.ok === true && String(hashChangeActual.value).endsWith('#frag'), {
    actual: hashChangeActual.value ?? hashChangeActual.raw,
  })

  const hashTargetUrl = `${state.baseUrl}/nav/hash-target.html`
  await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: hashTargetUrl }, { area })
  const fragment = await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: `${hashTargetUrl}#section2` }, { area })
  const fragmentReported = fragment.json?.data?.pageInfo?.url ?? null
  check(area, 'same-document fragment navigation returns the fragment URL', fragment.json?.ok === true && typeof fragmentReported === 'string' && fragmentReported.endsWith('#section2'), {
    expected: `${hashTargetUrl}#section2`,
    actual: fragment.json?.ok === true ? { reported: fragmentReported } : fragment.json?.error ?? fragment.networkError,
    request: { kind: 'page.navigate' },
  })
  const fragmentActual = await execute(`return page.url()`, { area })
  check(area, 'fragment URL matches the final document', fragmentActual.ok === true && String(fragmentActual.value).endsWith('#section2'), {
    actual: fragmentActual.value ?? fragmentActual.raw,
  })

  const back = await send(sessionId, { kind: 'page.back', tabId: state.tabId }, { area })
  const backReported = back.json?.data?.pageInfo?.url ?? null
  const backActual = await execute(`return page.url()`, { area })
  check(area, 'page.back after a same-document fragment returns the base URL', back.json?.ok === true && backActual.ok === true && String(backActual.value).endsWith('/nav/hash-target.html'), {
    expected: hashTargetUrl,
    actual: { reported: backReported, actual: backActual.value ?? backActual.raw },
  })
  check(area, 'page.back response matches the completed fragment navigation', backReported === backActual.value, {
    expected: backActual.value,
    actual: backReported,
    request: { kind: 'page.back' },
  })

  await send(sessionId, { kind: 'page.navigate', tabId: state.tabId, url: `${state.baseUrl}/index.html` }, { area })
  await waitForTabUrl(state.tabId, (currentUrl) => currentUrl.endsWith('/index.html'))
}

async function areaTargetBlank() {
  const area = 'target-blank'
  const countFixtureTabs = async () => {
    const discovered = await send(sessionId, { kind: 'tabs.discover', profileId: state.profileId }, { area })
    const candidates = discovered.json?.data?.candidates ?? []
    return candidates.filter((entry) => typeof entry.url === 'string' && entry.url.startsWith(state.baseUrl)).length
  }
  const before = await countFixtureTabs()

  const snap = await send(sessionId, { kind: 'page.snapshot', tabId: state.tabId })
  const refs = snap.json?.data?.value?.refs ?? []
  const linkRef = refs.find((entry) => entry.name === 'Open fixture child')
  let click
  if (linkRef) {
    click = await send(sessionId, { kind: 'page.click', tabId: state.tabId, selector: `aria-ref=${linkRef.ref}`, snapshotId: snap.json.data.snapshotId })
  } else {
    click = await send(sessionId, { kind: 'page.click', tabId: state.tabId, selector: '#new-tab' })
  }
  check(area, 'clicking a target=_blank link succeeds', click.json?.ok === true, {
    actual: click.json?.ok === true ? click.json.data : click.json?.error ?? click.networkError,
  })

  let after = before
  const opened = await waitFor(async () => {
    after = await countFixtureTabs()
    return after > before ? { done: true } : { done: false }
  })
  if (opened.done !== true) {
    finding(area, 'DOM click does not open a target=_blank tab', {
      expected: 'a new tab with sourceTabId pointing at the controlled tab',
      actual: { fixtureTabsBefore: before, fixtureTabsAfter: after },
      request: { kind: 'page.click', selector: '#new-tab (target=_blank)' },
      minimalRepro: 'click an <a target="_blank"> from the controlled tab, then tabs.discover',
      note: 'DOM clicks are untrusted and Firefox popup blocking suppresses the new tab, so sourceTabId cannot be exercised this way.',
    })
    skip(area, 'opened tab is associated with sourceTabId', {
      actual: 'no new tab was opened by the untrusted DOM click (popup blocked)',
      note: 'Platform boundary of DOM input, not a code path failure; inheritance code was not exercised.',
    })
    return null
  }

  const found = await waitFor(async () => {
    const listed = await send(sessionId, { kind: 'tabs.list', sourceTabId: state.tabId }, { area })
    const tabs = listed.json?.data?.tabs ?? []
    const child = tabs.find((tab) => tab.sourceTabId === state.tabId)
    return child ? { done: true, child } : { done: false }
  })
  check(area, 'the opened tab is associated with sourceTabId', found.done === true && typeof found.child?.url === 'string' && found.child.url.includes('child=1'), {
    actual: found.child ?? 'no tab with sourceTabId before timeout',
    request: { kind: 'tabs.list', sourceTabId: state.tabId },
  })
  if (found.child?.tabId) created.tabs.add(found.child.tabId)
  return found.child?.tabId ?? null
}

async function areaScreenshot() {
  const area = 'screenshot'
  const plainPath = path.join(evidenceDir, 'screenshot-plain.png')
  const labelsPath = path.join(evidenceDir, 'screenshot-labels.png')
  const screenshotOptions = { area, timeoutMs: REQUEST_TIMEOUT_MS, transportMs: TRANSPORT_TIMEOUT_MS }
  const plain = await send(sessionId, { kind: 'page.screenshot', tabId: state.tabId, path: plainPath }, screenshotOptions)
  check(area, 'plain screenshot returns an artifact', plain.json?.ok === true && Array.isArray(plain.json.data?.artifacts) && plain.json.data.artifacts.length === 1, {
    actual: plain.json?.ok === true ? plain.json.data : plain.json?.error ?? plain.networkError,
  })
  const isPng = (file) => {
    try {
      const buffer = fs.readFileSync(file)
      return buffer.length > 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    } catch {
      return false
    }
  }
  check(area, 'plain screenshot file is a non-empty PNG', isPng(plainPath), { actual: { file: plainPath, size: fs.existsSync(plainPath) ? fs.statSync(plainPath).size : 0 } })

  const labels = await send(sessionId, { kind: 'page.screenshot', tabId: state.tabId, path: labelsPath, labels: true }, screenshotOptions)
  check(area, 'labels screenshot returns an artifact', labels.json?.ok === true && Array.isArray(labels.json.data?.artifacts) && labels.json.data.artifacts.length === 1, {
    actual: labels.json?.ok === true ? labels.json.data : labels.json?.error ?? labels.networkError,
  })
  check(area, 'labels screenshot file is a non-empty PNG', isPng(labelsPath), { actual: { file: labelsPath, size: fs.existsSync(labelsPath) ? fs.statSync(labelsPath).size : 0 } })
}

async function areaNetwork() {
  const area = 'network'
  const start = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'start' }, { area })
  check(area, 'network capture starts', start.json?.ok === true && start.json.data?.networkCapture?.status === 'active', {
    actual: start.json?.ok === true ? start.json.data?.networkCapture : start.json?.error ?? start.networkError,
  })
  const trigger = await execute(`
    await page.getByRole('button', { name: 'Fetch fixture' }).click();
    return await page.locator('#event-log').textContent();
  `, { area })
  check(area, 'page fetch was triggered', trigger.ok === true && typeof trigger.value === 'string' && trigger.value.includes('network status=200'), {
    actual: trigger.ok === true ? trigger.value : trigger.raw,
  })
  const found = await waitFor(async () => {
    const listed = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'list' }, { area })
    const rows = Array.isArray(listed.json?.data?.value) ? listed.json.data.value : []
    const meta = listed.json?.data?.networkCapture
    const match = rows.find((row) => typeof row.url === 'string' && row.url.includes('capture=fixture'))
    return match && meta?.retainedCount > 0 ? { done: true, match, meta, rows } : { done: false, meta, rows }
  })
  check(area, 'network list retains the fixture request', found.done === true, { actual: { meta: found.meta, rows: (found.rows ?? []).length } })
  if (found.match) {
    check(area, 'retained row has status and (bounded) response body', found.match.status === 200 && typeof found.match.responseBody === 'string', {
      actual: { url: found.match.url, status: found.match.status, responseBodyLength: found.match.responseBody?.length, bodyUnavailable: found.match.bodyUnavailable },
    })
  }
  const stop = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'stop' }, { area })
  check(area, 'network capture stops', stop.json?.ok === true && ['stopped', 'interrupted'].includes(stop.json.data?.networkCapture?.status), {
    actual: stop.json?.ok === true ? stop.json.data?.networkCapture : stop.json?.error ?? stop.networkError,
  })
  const after = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'list' }, { area })
  const afterRows = Array.isArray(after.json?.data?.value) ? after.json.data.value : []
  check(area, 'network rows are retained after stop', after.json?.ok === true && afterRows.some((row) => typeof row.url === 'string' && row.url.includes('capture=fixture')), {
    actual: { retainedCount: after.json?.data?.networkCapture?.retainedCount, rows: afterRows.length },
  })
}

async function areaNetworkFilter() {
  const area = 'network-filter'
  const listRows = async () => {
    const listed = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'list' }, { area })
    const rows = Array.isArray(listed.json?.data?.value) ? listed.json.data.value : []
    return { rows, meta: listed.json?.data?.networkCapture }
  }

  const start = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'start' }, { area })
  check(area, 'capture starts for the filter suite', start.json?.ok === true && start.json.data?.networkCapture?.status === 'active', {
    actual: start.json?.ok === true ? start.json.data?.networkCapture : start.json?.error ?? start.networkError,
  })

  const runFixtureFetch = async (buttonName, resultSelector) => {
    const click = await execute(`await page.getByRole('button', { name: ${JSON.stringify(buttonName)} }).click(); return 'clicked'`, { area })
    if (click.ok !== true) return { ok: false, raw: click.raw }
    const parsed = await waitFor(async () => {
      const read = await execute(`return await page.locator(${JSON.stringify(resultSelector)}).textContent()`, { area })
      if (read.ok !== true || typeof read.value !== 'string' || read.value.trim().length === 0) return { done: false }
      try {
        return { done: true, value: JSON.parse(read.value) }
      } catch {
        return { done: false }
      }
    })
    if (parsed.done !== true) return { ok: false, raw: parsed }
    return { ok: true, value: parsed.value }
  }

  const concurrent = await runFixtureFetch('Run concurrent fetches', '#net-concurrent-result')
  check(area, 'six concurrent fetches complete', concurrent.ok === true && Array.isArray(concurrent.value) && concurrent.value.length === 6, {
    actual: concurrent.ok === true ? concurrent.value : concurrent.raw,
  })

  const captured = await waitFor(async () => {
    const { rows, meta } = await listRows()
    const echo = rows.filter((row) => typeof row.url === 'string' && row.url.includes('/api/echo'))
    return echo.length >= 6 ? { done: true, echo, rows, meta } : { done: false, echo, rows, meta }
  })
  check(area, 'all concurrent requests are captured', captured.done === true && (captured.echo?.length ?? 0) >= 6, {
    actual: { echoRows: captured.echo?.length ?? 0, meta: captured.meta },
  })

  const pageUtf8 = await runFixtureFetch('Run UTF-8 fetch', '#net-utf8-result')
  check(area, 'page realm receives the complete UTF-8 payload', pageUtf8.ok === true && pageUtf8.value?.n === 200 && String(pageUtf8.value?.text).includes('中文-✓-😀'), {
    actual: pageUtf8.ok === true ? pageUtf8.value : pageUtf8.raw,
  })

  const details = []
  let utf8Ok = true
  for (const row of captured.echo ?? []) {
    const match = /[?&]n=(\d+)/.exec(row.url ?? '')
    if (!match) continue
    if (row.bodyTruncated === true) {
      details.push({ n: match[1], truncated: true, recordedChars: row.responseBody?.length ?? 0 })
      continue
    }
    try {
      const parsed = JSON.parse(row.responseBody ?? '')
      if (String(parsed.n) !== match[1] || !String(parsed.text).includes('中文-✓-😀')) {
        utf8Ok = false
        details.push({ n: match[1], parsed })
      }
    } catch {
      utf8Ok = false
      details.push({ n: match[1], raw: (row.responseBody ?? '').slice(0, 80), bodyUnavailable: row.bodyUnavailable })
    }
  }
  check(area, 'recorded UTF-8 JSON bodies are complete (or explicitly truncated) and decode exactly', utf8Ok, {
    actual: details,
  })

  const bigTrigger = await runFixtureFetch('Run large fetch', '#net-big-result')
  const tailChars = '-END-中文'.length
  const tailBytes = Buffer.byteLength('-END-中文', 'utf8')
  const fullChars = 3072 * 1024 + tailChars
  const fullBytes = 3072 * 1024 + tailBytes
  check(area, 'page realm receives the complete original large response', bigTrigger.ok === true && bigTrigger.value?.chars === fullChars && bigTrigger.value?.utf8Bytes === fullBytes && String(bigTrigger.value?.tail).endsWith('-END-中文'), {
    expected: { chars: fullChars, utf8Bytes: fullBytes, tail: '-END-中文' },
    actual: bigTrigger.ok === true ? bigTrigger.value : bigTrigger.raw,
    note: 'Verified by reading the response in the page realm, not from the capture record.',
  })

  const big = await waitFor(async () => {
    const { rows, meta } = await listRows()
    const row = rows.find((entry) => typeof entry.url === 'string' && entry.url.includes('/api/big'))
    return row ? { done: true, row, meta } : { done: false, meta }
  })
  check(area, 'capture record for the large body is bounded or explicitly truncated', big.done === true && (big.row?.bodyTruncated === true || Buffer.byteLength(big.row?.responseBody ?? '', 'utf8') <= fullBytes || big.row?.bodyUnavailable !== undefined), {
    actual: big.row ? { recordedChars: big.row.responseBody?.length, recordedUtf8Bytes: Buffer.byteLength(big.row.responseBody ?? '', 'utf8'), truncated: big.row.bodyTruncated, unavailable: big.row.bodyUnavailable, fullBytes } : big.meta,
    note: 'Retained bytes only describe the bounded record; they do not prove the in-flight memory budget, which is provable only in pure logic.',
  })

  const stop = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'stop' }, { area })
  check(area, 'capture stops before restart', stop.json?.ok === true && ['stopped', 'interrupted'].includes(stop.json.data?.networkCapture?.status), {
    actual: stop.json?.data?.networkCapture ?? stop.json?.error ?? stop.networkError,
  })
  const afterStop = await listRows()
  const stopEcho = afterStop.rows.filter((row) => (row.url ?? '').includes('/api/echo'))
  check(area, 'stop retains the earlier captured rows instead of erasing them', stopEcho.length >= 6 || (afterStop.meta?.droppedCount ?? 0) > 0 || typeof afterStop.meta?.reason === 'string', {
    actual: { echoRows: stopEcho.length, meta: afterStop.meta },
  })
  const restart = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'start' }, { area })
  check(area, 'capture restarts after stop', restart.json?.ok === true && restart.json.data?.networkCapture?.status === 'active', {
    actual: restart.json?.data?.networkCapture ?? restart.json?.error ?? restart.networkError,
  })
  const afterRestartTrigger = await runFixtureFetch('Run restart probe', '#net-restart-result')
  check(area, 'post-restart fetch completes', afterRestartTrigger.ok === true && afterRestartTrigger.value?.n === 100, { actual: afterRestartTrigger.ok === true ? afterRestartTrigger.value : afterRestartTrigger.raw })
  const afterRestart = await waitFor(async () => {
    const { rows, meta } = await listRows()
    return rows.some((row) => (row.url ?? '').includes('n=100')) ? { done: true, rows, meta } : { done: false, rows, meta }
  })
  check(area, 'requests after restart are captured', afterRestart.done === true, {
    actual: { retainedCount: afterRestart.meta?.retainedCount, meta: afterRestart.meta },
  })
  const restartRows = (afterRestart.rows ?? []).length
  check(area, 'restart is reported as a documented replacement, not a silent loss', afterRestart.meta?.status === 'active' && afterRestart.meta?.retainedCount === restartRows && typeof afterRestart.meta?.droppedCount === 'number', {
    actual: { rows: restartRows, meta: afterRestart.meta },
    note: 'An explicit start replaces the previous capture per the contract; earlier rows were already verified to survive stop before the restart.',
  })

  const activeCaptureId = afterRestart.meta?.captureId ?? null
  const filteredStart = await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'start', filter: '/api/' }, { area })
  const filteredCaptureId = filteredStart.json?.data?.networkCapture?.captureId ?? null
  check(area, 'a new explicit start while capture is active replaces the previous capture', filteredStart.json?.ok === true && filteredStart.json?.data?.networkCapture?.status === 'active' && typeof filteredCaptureId === 'string' && filteredCaptureId !== activeCaptureId, {
    expected: { status: 'active', captureIdChanged: true, filter: '/api/' },
    actual: filteredStart.json?.ok === true ? filteredStart.json.data?.networkCapture : filteredStart.json?.error ?? filteredStart.networkError,
    request: { kind: 'page.network', action: 'start', filter: '/api/', requestId: filteredStart.requestId },
    note: 'A distinct explicit start with a new requestId (not an idempotent retry of the previous request).',
  })

  const afterFilteredStart = await listRows()
  check(area, 'the replaced capture starts empty (previous rows are not carried over)', afterFilteredStart.meta?.captureId === filteredCaptureId && (afterFilteredStart.rows?.length ?? 0) === 0, {
    actual: { captureId: afterFilteredStart.meta?.captureId, rows: (afterFilteredStart.rows ?? []).map((row) => row.url) },
  })

  const filteredMatch = await runFixtureFetch('Run filtered match fetch', '#net-filter-match-result')
  check(area, 'a matching request after the active start is captured (page realm received the full UTF-8 payload)', filteredMatch.ok === true && filteredMatch.value?.n === 42 && String(filteredMatch.value?.text).includes('中文-✓-😀') && filteredMatch.value?.utf8Bytes === Buffer.byteLength(String(filteredMatch.value?.text), 'utf8'), {
    actual: filteredMatch.ok === true ? filteredMatch.value : filteredMatch.raw,
    note: 'filter=/api/ — the request matches and must be recorded.',
  })

  const filteredBig = await runFixtureFetch('Run filtered large fetch', '#net-filter-big-result')
  check(area, 'the page realm receives the complete original large response after the active start', filteredBig.ok === true && filteredBig.value?.chars === fullChars && filteredBig.value?.utf8Bytes === fullBytes && String(filteredBig.value?.tail).endsWith('-END-中文'), {
    expected: { chars: fullChars, utf8Bytes: fullBytes, tail: '-END-中文' },
    actual: filteredBig.ok === true ? filteredBig.value : filteredBig.raw,
    note: 'Read in the page realm, not from the capture record.',
  })

  const missControl = await execute(`
    await page.getByRole('button', { name: 'Fetch fixture' }).click();
    return await page.locator('#event-log').textContent();
  `, { area })
  check(area, 'non-matching request completed in the page (filter control)', missControl.ok === true && typeof missControl.value === 'string' && missControl.value.includes('network status=200'), {
    actual: missControl.ok === true ? missControl.value : missControl.raw,
  })

  const filteredList = await waitFor(async () => {
    const { rows, meta } = await listRows()
    const hasMatch = rows.some((row) => (row.url ?? '').includes('/api/echo?n=42'))
    const hasBig = rows.some((row) => (row.url ?? '').includes('/api/big'))
    return hasMatch && hasBig ? { done: true, rows, meta } : { done: false, rows, meta }
  })
  const filteredRows = filteredList.rows ?? []
  check(area, 'only filter-matching requests are recorded into the new capture', filteredList.done === true && filteredRows.length > 0 && filteredRows.every((row) => (row.url ?? '').includes('/api/')) && filteredRows.every((row) => !(row.url ?? '').includes('n=100')) && filteredRows.every((row) => !(row.url ?? '').includes('capture=fixture')), {
    actual: { captureId: filteredList.meta?.captureId, rows: filteredRows.map((row) => row.url) },
    note: 'filter=/api/; the non-matching ?capture=fixture request and the previous capture rows must be absent.',
  })

  await send(sessionId, { kind: 'page.network', tabId: state.tabId, action: 'stop' }, { area })
}

async function areaLogs() {
  const area = 'logs'
  const trigger = await execute(`
    await page.getByRole('button', { name: 'Emit page log' }).click();
    return await page.locator('#event-log').textContent();
  `, { area })

  check(area, 'console.log call still lets the page run (DOM event-log appended)', trigger.ok === true && typeof trigger.value === 'string' && trigger.value.includes('page console.log emitted'), {
    actual: trigger.ok === true ? trigger.value : trigger.raw,
    request: { kind: 'page.execute', code: "click #log then read #event-log" },
  })
  if (!(trigger.ok === true && typeof trigger.value === 'string' && trigger.value.includes('page console.log emitted'))) {
    finding(area, 'page console.log is broken by the console bridge', {
      expected: 'console.log(then DOM append) completes in the page realm',
      actual: trigger.ok === true ? trigger.value : trigger.raw,
      request: { kind: 'page.execute', tabId: state.tabId },
      minimalRepro: "console.log('plain string'); document.querySelector('#event-log').textContent += 'page console.log emitted'",
      note: 'The page-side append does not run, so the page-realm console.log threw. Consistent with firefox-dom.ts original.apply(pageView.console, args) rejecting a content-script rest array. recordLog still succeeds, so page.logs alone is not sufficient evidence.',
    })
  }

  const found = await waitFor(async () => {
    const logs = await send(sessionId, { kind: 'page.logs', tabId: state.tabId, limit: 50 }, { area })
    const lines = logs.json?.data?.logs ?? []
    return lines.some((line) => typeof line === 'string' && line.includes('Pi Firefox swarm fixture page log')) ? { done: true, lines } : { done: false, lines }
  })
  check(area, 'page.logs captures the fixture console line', found.done === true, { actual: (found.lines ?? []).slice(-5) })

  const spurious = (found.lines ?? []).filter((line) => typeof line === 'string' && line.includes('Permission denied to access property "length"'))
  check(area, 'captured page error must be absent for a plain console.log', spurious.length === 0, {
    actual: { spurious, lines: (found.lines ?? []).slice(-6) },
    request: { kind: 'page.logs' },
  })
  if (spurious.length > 0) {
    finding(area, 'console bridge emits a spurious cross-realm error for every console call', {
      expected: 'one captured log line per console call, no extra page error',
      actual: spurious[0],
      request: { kind: 'page.logs', tabId: state.tabId },
      minimalRepro: "console.log('plain string'); then page.logs — emits both the log line and [error] Permission denied to access property \"length\"",
      note: 'Reproduced for console.log/warn/error and for object/Error arguments; location points at the page console call site. Likely firefox-dom.ts:310 original.apply(pageView.console, args). Platform owner has taken this over.',
    })
  }
}

async function areaExecuteReads() {
  const area = 'execute-reads'
  const reads = await execute(`
    const title = await page.title();
    const pageUrl = page.url();
    const heading = await page.locator('#page-heading').textContent();
    const count = await page.getByRole('button').count();
    const dataTestId = await page.locator('[data-testid="controlled-name"]').getAttribute('data-testid');
    const dupCount = await page.getByRole('button', { name: 'Duplicate' }).count();
    return { title, pageUrl, heading, count, dataTestId, dupCount };
  `, { area })
  check(area, 'execute reads title/url/heading/count/getAttribute', reads.ok === true && reads.value?.title === FIXTURE_TITLE && typeof reads.value?.pageUrl === 'string' && reads.value.pageUrl.includes('/index.html') && reads.value?.heading === FIXTURE_TITLE && reads.value?.count > 0 && reads.value?.dataTestId === 'controlled-name', {
    actual: reads.ok === true ? reads.value : reads.raw,
  })
  check(area, 'execute strict role count sees both duplicate buttons', reads.ok === true && reads.value?.dupCount === 2, {
    actual: reads.value?.dupCount,
  })
  const uniq = await execute(`return await page.locator('#submit').isVisible()`, { area })
  check(area, 'execute locator isVisible returns a boolean', uniq.ok === true && uniq.value === true, { actual: uniq.raw })
}

async function areaLocatorStrictness() {
  const area = 'locator-strictness'
  const count = await execute(`return await page.locator('#definitely-absent').count()`, { area })
  check(area, 'locator count of a missing selector returns 0', count.ok === true && count.value === 0, { actual: count.raw })

  const ambiguous = await execute(`await page.getByRole('button', { name: 'Duplicate' }).click(); return 'clicked'`, { area })
  check(area, 'ambiguous role locator action is refused (no .first fallback)', ambiguous.ok === false, {
    actual: ambiguous.error ?? ambiguous.networkError,
  })

  const missingExe = await execute(`await page.locator('#definitely-absent').fill('x'); return 'filled'`, { area })
  check(area, 'execute action on a missing selector returns a typed timeout', missingExe.ok === false && ['timeout', 'outcome-unknown'].includes(missingExe.error?.code), {
    actual: missingExe.error ?? missingExe.networkError,
    request: { kind: 'page.execute', timeoutMs: REQUEST_TIMEOUT_MS },
  })

  const missingProtocol = await send(sessionId, { kind: 'page.click', tabId: state.tabId, selector: '#definitely-absent' }, { area })
  check(area, 'protocol page.click on a missing selector returns a typed timeout', missingProtocol.json?.ok === false && ['timeout', 'outcome-unknown'].includes(missingProtocol.json?.error?.code), {
    actual: missingProtocol.json?.error ?? missingProtocol.networkError,
    request: { kind: 'page.click', timeoutMs: REQUEST_TIMEOUT_MS },
  })
}

async function areaCancellation() {
  const area = 'cancellation'
  const readCount = async () => {
    const result = await execute(`return await page.locator('#cancel-count').textContent()`, { area })
    return result.ok === true ? Number(result.value) : null
  }
  const delayedClick = `
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await wait(1500);
    await page.locator('#cancel-counter').click();
    return 'clicked';
  `

  const before = await readCount()
  const counterReadable = Number.isFinite(before)
  check(area, 'fixture counter readable (Number.isFinite)', counterReadable, { actual: before })
  if (!counterReadable) {
    finding(area, 'counter fixture not readable; cancellation area blocked', {
      expected: 'a finite numeric counter before any action',
      actual: before,
      minimalRepro: "read #cancel-count textContent in the fixture",
      note: 'The initial counter read failed, so no action was started for this area.',
    })
    return
  }

  const requestId = crypto.randomUUID()
  const startedAt = Date.now()
  const executePromise = httpJson('POST', '/browser/v1/request', {
    requestId,
    sessionId,
    timeoutMs: 4000,
    operation: { kind: 'page.execute', tabId: state.tabId, code: delayedClick },
  }, { timeoutMs: TRANSPORT_TIMEOUT_MS })
  await delay(250)
  const cancel = await send(sessionId, { kind: 'request.cancel', targetRequestId: requestId }, { area })
  const cancelOk = cancel.json?.ok === true
  check(area, 'request.cancel returns ok:true', cancelOk, {
    actual: cancel.json ?? cancel.networkError,
    request: { kind: 'request.cancel', targetRequestId: requestId },
  })
  const executeResult = await executePromise
  if (!cancelOk) {
    finding(area, 'request.cancel was not acknowledged; cancellation area blocked', {
      expected: { ok: true },
      actual: cancel.json ?? cancel.networkError,
      request: { kind: 'request.cancel', targetRequestId: requestId },
      note: 'Without an acknowledged cancel the scenario is invalid; the remaining cancellation checks are not asserted.',
    })
    return
  }
  if (executeResult.json === null) {
    skip(area, 'cancelled page.execute returns ok:false with code cancelled', {
      actual: executeResult.networkError,
      note: 'Transport abort or blocked independent worker: no structured result, so this is NOT RUN rather than fabricated.',
    })
    return
  }
  const cancelled = executeResult.json.ok === false && executeResult.json.error?.code === 'cancelled'
  check(area, 'cancelled page.execute returns ok:false with code cancelled', cancelled, {
    expected: { ok: false, code: 'cancelled' },
    actual: executeResult.json,
    request: { kind: 'page.execute', cancelled: true, requestId },
    note: 'A different typed error (timeout/other) is NOT accepted as cancellation success.',
  })
  if (!cancelled) {
    finding(area, 'cancel did not yield a cancelled result; not treated as cancel success', {
      expected: { ok: false, code: 'cancelled' },
      actual: executeResult.json,
      request: { kind: 'page.execute', cancelled: true, requestId },
      note: 'The action may have failed or timed out for another reason; late-dispatch checks are not asserted as cancellation evidence.',
    })
    return
  }

  const elapsed = Date.now() - startedAt
  if (elapsed < 2000) await delay(2000 - elapsed)
  const afterCancel = await readCount()
  check(area, 'cancelled action does not fire after its original wait', afterCancel === before, {
    expected: before,
    actual: afterCancel,
    note: 'Waited past the 1500ms action delay plus margin; the counter must be unchanged.',
  })
  if (afterCancel !== before) {
    finding(area, 'cancelled action fired late', {
      expected: `counter unchanged at ${before}`,
      actual: afterCancel,
      minimalRepro: 'request.cancel a page.execute that waits 1500ms then clicks, then wait past 2000ms',
      note: 'A real late dispatch after cancel. This verifies late-dispatch safety only; it does not reproduce the frame-injection race.',
    })
  }

  const control = await execute(delayedClick, { area })
  check(area, 'positive control: same action fires without cancel', control.ok === true && control.value === 'clicked', {
    actual: control.ok === true ? control.value : control.raw,
  })
  const afterControl = await readCount()
  check(area, 'positive control increments the counter exactly once', afterControl === before + 1, {
    expected: before + 1,
    actual: afterControl,
  })
}

async function areaInsecureContext() {
  const area = 'insecure-context'
  let address = null
  try {
    address = (await dns.lookup('localtest.me')).address
  } catch (error) {
    address = error instanceof Error ? `error:${error.code ?? error.message}` : 'error'
  }
  if (address !== '127.0.0.1') {
    skip(area, 'non-secure HTTP origin probe', {
      actual: address,
      note: 'Wildcard loopback DNS (localtest.me) unavailable; NOT RUN. Loopback origins are secure contexts and cannot exercise this path.',
    })
    return
  }
  const origin = `http://localtest.me:${primary.port}`
  state.insecureOrigin = origin

  const createdTab = await createTabWithRecovery(state.groupId, `${origin}/secure-probe.html`)
  const probeTabId = createdTab.tab?.tabId
  check(area, 'created a controlled tab on a non-localhost HTTP origin', typeof probeTabId === 'string', {
    actual: createdTab.attempt.json?.data ?? createdTab.attempt.error,
  })
  if (!probeTabId) return

  const settled = await waitForTabUrl(probeTabId, (currentUrl) => currentUrl.startsWith(origin) || currentUrl.startsWith('https://localtest.me'))
  const landedUrl = settled.tab?.url ?? ''
  if (!landedUrl.startsWith(origin)) {
    skip(area, 'non-secure HTTP origin probe', {
      actual: landedUrl,
      note: 'Firefox did not land on the plain-HTTP localtest.me origin (possible HTTPS upgrade); NOT RUN.',
    })
    return
  }

  const titleReport = await waitFor(async () => {
    const resolved = await send(sessionId, { kind: 'tab.resolve', tabId: probeTabId }, { area })
    const title = resolved.json?.data?.tab?.title ?? ''
    if (title.startsWith('{')) {
      try {
        return { done: true, report: JSON.parse(title), title }
      } catch {
        return { done: false, title }
      }
    }
    return { done: false, title }
  })
  check(area, 'page realm reports an insecure context without crypto.randomUUID', titleReport.report?.isSecureContext === 'false' && titleReport.report?.randomUUID === 'undefined' && titleReport.report?.getRandomValues === 'function', {
    actual: titleReport.report ?? titleReport.title,
    note: 'Read via the browser tab title; localtest.me resolves to 127.0.0.1 but is not a localhost/secure origin.',
  })

  const snap = await send(sessionId, { kind: 'page.snapshot', tabId: probeTabId }, { area })
  const snapOk = snap.json?.ok === true
  check(area, 'snapshot works on a non-secure HTTP origin', snapOk, {
    actual: snapOk ? { refCount: snap.json.data?.value?.refs?.length } : snap.json?.error ?? snap.networkError,
    request: { kind: 'page.snapshot' },
  })

  const readBack = await execute(`return await page.locator('#probe-heading').textContent()`, { area, tabId: probeTabId })
  check(area, 'content-script locator read works on a non-secure HTTP origin', readBack.ok === true && readBack.value === 'Secure-context probe', {
    actual: readBack.ok === true ? readBack.value : readBack.error ?? readBack.networkError,
  })

  if (!snapOk) {
    finding(area, 'content-script DOM driver fails on a non-secure HTTP origin', {
      expected: 'snapshot/locator reads work on any normal http(s) page the extension can inject into',
      actual: { snapshot: snap.json?.error ?? snap.networkError, locatorRead: readBack.error ?? readBack.networkError },
      request: { kind: 'page.snapshot', tabId: probeTabId, url: `${origin}/secure-probe.html` },
      minimalRepro: 'create a controlled tab on http://localtest.me:<port>/ (page realm insecure) then snapshot',
      note:
        'Page realm is insecure with crypto.randomUUID undefined (browser-API title evidence); the same fixture and driver work on the secure 127.0.0.1 origin. ' +
        'The driver returns the generic "content script returned an invalid result", which is consistent with the owner\'s view.crypto.randomUUID / SecureContext hypothesis on .136. ' +
        'A literal content-script stack trace is not available without opening devtools, so this is high-confidence runtime evidence, not a confirmed P1 root cause. Fix not yet integrated.',
    })
  }
}

async function areaUnsupported() {
  const area = 'unsupported'
  const evaluate = await send(sessionId, { kind: 'page.evaluate', tabId: state.tabId, code: 'return 1 + 1' }, { area })
  check(area, 'page.evaluate is refused without userScripts (unsupported-capability)', evaluate.json?.ok === false && evaluate.json?.error?.code === 'unsupported-capability', {
    expected: 'unsupported-capability',
    actual: evaluate.json?.error ?? evaluate.networkError,
    request: { kind: 'page.evaluate' },
    note: 'Permission must not be auto-granted.',
  })
  check(area, 'evaluate refusal names the userScripts permission', typeof evaluate.json?.error?.message === 'string' && evaluate.json.error.message.toLowerCase().includes('userscripts'), {
    actual: evaluate.json?.error?.message,
  })

  const mouse = await execute(`await page.mouse.click(5, 5); return 'clicked'`, { area })
  check(area, 'execute page.mouse is refused explicitly', mouse.ok === false, {
    actual: mouse.error ?? mouse.networkError,
    request: { kind: 'page.execute', code: 'page.mouse.click' },
  })

  const keyboardDown = await execute(`await page.keyboard.down('a'); return 'down'`, { area })
  check(area, 'execute page.keyboard.down is refused explicitly', keyboardDown.ok === false, {
    actual: keyboardDown.error ?? keyboardDown.networkError,
    request: { kind: 'page.execute', code: 'page.keyboard.down' },
  })

  const evaluateInsideExecute = await execute(`return await page.evaluate(() => 1 + 1)`, { area })
  check(area, 'evaluate inside execute is refused without userScripts', evaluateInsideExecute.ok === false && evaluateInsideExecute.error?.code === 'unsupported-capability', {
    actual: evaluateInsideExecute.error ?? evaluateInsideExecute.networkError,
  })
}

async function areaReleaseAndIsolation() {
  const area = 'release-isolation'
  const releaseResult = await createTabWithRecovery(state.groupId, `${state.baseUrl}/index.html?release=1`)
  const releaseTab = releaseResult.tab
  check(area, 'created a dedicated tab for the release test', typeof releaseTab?.tabId === 'string', { actual: releaseResult.attempt.json?.data ?? releaseResult.attempt.error })
  if (!releaseTab?.tabId) return
  created.tabs.add(releaseTab.tabId)

  const release = await send(sessionId, { kind: 'tabs.release', tabId: releaseTab.tabId }, { area })
  check(area, 'tabs.release succeeds and marks the tab released', release.json?.ok === true && release.json.data?.tab?.state === 'released', {
    actual: release.json?.ok === true ? release.json.data?.tab?.state : release.json?.error ?? release.networkError,
  })

  const afterRelease = await send(sessionId, { kind: 'page.snapshot', tabId: releaseTab.tabId }, { area })
  check(area, 'control of a released tab is refused', afterRelease.json?.ok === false && ['resource-released', 'resource-not-found', 'ownership-mismatch'].includes(afterRelease.json?.error?.code), {
    expected: 'resource-released',
    actual: afterRelease.json?.error ?? afterRelease.networkError,
  })

  const secondGroups = await send(secondSessionId, { kind: 'groups.list' }, { area })
  const secondList = secondGroups.json?.data?.groups ?? []
  check(area, 'a second session cannot list the first session groups', secondList.every((group) => group.sessionId !== sessionId) && !secondList.some((group) => group.groupId === state.groupId), {
    actual: secondList.map((group) => ({ groupId: group.groupId, sessionId: group.sessionId })),
  })

  const secondTabsList = await send(secondSessionId, { kind: 'tabs.list', groupId: state.groupId }, { area })
  check(area, 'a second session cannot list tabs of the first group', secondTabsList.json?.ok === false, {
    actual: secondTabsList.json?.error ?? secondTabsList.json?.data ?? secondTabsList.networkError,
  })

  const secondControl = await send(secondSessionId, { kind: 'page.snapshot', tabId: state.tabId }, { area })
  check(area, 'a second session cannot operate the first session tab', secondControl.json?.ok === false, {
    actual: secondControl.json?.error ?? secondControl.networkError,
  })

  const secondClose = await send(secondSessionId, { kind: 'tabs.close', tabId: state.tabId }, { area })
  check(area, 'a second session cannot close the first session tab', secondClose.json?.ok === false, {
    actual: secondClose.json?.error ?? secondClose.networkError,
  })

  const discovered = await send(sessionId, { kind: 'tabs.discover', profileId: state.profileId }, { area })
  const candidates = discovered.json?.data?.candidates ?? []
  const candidate = candidates.find((entry) => entry.browserTabId === releaseTab.browserTabId)
  if (!candidate) {
    record(area, 'released tab is rediscoverable for cleanup', 'FAIL', {
      actual: candidates.map((entry) => ({ browserTabId: entry.browserTabId, url: entry.url, attachable: entry.attachable })),
      note: 'Released tab not found by discover; it may remain open.',
    })
    return
  }
  const attach = await send(sessionId, { kind: 'tabs.attach', candidateId: candidate.candidateId }, { area })
  check(area, 'released tab can be re-adopted for cleanup', attach.json?.ok === true && typeof attach.json.data?.tab?.tabId === 'string', {
    actual: attach.json?.ok === true ? { tabId: attach.json.data.tab.tabId } : attach.json?.error ?? attach.networkError,
  })
  if (attach.json?.ok === true) {
    const attachedTabId = attach.json.data.tab.tabId
    created.attachedTabs.add(attachedTabId)
    if (attach.json.data.group?.groupId) created.attachedGroups.add(attach.json.data.group.groupId)
    const closed = await send(sessionId, { kind: 'tabs.close', tabId: attachedTabId }, { area })
    check(area, 're-adopted released tab is closed', closed.json?.ok === true, { actual: closed.json?.ok === true ? closed.json.data : closed.json?.error ?? closed.networkError })
  }
}

async function areaIdleObservation() {
  const area = 'idle'
  if (SKIP_IDLE) {
    skip(area, '96s idle connection sampling', { note: 'PI_ACCEPT_SKIP_IDLE=1' })
    return
  }
  const sampleOnce = async () => {
    const [status, profiles] = await Promise.all([
      runtimeGet('/extensions/status', { timeoutMs: 3000 }),
      runtimeGet('/browser/v1/profiles', { timeoutMs: 3000 }),
    ])
    const extension = (status.json?.extensions ?? []).find((entry) => entry.stableKey === `install:Firefox:${state.profileId}`)
    const profile = (profiles.json?.profiles ?? []).find((entry) => entry.profileId === state.profileId)
    return {
      at: new Date().toISOString(),
      connected: profile?.connected ?? false,
      epoch: profile?.browserEpoch ?? null,
      connectionId: extension?.extensionId ?? null,
      version: extension?.playwriterVersion ?? null,
    }
  }
  const initial = await sampleOnce()
  evidence.samples.push(initial)
  let stable = true
  for (let index = 0; index < IDLE_SAMPLE_COUNT; index++) {
    await delay(IDLE_INTERVAL_MS)
    const sample = await sampleOnce()
    evidence.samples.push(sample)
    if (!sample.connected || sample.connectionId !== initial.connectionId || sample.epoch !== initial.epoch || sample.version !== initial.version) stable = false
  }
  const last = evidence.samples[evidence.samples.length - 1]
  check(area, `connection stays stable across ${IDLE_SAMPLE_COUNT * 4}s of read-only sampling`, stable, {
    expected: { connectionId: initial.connectionId, epoch: initial.epoch, version: initial.version, connected: true },
    actual: { connectionId: last.connectionId, epoch: last.epoch, version: last.version, connected: last.connected, samples: evidence.samples.length },
    note: 'No extension operations were sent during sampling.',
  })
}

async function cleanup() {
  const area = 'cleanup'
  for (const groupId of [...created.attachedGroups].reverse()) {
    const result = await send(sessionId, { kind: 'groups.close', groupId }, { area })
    evidence.cleanup.push({ groupId, kind: 'attached-group', ok: result.json?.ok === true, error: result.json?.error })
  }
  for (const tabId of [...created.tabs]) {
    if (created.attachedTabs.has(tabId)) continue
    if (tabId === state.tabId) continue
    const result = await send(sessionId, { kind: 'tabs.close', tabId }, { area })
    evidence.cleanup.push({ tabId, kind: 'tab', ok: result.json?.ok === true, error: result.json?.error })
  }
  for (const groupId of [...created.groups].reverse()) {
    const result = await send(sessionId, { kind: 'groups.close', groupId }, { area })
    evidence.cleanup.push({ groupId, kind: 'group', ok: result.json?.ok === true, error: result.json?.error })
  }
  const remaining = await send(sessionId, { kind: 'tabs.list' }, { area })
  const remainingTabs = (remaining.json?.data?.tabs ?? []).filter((tab) => tab.state !== 'released')
  check(area, 'no live owned tabs remain after cleanup', remainingTabs.length === 0, {
    actual: (remaining.json?.data?.tabs ?? []).map((tab) => ({ tabId: tab.tabId, url: tab.url, state: tab.state })),
    note: 'Released tab records are expected tombstones and are ignored.',
  })
  const discovered = await send(sessionId, { kind: 'tabs.discover', profileId: state.profileId }, { area })
  const leftover = (discovered.json?.data?.candidates ?? []).filter((entry) => typeof entry.url === 'string' && entry.url.startsWith(state.baseUrl))
  check(area, 'no fixture-created physical tabs remain in the browser', leftover.length === 0, {
    actual: leftover.map((entry) => ({ browserTabId: entry.browserTabId, url: entry.url })),
    note: 'Browser-truth check via tabs.discover.',
  })
}

let primary = null
let secondary = null
let blocked = null

try {
  primary = await startServer((request, response) => {
    const requestUrl = new URL(request.url, primary.origin)
    if (requestUrl.pathname === '/frame.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(FRAME_HTML)
      return
    }
    if (requestUrl.pathname === '/frame2.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(FRAME2_HTML)
      return
    }
    if (requestUrl.pathname === '/frame3.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(FRAME3_HTML)
      return
    }
    if (requestUrl.pathname === '/api/echo') {
      const n = Number(requestUrl.searchParams.get('n') || '0')
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ n, text: `payload-${n}-中文-✓-😀` }))
      return
    }
    if (requestUrl.pathname === '/api/big') {
      const kb = Math.min(Number(requestUrl.searchParams.get('kb') || '3072'), 8192)
      response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('X'.repeat(kb * 1024) + '-END-中文')
      return
    }
    if (requestUrl.pathname === '/nav/meta-refresh.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(NAV_META_HTML)
      return
    }
    if (requestUrl.pathname === '/nav/location-replace.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(NAV_LOCATION_HTML)
      return
    }
    if (requestUrl.pathname === '/nav/final.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(NAV_FINAL_HTML(requestUrl.searchParams.get('via') ?? ''))
      return
    }
    if (requestUrl.pathname === '/nav/replace-state.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(NAV_REPLACE_STATE_HTML)
      return
    }
    if (requestUrl.pathname === '/nav/hash-change.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(NAV_HASH_CHANGE_HTML)
      return
    }
    if (requestUrl.pathname === '/nav/hash-target.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(NAV_HASH_TARGET_HTML)
      return
    }
    if (requestUrl.pathname === '/secure-probe.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      response.end(SECURE_PROBE_HTML)
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(indexHtml({ crossOrigin: secondary.origin }))
  })
  secondary = await startServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(CROSS_CHILD_HTML)
  })
  state.baseUrl = primary.origin
  evidence.fixtures = { primary: primary.origin, secondary: secondary.origin }
  console.log(`fixture primary ${primary.origin} secondary ${secondary.origin}`)

  const pre = await preflight()
  blocked = pre.blocked

  if (!blocked) {
    await areaIsolationEmpty()
    const createdOk = await areaGroupAndTab()
    if (createdOk) {
      await areaSnapshotAndRef()
      await areaRoleAndForms()
      await areaHiddenFiltering()
      await areaShadowDom()
      await areaSameOriginFrame()
      await areaCrossOriginFrame()
      await areaIframeGeometry()
      await areaNavigateBack()
      await areaNavigationChain()
      await areaTargetBlank()
      await areaScreenshot()
      await areaNetwork()
      await areaNetworkFilter()
      await areaLogs()
      await areaExecuteReads()
      await areaUnsupported()
      await areaLocatorStrictness()
      await areaCancellation()
      await areaInsecureContext()
      await areaReleaseAndIsolation()
      await areaIdleObservation()
    } else {
      record('create', 'test matrix', 'SKIP', { note: 'Group/tab creation failed; remaining areas not run.' })
    }
  } else {
    record('preflight', 'test matrix', 'SKIP', { note: `Blocked: ${blocked}` })
  }
} catch (error) {
  record('harness', 'unexpected harness error', 'FAIL', {
    actual: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    error: error instanceof Error ? error.stack : undefined,
  })
} finally {
  try {
    if (!blocked) await cleanup()
  } catch (error) {
    record('cleanup', 'cleanup threw', 'FAIL', { actual: error instanceof Error ? error.message : String(error) })
  }
  if (primary) await closeServer(primary.server)
  if (secondary) await closeServer(secondary.server)
}

const counts = { PASS: 0, FAIL: 0, SKIP: 0 }
for (const result of evidence.results) counts[result.status] = (counts[result.status] ?? 0) + 1
evidence.finishedAt = new Date().toISOString()
evidence.summary = { counts, blocked, results: evidence.results.length, findings: evidence.findings.length }
fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), JSON.stringify(evidence, null, 2))

const failures = evidence.results.filter((result) => result.status === 'FAIL')
const lines = [
  `# Firefox swarm acceptance — ${runStamp}`,
  '',
  `- runtime: ${RUNTIME.origin}`,
  `- extension version: ${state.version ?? 'unknown'} (expected ${EXPECTED_VERSION})`,
  `- profileId: ${state.profileId ?? 'unknown'}`,
  `- connectionId: ${state.connectionId ?? 'unknown'}`,
  `- epoch: ${state.epoch ?? 'unknown'}`,
  `- sessionId: ${sessionId}`,
  `- fixtures: ${primary?.origin ?? 'n/a'} , ${secondary?.origin ?? 'n/a'}`,
  '',
  `Result: PASS ${counts.PASS} / FAIL ${counts.FAIL} / SKIP ${counts.SKIP} (+${evidence.findings.length} findings)`,
  blocked ? `Blocked: ${blocked}` : 'Not blocked.',
  '',
  '## Retest watch items (not covered by this baseline build)',
  '',
  ...RETEST_WATCH_ITEMS.map((item) => `- ${item}`),
  '',
  '## Findings',
  '',
  evidence.findings.length === 0
    ? '(none)'
    : evidence.findings
        .map(
          (entry) =>
            `- **${entry.area} :: ${entry.title}**\n    - expected: ${JSON.stringify(entry.expected)}\n    - actual: ${JSON.stringify(entry.actual)}\n    - repro: ${entry.minimalRepro ?? 'n/a'}\n    - note: ${entry.note ?? ''}`,
        )
        .join('\n'),
  '',
  '## Results',
  '',
  ...evidence.results.map((result) => `- [${result.status}] ${result.area} :: ${result.name}${result.status === 'FAIL' ? `\n    - expected: ${JSON.stringify(result.expected)}\n    - actual: ${JSON.stringify(result.actual)}${result.error ? `\n    - error: ${JSON.stringify(result.error)}` : ''}` : ''}`),
  '',
  '## Failures',
  '',
  failures.length === 0 ? '(none)' : failures.map((result) => `- ${result.area} :: ${result.name}: ${JSON.stringify(result.actual)}`).join('\n'),
  '',
]
fs.writeFileSync(path.join(evidenceDir, 'report.md'), lines.join('\n'))

console.log(JSON.stringify({ result: counts, evidence: path.join(evidenceDir, 'evidence.json'), report: path.join(evidenceDir, 'report.md'), failures: failures.length }))
process.exitCode = failures.length > 0 || blocked ? 1 : 0
