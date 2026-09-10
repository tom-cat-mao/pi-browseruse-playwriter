#!/usr/bin/env node
/**
 * Pi browser rebuild acceptance harness.
 *
 * This harness never launches Chrome, never starts a relay and never touches
 * port 19988. The user opens an isolated Chrome profile with the fork extension
 * and starts a dedicated test runtime; the harness then drives the real
 * /browser/v1 HTTP API against the user-specified base URL.
 *
 * Safety rules:
 * - default mode is a dry-run that prints the checklist and planned requests;
 *   nothing connects or starts unless a live mode is explicitly requested.
 * - live modes require PI_BROWSER_ACCEPTANCE=1 and an explicit base URL whose
 *   port is not 19988.
 * - fault phases require PI_BROWSER_ACCEPTANCE_FAULTS=1 plus
 *   --confirm-test-ownership; the harness itself never kills any process.
 * - cleanup acts only on groupIds/tabIds recorded in this run's ledger, and
 *   only while the live inventory still attributes them to the run's sessions.
 *   There is no default context, no pages[0] and no URL-based owner guessing.
 *
 * See playwriter/scripts/acceptance/manual-acceptance.md for the user steps.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as util from 'node:util'
import * as readlinePromises from 'node:readline/promises'
import { fileURLToPath } from 'node:url'

import type { BrowserGroup, BrowserOperation, BrowserProfile, BrowserResponse, BrowserTab } from '../../src/browser-protocol.ts'
import {
  ACCEPTANCE_ENV,
  DAILY_RELAY_PORT,
  EXPECTED_PROTOCOL_VERSION,
  extractAriaRefs,
  counterDelta,
  faultChecklist,
  mainChecklist,
  makeBrowserRequest,
  redactAcceptanceConfig,
  runAcceptanceSelfChecks,
  selectOwnedResources,
  validateAcceptanceConfig,
  type AcceptanceConfig,
  type CleanupPolicy,
  type ConfigIssue,
  type FaultPhase,
  type HarnessMode,
} from './acceptance-plan.ts'
import {
  AcceptanceTimeoutError,
  callBrowserApi,
  fetchChromeTargets,
  getCapabilities,
  listProfiles,
  pollUntil,
  probeRuntime,
  type RuntimeEndpoint,
} from './acceptance-client.ts'
import { readFixtureCounters, startFixtureServer, type FixtureServer } from './fixture-server.ts'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..', '..', '..')

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

type StepStatus = 'pass' | 'fail' | 'skipped'

type StepResult = {
  id: string
  title: string
  status: StepStatus
  evidence: string
  userConfirmed?: boolean
  details?: unknown
}

type LedgerGroup = { groupId: string; sessionId: string; profileId: string; name: string }
type LedgerTab = { tabId: string; groupId: string; sessionId: string; url: string; purpose: string }

type Ledger = {
  runId: string
  createdAt: string
  baseUrl: string
  fixtureBaseUrl: string
  sessions: { a: string; b: string }
  profileIds: string[]
  groups: LedgerGroup[]
  tabs: LedgerTab[]
  finalRevisionByProfile: Record<string, number>
}

type RunState = {
  config: AcceptanceConfig
  runId: string
  /**
   * Random per-process suffix mixed into every requestId. The relay dedupes by
   * requestId, so re-running a phase against the same run ledger must never
   * repeat request ids from the earlier pass.
   */
  requestNonce: string
  endpoint: RuntimeEndpoint
  fixture: FixtureServer | null
  fixtureBaseUrl: string
  requestCounter: number
  results: StepResult[]
  ledger: Ledger
  chosenProfiles: BrowserProfile[]
  ids: {
    groupA1: string
    groupA2: string
    groupA3: string | null
    groupB1: string
    tabA1: string
    tabA2: string
    tabB1: string
    tabB2: string
  }
  countersBefore: Record<string, number>
  lastSnapshotId: string | null
}

function printUsage(): void {
  console.log(`pi browser acceptance harness (no browser launch, no daily relay)

usage:
  node playwriter/scripts/acceptance/acceptance-harness.ts [mode] [options]

modes (default: --dry-run):
  --dry-run                  validate gates and print the checklist + planned requests; connects nothing
  --list                     print the acceptance checklist only
  --self-test                run the pure gate/plan checks and exit
  --run                      execute the live acceptance run (requires the hard gates below)
  --fault-mode               run --fault-phase steps against a ledger from a finished --run
  --cleanup-only             close only the resources recorded in --state, nothing else
  --fixture-server           start the local fixture HTTP server and keep it running

live options:
  --base-url <url>           test runtime base URL, e.g. http://127.0.0.1:19990
  --token <token>            runtime token when the test runtime is configured with one
  --profile <profileId>      explicit managed profile id; repeatable
  --session-a <uuid>         pin Pi session A UUID (default: random)
  --session-b <uuid>         pin Pi session B UUID (default: random)
  --fixture-server           start fixture pages inside this process (or --fixture-url <url> instead)
  --fixture-url <url>        use an already running fixture server
  --fixture-port <port>      fixture server port (default: ephemeral)
  --chrome-cdp <url>         optional Chrome DevTools endpoint of the isolated Chrome for a target cross-check
  --timeout-ms <ms>          per-request timeout (default 30000)
  --report-dir <dir>         where to write report/ledger (default: <repo>/tmp/acceptance)
  --state <file>             ledger file for --fault-mode / --cleanup-only
  --cleanup <policy>         on-success | always | never (default: on-success)
  --non-interactive          never prompt; manual steps are reported as skipped
  --confirm-test-ownership   required for fault phases: everything visible belongs to this test
  --allow-remote-host        allow a non-loopback runtime host (token still required)
  --json                     print the final summary as JSON

hard gates:
  --run / --fault-mode / --cleanup-only require ${ACCEPTANCE_ENV.runGate}=1
  fault phases additionally require ${ACCEPTANCE_ENV.faultGate}=1 and --confirm-test-ownership
  the base URL port ${DAILY_RELAY_PORT} is refused unconditionally

checks after the user opened Chrome (see manual-acceptance.md):
  1. build the fork extension with PLAYWRITER_PORT=<test port>
  2. open an isolated Chrome profile and load the unpacked extension
  3. start the test runtime with PI_BROWSER_PORT=<test port> and a separate data dir
  4. ${ACCEPTANCE_ENV.runGate}=1 node playwriter/scripts/acceptance/acceptance-harness.ts --run --base-url http://127.0.0.1:<test port> --fixture-server
`)
}

function parseMode({ values }: { values: Record<string, unknown> }): HarnessMode | { error: string } {
  const selected: HarnessMode[] = []
  if (values['dry-run']) {
    selected.push('dry-run')
  }
  if (values.list) {
    selected.push('list')
  }
  if (values['self-test']) {
    selected.push('self-test')
  }
  if (values.run) {
    selected.push('run')
  }
  if (values['fault-mode']) {
    selected.push('faults')
  }
  if (values['cleanup-only']) {
    selected.push('cleanup-only')
  }
  if (selected.length > 1) {
    return { error: `choose exactly one mode, got: ${selected.join(', ')}` }
  }
  return selected[0] || 'dry-run'
}

type CliValues = Record<string, string | boolean | Array<string | boolean> | undefined>

function readCliConfig({ argv }: { argv: string[] }): AcceptanceConfig | { error: string } {
  let parsed: { values: CliValues; positionals: string[] }
  try {
    parsed = util.parseArgs({
      args: argv,
      options: {
        'dry-run': { type: 'boolean' },
        list: { type: 'boolean' },
        'self-test': { type: 'boolean' },
        run: { type: 'boolean' },
        'fault-mode': { type: 'boolean' },
        'cleanup-only': { type: 'boolean' },
        'fixture-server': { type: 'boolean' },
        'base-url': { type: 'string' },
        token: { type: 'string' },
        profile: { type: 'string', multiple: true },
        'session-a': { type: 'string' },
        'session-b': { type: 'string' },
        'fixture-url': { type: 'string' },
        'fixture-port': { type: 'string' },
        'fault-phase': { type: 'string', multiple: true },
        'confirm-test-ownership': { type: 'boolean' },
        cleanup: { type: 'string' },
        'report-dir': { type: 'string' },
        'timeout-ms': { type: 'string' },
        'chrome-cdp': { type: 'string' },
        state: { type: 'string' },
        json: { type: 'boolean' },
        'non-interactive': { type: 'boolean' },
        'allow-remote-host': { type: 'boolean' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
      strict: true,
    }) as { values: CliValues; positionals: string[] }
  } catch (error) {
    return { error: `invalid arguments: ${error instanceof Error ? error.message : String(error)}` }
  }

  if (parsed.values.help) {
    printUsage()
    process.exit(0)
  }

  const mode = parseMode({ values: parsed.values })
  if (typeof mode === 'object') {
    return mode
  }

  const faultPhases = (parsed.values['fault-phase'] || []) as string[]
  const allowedPhases: FaultPhase[] = ['ws-drop', 'relay-restart', 'sw-restart', 'drag-out', 'worker-kill']
  const badPhase = faultPhases.find((phase) => !allowedPhases.includes(phase as FaultPhase))
  if (badPhase) {
    return { error: `unknown fault phase "${badPhase}", allowed: ${allowedPhases.join(', ')}` }
  }

  const cleanup = (parsed.values.cleanup || 'on-success') as string
  if (!['on-success', 'always', 'never'].includes(cleanup)) {
    return { error: `--cleanup must be on-success, always or never, got "${cleanup}"` }
  }

  const timeoutMs = parsed.values['timeout-ms'] ? Number(parsed.values['timeout-ms']) : 30000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { error: `--timeout-ms must be a positive number, got "${parsed.values['timeout-ms']}"` }
  }

  const fixturePort = parsed.values['fixture-port'] ? Number(parsed.values['fixture-port']) : 0
  if (!Number.isInteger(fixturePort) || fixturePort < 0 || fixturePort > 65535) {
    return { error: `--fixture-port must be a valid port, got "${parsed.values['fixture-port']}"` }
  }

  return {
    mode,
    baseUrl: (parsed.values['base-url'] as string | undefined) || process.env[ACCEPTANCE_ENV.baseUrl] || null,
    token: (parsed.values.token as string | undefined) || process.env[ACCEPTANCE_ENV.token] || null,
    profiles: (parsed.values.profile || []) as string[],
    sessionA: (parsed.values['session-a'] as string | undefined) || crypto.randomUUID(),
    sessionB: (parsed.values['session-b'] as string | undefined) || crypto.randomUUID(),
    fixtureServer: Boolean(parsed.values['fixture-server']),
    fixtureUrl: (parsed.values['fixture-url'] as string | undefined) || null,
    fixturePort,
    faultPhases: faultPhases as FaultPhase[],
    confirmTestOwnership: Boolean(parsed.values['confirm-test-ownership']),
    cleanup: cleanup as CleanupPolicy,
    reportDir: (parsed.values['report-dir'] as string | undefined) || path.join(repoRoot, 'tmp', 'acceptance'),
    timeoutMs,
    chromeCdpUrl: (parsed.values['chrome-cdp'] as string | undefined) || process.env[ACCEPTANCE_ENV.chromeCdp] || null,
    json: Boolean(parsed.values.json),
    statePath: (parsed.values.state as string | undefined) || null,
    nonInteractive: Boolean(parsed.values['non-interactive']) || !process.stdin.isTTY,
    allowRemoteHost: Boolean(parsed.values['allow-remote-host']),
  }
}

// ---------------------------------------------------------------------------
// Small typed helpers
// ---------------------------------------------------------------------------

function truncate({ value, max = 300 }: { value: string; max?: number }): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

function requireSuccess({ response, what }: { response: BrowserResponse; what: string }) {
  if (!response.ok) {
    throw new Error(
      `${what} failed: ${response.error.code}: ${response.error.message} (outcome: ${response.error.outcome})`,
    )
  }
  return response.data
}

function requireFailure({
  response,
  what,
  allowedCodes,
}: {
  response: BrowserResponse
  what: string
  allowedCodes?: string[]
}): { code: string; outcome: string; message: string } {
  if (response.ok) {
    throw new Error(`${what} unexpectedly succeeded`)
  }
  const failure = response.error
  if (allowedCodes && !allowedCodes.includes(failure.code)) {
    throw new Error(`${what} failed with unexpected code ${failure.code}: ${failure.message} (allowed: ${allowedCodes.join(', ')})`)
  }
  return { code: failure.code, outcome: failure.outcome, message: failure.message }
}

function resultContainsString({ response, needle }: { response: BrowserResponse; needle: string }): boolean {
  if (!response.ok) {
    return false
  }
  return JSON.stringify(response.data).includes(needle)
}

function idsOf({ values }: { values: { groupId?: string; tabId?: string }[] }): string[] {
  return values.map((value) => value.groupId || value.tabId || '').filter(Boolean)
}

function sameIdSet({ left, right }: { left: string[]; right: string[] }): boolean {
  if (left.length !== right.length) {
    return false
  }
  const rightSet = new Set(right)
  return left.every((id) => rightSet.has(id))
}

// ---------------------------------------------------------------------------
// Step recording
// ---------------------------------------------------------------------------

type StepOutcome = {
  evidence: string
  details?: unknown
  status?: StepStatus
  skipReason?: string
  userConfirmed?: boolean
}

async function runStep({
  state,
  id,
  title,
  fn,
}: {
  state: RunState
  id: string
  title: string
  fn: () => Promise<StepOutcome>
}): Promise<StepResult> {
  process.stdout.write(`[ .. ] ${id}: ${title}\n`)
  try {
    const outcome = await fn()
    const status: StepStatus = outcome.status || 'pass'
    const result: StepResult = {
      id,
      title,
      status,
      evidence: status === 'skipped' ? outcome.skipReason || outcome.evidence : outcome.evidence,
      details: outcome.details,
      userConfirmed: outcome.userConfirmed,
    }
    state.results.push(result)
    process.stdout.write(`[${status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'SKIP'}] ${id}: ${truncate({ value: result.evidence })}\n`)
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result: StepResult = { id, title, status: 'fail', evidence: message, details: { stack: error instanceof Error ? error.stack : null } }
    state.results.push(result)
    process.stdout.write(`[FAIL] ${id}: ${message}\n`)
    return result
  }
}

// ---------------------------------------------------------------------------
// Live helpers
// ---------------------------------------------------------------------------

function nextRequestId({ state, prefix }: { state: RunState; prefix: string }): string {
  state.requestCounter += 1
  return `${prefix}-${state.runId}-${state.requestNonce}-${state.requestCounter}`
}

async function apiCall({
  state,
  sessionId,
  operation,
  timeoutMs,
}: {
  state: RunState
  sessionId: string
  operation: BrowserOperation
  timeoutMs?: number
}): Promise<{ requestId: string; response: BrowserResponse }> {
  const requestId = nextRequestId({ state, prefix: operation.kind.replace(/[^a-z0-9]+/gi, '-') })
  const response = await callBrowserApi({
    endpoint: state.endpoint,
    request: makeBrowserRequest({ requestId, sessionId, operation, timeoutMs }),
    timeoutMs: state.config.timeoutMs,
  })
  return { requestId, response }
}

async function listGroups({ state, sessionId, profileId }: { state: RunState; sessionId: string; profileId?: string }): Promise<BrowserGroup[]> {
  const operation = profileId ? ({ kind: 'groups.list', profileId } as const) : ({ kind: 'groups.list' } as const)
  const { response } = await apiCall({ state, sessionId, operation })
  const data = requireSuccess({ response, what: 'groups.list' })
  return data.groups || []
}

async function listTabs({
  state,
  sessionId,
  groupId,
}: {
  state: RunState
  sessionId: string
  groupId?: string
}): Promise<BrowserTab[]> {
  const operation = groupId ? ({ kind: 'tabs.list', groupId } as const) : ({ kind: 'tabs.list' } as const)
  const { response } = await apiCall({ state, sessionId, operation })
  const data = requireSuccess({ response, what: 'tabs.list' })
  return data.tabs || []
}

async function waitForUser({ state, message }: { state: RunState; message: string }): Promise<boolean> {
  if (state.config.nonInteractive) {
    return false
  }
  const rl = readlinePromises.createInterface({ input: process.stdin, output: process.stdout })
  try {
    await rl.question(`\n>>> ${message}\n>>> press Enter when done: `)
    return true
  } finally {
    rl.close()
  }
}

async function snapshotTab({
  state,
  sessionId,
  tabId,
}: {
  state: RunState
  sessionId: string
  tabId: string
}): Promise<{ snapshotId: string; text: string }> {
  const { response } = await apiCall({ state, sessionId, operation: { kind: 'page.snapshot', tabId } })
  const data = requireSuccess({ response, what: 'page.snapshot' })
  if (!data.snapshotId) {
    throw new Error('page.snapshot returned no snapshotId; click/fill snapshot verification cannot continue')
  }
  state.lastSnapshotId = data.snapshotId
  return { snapshotId: data.snapshotId, text: data.text || '' }
}

async function evaluateInTab({
  state,
  sessionId,
  tabId,
  code,
}: {
  state: RunState
  sessionId: string
  tabId: string
  code: string
}): Promise<BrowserResponse> {
  const { response } = await apiCall({ state, sessionId, operation: { kind: 'page.evaluate', tabId, code } })
  return response
}

async function readCounters({ state }: { state: RunState }): Promise<Record<string, number>> {
  return await readFixtureCounters({ baseUrl: state.fixtureBaseUrl })
}

// ---------------------------------------------------------------------------
// Ledger and report
// ---------------------------------------------------------------------------

function writeJsonFile({ filePath, value }: { filePath: string; value: unknown }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf-8')
}

function ledgerPath({ state }: { state: RunState }): string {
  return path.join(state.config.reportDir, `ledger-${state.runId}.json`)
}

function saveLedger({ state }: { state: RunState }): void {
  writeJsonFile({ filePath: ledgerPath({ state }), value: state.ledger })
}

function loadLedger({ filePath }: { filePath: string }): Ledger {
  const raw = fs.readFileSync(filePath, 'utf-8')
  return JSON.parse(raw) as Ledger
}

function writeReport({ state, extra, nameSuffix }: { state: RunState; extra?: Record<string, unknown>; nameSuffix?: string }): string {
  const reportPath = path.join(state.config.reportDir, `report-${state.runId}${nameSuffix ? `-${nameSuffix}` : ''}.json`)
  const passed = state.results.filter((result) => result.status === 'pass').length
  const failed = state.results.filter((result) => result.status === 'fail').length
  const skipped = state.results.filter((result) => result.status === 'skipped').length
  writeJsonFile({
    filePath: reportPath,
    value: {
      runId: state.runId,
      createdAt: new Date().toISOString(),
      config: redactAcceptanceConfig({ config: state.config }),
      summary: { passed, failed, skipped, total: state.results.length },
      steps: state.results,
      ledger: state.ledger,
      ...extra,
    },
  })
  return reportPath
}

function printSummary({ state, reportPath, ledgerLabel }: { state: RunState; reportPath: string; ledgerLabel?: string }): void {
  const passed = state.results.filter((result) => result.status === 'pass').length
  const failed = state.results.filter((result) => result.status === 'fail')
  const skipped = state.results.filter((result) => result.status === 'skipped')
  console.log('\n================ acceptance summary ================')
  console.log(`PASS ${passed}  FAIL ${failed.length}  SKIPPED ${skipped.length}`)
  for (const result of failed) {
    console.log(`FAIL ${result.id}: ${result.evidence}`)
  }
  for (const result of skipped) {
    console.log(`SKIP ${result.id}: ${result.evidence}`)
  }
  console.log(`report: ${reportPath}`)
  console.log(`ledger: ${ledgerLabel || ledgerPath({ state })}`)
}

// ---------------------------------------------------------------------------
// Main live run
// ---------------------------------------------------------------------------

function createState({
  config,
  fixtureBaseUrl,
}: {
  config: AcceptanceConfig
  fixtureBaseUrl: string
}): RunState {
  const runId = crypto.randomBytes(4).toString('hex')
  const endpoint: RuntimeEndpoint = { baseUrl: config.baseUrl || '', token: config.token }
  const state: RunState = {
    config,
    runId,
    requestNonce: crypto.randomBytes(3).toString('hex'),
    endpoint,
    fixture: null,
    fixtureBaseUrl,
    requestCounter: 0,
    results: [],
    chosenProfiles: [],
    ids: { groupA1: '', groupA2: '', groupA3: null, groupB1: '', tabA1: '', tabA2: '', tabB1: '', tabB2: '' },
    countersBefore: {},
    lastSnapshotId: null,
    ledger: {
      runId,
      createdAt: new Date().toISOString(),
      baseUrl: endpoint.baseUrl,
      fixtureBaseUrl,
      sessions: { a: config.sessionA, b: config.sessionB },
      profileIds: [],
      groups: [],
      tabs: [],
      finalRevisionByProfile: {},
    },
  }
  return state
}

function recordGroup({ state, group, purpose }: { state: RunState; group: BrowserGroup; purpose: string }): void {
  state.ledger.groups.push({ groupId: group.groupId, sessionId: group.sessionId, profileId: group.profileId, name: group.name })
  saveLedger({ state })
  void purpose
}

function recordTab({ state, tab, purpose }: { state: RunState; tab: BrowserTab; purpose: string }): void {
  state.ledger.tabs.push({ tabId: tab.tabId, groupId: tab.groupId, sessionId: tab.sessionId, url: tab.url, purpose })
  saveLedger({ state })
}

async function createGroup({
  state,
  sessionId,
  profileId,
  name,
}: {
  state: RunState
  sessionId: string
  profileId: string
  name: string
}): Promise<BrowserGroup> {
  const { response } = await apiCall({ state, sessionId, operation: { kind: 'groups.create', profileId, name } })
  const data = requireSuccess({ response, what: 'groups.create' })
  if (!data.group) {
    throw new Error('groups.create returned no group in the response')
  }
  return data.group
}

async function createTab({
  state,
  sessionId,
  groupId,
  url,
  purpose,
}: {
  state: RunState
  sessionId: string
  groupId: string
  url: string
  purpose: string
}): Promise<BrowserTab> {
  const { response } = await apiCall({ state, sessionId, operation: { kind: 'tabs.create', groupId, url } })
  const data = requireSuccess({ response, what: 'tabs.create' })
  if (!data.tab) {
    throw new Error('tabs.create returned no tab in the response')
  }
  recordTab({ state, tab: data.tab, purpose })
  return data.tab
}

async function runMainPhase({ state }: { state: RunState }): Promise<void> {
  console.log(`acceptance run ${state.runId} against ${state.endpoint.baseUrl}`)
  saveLedger({ state })

  // --- preflight ---------------------------------------------------------
  await runStep({
    state,
    id: 'preflight-capabilities',
    title: 'capabilities expose the managed contract',
    fn: async () => {
      const capabilities = await getCapabilities({ endpoint: state.endpoint, timeoutMs: state.config.timeoutMs })
      if (capabilities.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
        throw new Error(`protocolVersion ${capabilities.protocolVersion}, expected ${EXPECTED_PROTOCOL_VERSION}`)
      }
      const required = ['managedGroups', 'persistentOwnership', 'explicitTabs', 'isolatedExecution'] as const
      const missing = required.filter((key) => capabilities[key] !== true)
      if (missing.length > 0) {
        throw new Error(`runtime lacks required capabilities: ${missing.join(', ')}`)
      }
      return { evidence: `protocolVersion=1, all of ${required.join('/')} true`, details: capabilities }
    },
  })

  const profilesResult = await runStep({
    state,
    id: 'preflight-profiles',
    title: 'resolve the connected profile set explicitly',
    fn: async () => {
      const profiles = await listProfiles({ endpoint: state.endpoint, timeoutMs: state.config.timeoutMs })
      const connected = profiles.filter((profile) => profile.connected)
      if (connected.length === 0) {
        throw new Error(
          'no connected managed profile. Open the isolated Chrome with the fork extension and check the extension service worker console (see manual-acceptance.md).',
        )
      }
      if (state.config.profiles.length > 0) {
        const unknown = state.config.profiles.filter((id) => !connected.some((profile) => profile.profileId === id))
        if (unknown.length > 0) {
          throw new Error(`--profile ids not connected: ${unknown.join(', ')}; connected: ${connected.map((p) => p.profileId).join(', ')}`)
        }
        state.chosenProfiles = connected.filter((profile) => state.config.profiles.includes(profile.profileId))
      } else if (connected.length === 1) {
        state.chosenProfiles = connected
      } else {
        throw new Error(
          `${connected.length} profiles are connected; pass --profile for every profile you want to include (${connected
            .map((p) => p.profileId)
            .join(', ')})`,
        )
      }
      state.ledger.profileIds = state.chosenProfiles.map((profile) => profile.profileId)
      saveLedger({ state })
      return {
        evidence: `${connected.length} connected; chosen ${state.chosenProfiles.map((p) => `${p.profileId}(${p.browser})`).join(', ')}`,
        details: state.chosenProfiles.map((profile) => ({ profileId: profile.profileId, browser: profile.browser, epoch: profile.browserEpoch })),
      }
    },
  })
  if (profilesResult.status === 'fail') {
    return
  }

  const sharedName = `acc-${state.runId}-shared-name`
  const primaryProfile = state.chosenProfiles[0]

  await runStep({
    state,
    id: 'groups-create-a1',
    title: 'session A group A1 on the first profile',
    fn: async () => {
      const group = await createGroup({ state, sessionId: state.config.sessionA, profileId: primaryProfile.profileId, name: sharedName })
      state.ids.groupA1 = group.groupId
      recordGroup({ state, group, purpose: 'A1' })
      return { evidence: `groupId=${group.groupId} name=${group.name} state=${group.state}`, details: group }
    },
  })

  await runStep({
    state,
    id: 'groups-create-a2',
    title: 'session A group A2 with the same name',
    fn: async () => {
      const group = await createGroup({ state, sessionId: state.config.sessionA, profileId: primaryProfile.profileId, name: sharedName })
      if (group.groupId === state.ids.groupA1) {
        throw new Error(`same-name groups were merged: groupId ${group.groupId} equals A1`)
      }
      state.ids.groupA2 = group.groupId
      recordGroup({ state, group, purpose: 'A2' })
      return { evidence: `distinct groupId=${group.groupId} with identical name ${JSON.stringify(sharedName)}` }
    },
  })

  await runStep({
    state,
    id: 'groups-create-b1',
    title: 'session B group B1 with the same name',
    fn: async () => {
      const group = await createGroup({ state, sessionId: state.config.sessionB, profileId: primaryProfile.profileId, name: sharedName })
      state.ids.groupB1 = group.groupId
      recordGroup({ state, group, purpose: 'B1' })
      return { evidence: `groupId=${group.groupId} for session B, distinct from ${state.ids.groupA1}/${state.ids.groupA2}` }
    },
  })

  await runStep({
    state,
    id: 'groups-session-filter',
    title: 'groups.list is strictly session filtered',
    fn: async () => {
      const groupsA = await listGroups({ state, sessionId: state.config.sessionA })
      const groupsB = await listGroups({ state, sessionId: state.config.sessionB })
      const expectedA = [state.ids.groupA1, state.ids.groupA2].filter(Boolean)
      const missingA = expectedA.filter((id) => !groupsA.some((group) => group.groupId === id))
      if (missingA.length > 0) {
        throw new Error(`session A listing is missing ${missingA.join(', ')}: ${JSON.stringify(idsOf({ values: groupsA }))}`)
      }
      if (!groupsB.some((group) => group.groupId === state.ids.groupB1)) {
        throw new Error(`session B listing is missing ${state.ids.groupB1}: ${JSON.stringify(idsOf({ values: groupsB }))}`)
      }
      const foreignInA = groupsA.filter((group) => group.sessionId !== state.config.sessionA)
      if (foreignInA.length > 0) {
        throw new Error(`session A listing leaked foreign groups: ${JSON.stringify(foreignInA.map((group) => group.groupId))}`)
      }
      const leakedIntoB = groupsB.filter((group) => group.sessionId === state.config.sessionA || expectedA.includes(group.groupId))
      if (leakedIntoB.length > 0) {
        throw new Error(`session B listing leaked session A groups: ${JSON.stringify(leakedIntoB.map((group) => group.groupId))}`)
      }
      const ourSameName = groupsA.filter((group) => expectedA.includes(group.groupId) && group.name === sharedName)
      if (ourSameName.length !== 2) {
        throw new Error(`expected 2 same-name groups in session A, got ${JSON.stringify(ourSameName.map((group) => group.groupId))}`)
      }
      return {
        evidence: `A sees ${groupsA.length} groups including 2 distinct same-name ids (${expectedA.join(', ')}), B sees only its own group`,
        details: { groupsA, groupsB },
      }
    },
  })

  await runStep({
    state,
    id: 'multi-profile',
    title: 'one session spans two profiles without cross-talk',
    fn: async () => {
      const secondary = state.chosenProfiles[1]
      if (!secondary) {
        return { status: 'skipped', skipReason: 'only one managed profile is connected/selected; pass a second --profile to exercise this', evidence: '' }
      }
      const group = await createGroup({ state, sessionId: state.config.sessionA, profileId: secondary.profileId, name: sharedName })
      state.ids.groupA3 = group.groupId
      recordGroup({ state, group, purpose: 'A3-secondary-profile' })
      const listingPrimary = await listGroups({ state, sessionId: state.config.sessionA, profileId: primaryProfile.profileId })
      const listingSecondary = await listGroups({ state, sessionId: state.config.sessionA, profileId: secondary.profileId })
      if (listingPrimary.some((candidate) => candidate.groupId === group.groupId)) {
        throw new Error(`profile-filtered listing leaked the secondary profile group ${group.groupId}`)
      }
      if (!listingSecondary.some((candidate) => candidate.groupId === group.groupId)) {
        throw new Error(`secondary profile listing does not contain its own group ${group.groupId}`)
      }
      return {
        evidence: `session A owns groups on ${primaryProfile.profileId} and ${secondary.profileId}; filtered listings stay isolated`,
        details: { primaryCount: listingPrimary.length, secondaryCount: listingSecondary.length },
      }
    },
  })

  // --- tabs and page operations -----------------------------------------
  await runStep({
    state,
    id: 'tab-create-a1',
    title: 'tabs.create returns a ready owned tab with targetId',
    fn: async () => {
      const tab = await createTab({
        state,
        sessionId: state.config.sessionA,
        groupId: state.ids.groupA1,
        url: `${state.fixtureBaseUrl}/group-page.html?marker=A1-${state.runId}`,
        purpose: 'A1-main',
      })
      state.ids.tabA1 = tab.tabId
      if (tab.groupId !== state.ids.groupA1) {
        throw new Error(`tab group ${tab.groupId} does not match requested group ${state.ids.groupA1}`)
      }
      if (tab.state !== 'ready') {
        throw new Error(`tab state ${tab.state}, expected ready`)
      }
      if (!tab.targetId) {
        throw new Error('tab has no targetId; page operations would have no explicit target')
      }
      if (typeof tab.chromeTabId !== 'number') {
        throw new Error('tab has no chromeTabId')
      }
      const tabsA = await listTabs({ state, sessionId: state.config.sessionA, groupId: state.ids.groupA1 })
      if (!tabsA.some((candidate) => candidate.tabId === tab.tabId)) {
        throw new Error('new tab is missing from the session tab inventory')
      }
      return { evidence: `tabId=${tab.tabId} targetId=${tab.targetId} chromeTabId=${tab.chromeTabId} state=ready`, details: tab }
    },
  })

  await runStep({
    state,
    id: 'tab-create-a2-b1',
    title: 'group A2 and group B1 get their own tabs',
    fn: async () => {
      const tabA2 = await createTab({
        state,
        sessionId: state.config.sessionA,
        groupId: state.ids.groupA2,
        url: `${state.fixtureBaseUrl}/group-page.html?marker=A2-${state.runId}`,
        purpose: 'A2-drag-candidate',
      })
      state.ids.tabA2 = tabA2.tabId
      const tabB1 = await createTab({
        state,
        sessionId: state.config.sessionB,
        groupId: state.ids.groupB1,
        url: `${state.fixtureBaseUrl}/group-page.html?marker=B1-${state.runId}`,
        purpose: 'B1-last-tab',
      })
      state.ids.tabB1 = tabB1.tabId
      const tabB2 = await createTab({
        state,
        sessionId: state.config.sessionB,
        groupId: state.ids.groupB1,
        url: `${state.fixtureBaseUrl}/group-page.html?marker=B2-${state.runId}`,
        purpose: 'B2-release-candidate',
      })
      state.ids.tabB2 = tabB2.tabId
      for (const [tab, groupId] of [
        [tabA2, state.ids.groupA2],
        [tabB1, state.ids.groupB1],
        [tabB2, state.ids.groupB1],
      ] as const) {
        if (tab.groupId !== groupId) {
          throw new Error(`tab ${tab.tabId} landed in group ${tab.groupId}, expected ${groupId}`)
        }
      }
      return { evidence: `A2 tab=${tabA2.tabId}, B1 tabs=${tabB1.tabId}/${tabB2.tabId}` }
    },
  })

  await runStep({
    state,
    id: 'cdp-target-crosscheck',
    title: 'optional: real Chrome still has the recorded targetIds',
    fn: async () => {
      if (!state.config.chromeCdpUrl) {
        return { status: 'skipped', skipReason: 'no --chrome-cdp endpoint given; relay inventory is the only evidence for target existence', evidence: '' }
      }
      const tabs = await listTabs({ state, sessionId: state.config.sessionA })
      const targetIds = tabs.map((tab) => tab.targetId).filter((targetId): targetId is string => Boolean(targetId))
      const { targets, browserWsUrl } = await fetchChromeTargets({ cdpUrl: state.config.chromeCdpUrl, timeoutMs: state.config.timeoutMs })
      const found = new Set(targets.map((target) => target.targetId))
      const missing = targetIds.filter((targetId) => !found.has(targetId))
      if (missing.length > 0) {
        throw new Error(`Chrome does not report targetIds ${missing.join(', ')} (browser ws ${browserWsUrl})`)
      }
      return { evidence: `${targetIds.length} recorded targetIds confirmed by Chrome ${browserWsUrl}` }
    },
  })

  await runStep({
    state,
    id: 'snapshot-click',
    title: 'page.snapshot -> page.click with snapshotId',
    fn: async () => {
      const { snapshotId, text } = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const marker = `acceptance:A1-${state.runId}`
      if (!text.includes(marker)) {
        throw new Error(`snapshot text does not contain the fixture marker ${marker}`)
      }
      const refs = extractAriaRefs({ snapshotText: text })
      state.countersBefore = await readCounters({ state })
      const { response } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.click', tabId: state.ids.tabA1, selector: '[data-testid="submit-fill"]', snapshotId },
      })
      requireSuccess({ response, what: 'page.click' })
      const tag = `submit-fill-A1-${state.runId}`
      const after = await pollUntil({
        description: `fixture counter ${tag} reaches 1`,
        timeoutMs: 8000,
        intervalMs: 300,
        check: async () => {
          const counters = await readCounters({ state })
          const delta = counterDelta({ before: state.countersBefore, after: counters, tag })
          if (delta === 1) {
            return { done: true as const, value: counters }
          }
          return { done: false as const, detail: `delta=${delta}` }
        },
      })
      if (refs.length === 0) {
        return {
          evidence: `clicked [data-testid=submit-fill] with snapshotId=${snapshotId}; counter delta 1. snapshot text exposes no aria-ref= token, positive ref click not exercised`,
          details: { after },
        }
      }
      return {
        evidence: `clicked with snapshotId=${snapshotId}; snapshot exposes ${refs.length} aria-ref tokens (${refs.slice(0, 3).join(', ')}); counter delta 1`,
        details: { after },
      }
    },
  })

  await runStep({
    state,
    id: 'fill-and-verify',
    title: 'page.fill with snapshotId and visible value check',
    fn: async () => {
      const value = `acceptance-value-${state.runId}`
      const fresh = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const { response: fillResponse } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.fill', tabId: state.ids.tabA1, selector: '[data-testid="name-input"]', value, snapshotId: fresh.snapshotId },
      })
      requireSuccess({ response: fillResponse, what: 'page.fill' })
      const valueRead = await evaluateInTab({
        state,
        sessionId: state.config.sessionA,
        tabId: state.ids.tabA1,
        code: `document.querySelector('[data-testid="name-input"]').value`,
      })
      const readData = requireSuccess({ response: valueRead, what: 'page.evaluate input value' })
      const observed = String(readData.value ?? readData.text ?? '')
      if (observed !== value) {
        throw new Error(`input value is ${JSON.stringify(observed)}, expected ${JSON.stringify(value)}`)
      }
      const beforeClick = await readCounters({ state })
      const second = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const { response: clickResponse } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.click', tabId: state.ids.tabA1, selector: '[data-testid="submit-fill"]', snapshotId: second.snapshotId },
      })
      requireSuccess({ response: clickResponse, what: 'page.click after fill' })
      const echoRead = await evaluateInTab({
        state,
        sessionId: state.config.sessionA,
        tabId: state.ids.tabA1,
        code: `document.querySelector('[data-testid="echo"]').textContent`,
      })
      const echoData = requireSuccess({ response: echoRead, what: 'page.evaluate echo text' })
      if (String(echoData.value ?? echoData.text ?? '') !== value) {
        throw new Error('echo text did not receive the filled value through a real click')
      }
      const logsResponse = await apiCall({ state, sessionId: state.config.sessionA, operation: { kind: 'page.logs', tabId: state.ids.tabA1, limit: 200 } })
      const logsData = requireSuccess({ response: logsResponse.response, what: 'page.logs' })
      const logLines = logsData.logs || []
      const submittedLog = `[fixture] fill-submitted ${value}`
      if (!logLines.some((line) => line.includes(submittedLog))) {
        throw new Error(`page.logs has no line containing ${JSON.stringify(submittedLog)} (got ${logLines.length} lines)`)
      }
      const tag = `submit-fill-A1-${state.runId}`
      const counters = await pollUntil({
        description: `fixture counter ${tag} reaches 2`,
        timeoutMs: 8000,
        intervalMs: 300,
        check: async () => {
          const current = await readCounters({ state })
          const delta = counterDelta({ before: beforeClick, after: current, tag })
          if (delta === 2) {
            return { done: true as const, value: current }
          }
          return { done: false as const, detail: `delta=${delta}` }
        },
      })
      state.countersBefore = counters
      return {
        evidence: `fill(${value}) verified in DOM, click produced echo+log, counter delta exactly 2`,
        details: { snapshotId: fresh.snapshotId, submittedLog, logLines: logLines.length },
      }
    },
  })

  await runStep({
    state,
    id: 'stale-snapshot',
    title: 'stale snapshotId is rejected without side effects',
    fn: async () => {
      const staleSnapshotId = state.lastSnapshotId
      if (!staleSnapshotId) {
        throw new Error('no earlier snapshotId was recorded')
      }
      const fresh = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      if (fresh.snapshotId === staleSnapshotId) {
        throw new Error('snapshotId did not change after a DOM mutation; stale detection cannot be exercised')
      }
      const before = await readCounters({ state })
      const { response } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.click', tabId: state.ids.tabA1, selector: '[data-testid="submit-fill"]', snapshotId: staleSnapshotId },
      })
      const failure = requireFailure({ response, what: 'stale snapshot click', allowedCodes: ['stale-snapshot'] })
      await new Promise((resolve) => {
        setTimeout(resolve, 1500)
      })
      const after = await readCounters({ state })
      const delta = counterDelta({ before, after, tag: `submit-fill-A1-${state.runId}` })
      if (delta !== 0) {
        throw new Error(`stale snapshot click produced a side effect (counter delta ${delta})`)
      }
      return { evidence: `rejected with ${failure.code} (${failure.outcome}); fixture counter delta 0` }
    },
  })

  await runStep({
    state,
    id: 'unknown-ref',
    title: 'unknown aria-ref fails without clicking anything',
    fn: async () => {
      const fresh = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const before = await readCounters({ state })
      const { response } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.fill', tabId: state.ids.tabA1, selector: 'aria-ref=e99999', value: 'should-not-apply', snapshotId: fresh.snapshotId },
      })
      const failure = requireFailure({ response, what: 'fill with unknown aria-ref' })
      const after = await readCounters({ state })
      const delta = counterDelta({ before, after, tag: `submit-fill-A1-${state.runId}` })
      if (delta !== 0) {
        throw new Error(`unknown aria-ref produced a side effect (counter delta ${delta})`)
      }
      return { evidence: `rejected with ${failure.code} (${failure.outcome}); no fixture side effect` }
    },
  })

  await runStep({
    state,
    id: 'page-network',
    title: 'page.network observes the fixture request exactly once',
    fn: async () => {
      const tag = `fetch-echo-A1-${state.runId}`
      const before = await readCounters({ state })
      const startResponse = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.network', tabId: state.ids.tabA1, action: 'start', filter: '/api/echo' },
      })
      requireSuccess({ response: startResponse.response, what: 'page.network start' })
      const fresh = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const clickResponse = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.click', tabId: state.ids.tabA1, selector: '[data-testid="fetch-echo"]', snapshotId: fresh.snapshotId },
      })
      requireSuccess({ response: clickResponse.response, what: 'click fetch-echo' })
      const listPoll = await pollUntil({
        description: 'page.network list contains the fixture request',
        timeoutMs: 10000,
        intervalMs: 500,
        check: async () => {
          const listResponse = await apiCall({
            state,
            sessionId: state.config.sessionA,
            operation: { kind: 'page.network', tabId: state.ids.tabA1, action: 'list', filter: '/api/echo' },
          })
          const found = resultContainsString({ response: listResponse.response, needle: `/api/echo?tag=${tag}` })
          if (found) {
            return { done: true as const, value: listResponse.response }
          }
          return { done: false as const, detail: truncate({ value: JSON.stringify(listResponse.response).slice(0, 200) }) }
        },
      })
      const stopResponse = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.network', tabId: state.ids.tabA1, action: 'stop' },
      })
      requireSuccess({ response: stopResponse.response, what: 'page.network stop' })
      const after = await readCounters({ state })
      const delta = counterDelta({ before, after, tag })
      if (delta !== 1) {
        throw new Error(`fixture echo counter delta ${delta}, expected exactly 1`)
      }
      return { evidence: `network list matched /api/echo?tag=${tag} and server counter delta is 1`, details: { list: truncate({ value: JSON.stringify(listPoll), max: 600 }) } }
    },
  })

  await runStep({
    state,
    id: 'popup-target-blank',
    title: 'target=_blank link opens inside the source group',
    fn: async () => {
      const beforeTabs = await listTabs({ state, sessionId: state.config.sessionA, groupId: state.ids.groupA1 })
      const beforeIds = new Set(idsOf({ values: beforeTabs }))
      const fresh = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const { response } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.click', tabId: state.ids.tabA1, selector: '[data-testid="blank-link"]', snapshotId: fresh.snapshotId },
      })
      requireSuccess({ response, what: 'click target=_blank link' })
      const expected = `/popup-page.html?marker=A1-${state.runId}`
      const popup = await pollUntil({
        description: 'new popup tab appears in session A group A1',
        timeoutMs: 15000,
        intervalMs: 400,
        check: async () => {
          const tabs = await listTabs({ state, sessionId: state.config.sessionA, groupId: state.ids.groupA1 })
          const candidate = tabs.find((tab) => !beforeIds.has(tab.tabId) && tab.url.includes(expected))
          if (candidate) {
            return { done: true as const, value: candidate }
          }
          return { done: false as const, detail: `tabs: ${tabs.map((tab) => `${tab.tabId}:${tab.url}`).join(', ')}` }
        },
      })
      if (popup.groupId !== state.ids.groupA1) {
        throw new Error(`popup landed in group ${popup.groupId}, expected ${state.ids.groupA1}`)
      }
      if (popup.sessionId !== state.config.sessionA) {
        throw new Error(`popup session ${popup.sessionId} is not session A`)
      }
      recordTab({ state, tab: popup, purpose: 'popup-target-blank' })
      return { evidence: `popup tabId=${popup.tabId} groupId=${popup.groupId} url=${popup.url}` }
    },
  })

  await runStep({
    state,
    id: 'popup-window-open',
    title: 'window.open popup opens inside the source group',
    fn: async () => {
      const beforeTabs = await listTabs({ state, sessionId: state.config.sessionA, groupId: state.ids.groupA1 })
      const beforeIds = new Set(idsOf({ values: beforeTabs }))
      const fresh = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      const { response } = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'page.click', tabId: state.ids.tabA1, selector: '[data-testid="open-popup"]', snapshotId: fresh.snapshotId },
      })
      requireSuccess({ response, what: 'click window.open popup button' })
      const expected = `/popup-page.html?marker=A1-${state.runId}`
      const popup = await pollUntil({
        description: 'window.open popup appears in session A group A1',
        timeoutMs: 15000,
        intervalMs: 400,
        check: async () => {
          const tabs = await listTabs({ state, sessionId: state.config.sessionA, groupId: state.ids.groupA1 })
          const candidate = tabs.find((tab) => !beforeIds.has(tab.tabId) && tab.url.includes(expected))
          if (candidate) {
            return { done: true as const, value: candidate }
          }
          return { done: false as const, detail: `tabs: ${tabs.map((tab) => `${tab.tabId}:${tab.url}`).join(', ')}` }
        },
      })
      recordTab({ state, tab: popup, purpose: 'popup-window-open' })
      return { evidence: `popup tabId=${popup.tabId} groupId=${popup.groupId} url=${popup.url}` }
    },
  })

  await runStep({
    state,
    id: 'popup-visual',
    title: 'user confirms the popups are inside the group in Chrome',
    fn: async () => {
      const confirmed = await waitForUser({
        state,
        message: `In the isolated Chrome, confirm that the two popup tabs (${state.ids.tabA1}'s group, marker A1-${state.runId}) are inside the SAME Chrome tab group as the fixture page, then press Enter.`,
      })
      if (!confirmed) {
        return { status: 'skipped', skipReason: 'non-interactive session; visual placement not user-confirmed', evidence: '' }
      }
      return { evidence: 'user visually confirmed both popups are inside the source Chrome group', userConfirmed: true }
    },
  })

  // --- ownership, release and cancel ------------------------------------
  await runStep({
    state,
    id: 'cross-session-rejection',
    title: 'session B cannot operate on session A resources',
    fn: async () => {
      const { response } = await apiCall({
        state,
        sessionId: state.config.sessionB,
        operation: { kind: 'page.snapshot', tabId: state.ids.tabA1 },
      })
      const failure = requireFailure({ response, what: 'session B snapshot of A tab', allowedCodes: ['ownership-mismatch'] })
      const tabsB = await listTabs({ state, sessionId: state.config.sessionB })
      if (tabsB.some((tab) => tab.tabId === state.ids.tabA1)) {
        throw new Error('session B tab listing leaked session A resources')
      }
      const groupsB = await listGroups({ state, sessionId: state.config.sessionB })
      if (groupsB.some((group) => group.groupId === state.ids.groupA1 || group.groupId === state.ids.groupA2)) {
        throw new Error('session B group listing leaked session A groups')
      }
      return { evidence: `rejected with ${failure.code}; B listings contain no A resources` }
    },
  })

  await runStep({
    state,
    id: 'tab-release-semantics',
    title: 'tabs.release keeps the group and blocks later actions',
    fn: async () => {
      const releaseResponse = await apiCall({ state, sessionId: state.config.sessionB, operation: { kind: 'tabs.release', tabId: state.ids.tabB2 } })
      requireSuccess({ response: releaseResponse.response, what: 'tabs.release' })
      const tabsB = await listTabs({ state, sessionId: state.config.sessionB })
      const released = tabsB.find((tab) => tab.tabId === state.ids.tabB2)
      if (!released || released.state !== 'released') {
        throw new Error(`released tab state is ${released?.state || 'missing'}, expected released`)
      }
      const snapshotResponse = await apiCall({
        state,
        sessionId: state.config.sessionB,
        operation: { kind: 'page.snapshot', tabId: state.ids.tabB2 },
      })
      const failure = requireFailure({ response: snapshotResponse.response, what: 'snapshot of released tab', allowedCodes: ['resource-released'] })
      const groupsB = await listGroups({ state, sessionId: state.config.sessionB })
      if (!groupsB.some((group) => group.groupId === state.ids.groupB1)) {
        throw new Error('group disappeared after a tab release')
      }
      return { evidence: `tab state released, page action rejected with ${failure.code}, group B1 still listed` }
    },
  })

  await runStep({
    state,
    id: 'session-release-retains',
    title: 'session.release keeps resources and stays operable',
    fn: async () => {
      const releaseB = await apiCall({ state, sessionId: state.config.sessionB, operation: { kind: 'session.release' } })
      requireSuccess({ response: releaseB.response, what: 'session.release (B)' })
      const groupsB = await listGroups({ state, sessionId: state.config.sessionB })
      if (!groupsB.some((group) => group.groupId === state.ids.groupB1)) {
        throw new Error('session B group was deleted by session.release')
      }
      const tabsB = await listTabs({ state, sessionId: state.config.sessionB })
      if (!tabsB.some((tab) => tab.tabId === state.ids.tabB1)) {
        throw new Error('session B tab was deleted by session.release')
      }
      const releaseA = await apiCall({ state, sessionId: state.config.sessionA, operation: { kind: 'session.release' } })
      requireSuccess({ response: releaseA.response, what: 'session.release (A)' })
      const groupsA = await listGroups({ state, sessionId: state.config.sessionA })
      const expectedA = [state.ids.groupA1, state.ids.groupA2, state.ids.groupA3].filter((id): id is string => Boolean(id))
      const missingA = expectedA.filter((id) => !groupsA.some((group) => group.groupId === id))
      if (missingA.length > 0) {
        throw new Error(`session A groups changed after release, missing ${missingA.join(', ')}: ${JSON.stringify(idsOf({ values: groupsA }))}`)
      }
      const afterRelease = await snapshotTab({ state, sessionId: state.config.sessionA, tabId: state.ids.tabA1 })
      if (!afterRelease.text.includes(`acceptance:A1-${state.runId}`)) {
        throw new Error('snapshot after release did not return the fixture page')
      }
      return { evidence: 'groups and tabs retained for both sessions; a post-release snapshot re-acquired the executor' }
    },
  })

  await runStep({
    state,
    id: 'cancel-no-replay',
    title: 'request.cancel reports unknown outcome and never replays',
    fn: async () => {
      const tag = `cancel-probe-${state.runId}`
      const before = await readCounters({ state })
      const executeCode = `await new Promise((resolve) => setTimeout(resolve, 4000)); await fetch('${state.fixtureBaseUrl}/api/slow?ms=100&tag=${tag}')`
      const requestId = nextRequestId({ state, prefix: 'page-execute-cancel-probe' })
      const inFlight = callBrowserApi({
        endpoint: state.endpoint,
        request: makeBrowserRequest({
          requestId,
          sessionId: state.config.sessionA,
          operation: { kind: 'page.execute', tabId: state.ids.tabA1, code: executeCode },
          timeoutMs: 60000,
        }),
        timeoutMs: 60000,
      })
      await new Promise((resolve) => {
        setTimeout(resolve, 800)
      })
      const cancelResponse = await apiCall({
        state,
        sessionId: state.config.sessionA,
        operation: { kind: 'request.cancel', targetRequestId: requestId },
      })
      requireSuccess({ response: cancelResponse.response, what: 'request.cancel' })
      const original = await inFlight
      let outcomeNote: string
      if (original.ok) {
        outcomeNote = 'action completed before cancel took effect'
      } else {
        if (original.error.outcome !== 'unknown' && original.error.code !== 'cancelled') {
          throw new Error(`in-flight action reported ${original.error.code}/${original.error.outcome}, expected unknown outcome after cancel`)
        }
        outcomeNote = `original response ${original.error.code}/${original.error.outcome}`
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5200)
      })
      const after = await readCounters({ state })
      const delta = counterDelta({ before, after, tag })
      if (delta > 1) {
        throw new Error(`cancel probe ran ${delta} times; the runtime must not replay cancelled actions`)
      }
      const afterSecondRead = await readCounters({ state })
      if (counterDelta({ before: after, after: afterSecondRead, tag }) !== 0) {
        throw new Error('cancel probe counter kept growing after the request finished')
      }
      return { evidence: `${outcomeNote}; counter delta ${delta} and stable afterwards (no replay)`, details: { tag } }
    },
  })
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

async function cleanupOwnResources({ state, ledger }: { state: RunState; ledger: Ledger }): Promise<void> {
  await runStep({
    state,
    id: 'cleanup-own-only',
    title: 'cleanup closes only resources recorded by this run',
    fn: async () => {
      const groups: BrowserGroup[] = []
      const tabs: BrowserTab[] = []
      for (const sessionId of [ledger.sessions.a, ledger.sessions.b]) {
        groups.push(...(await listGroups({ state, sessionId })))
        tabs.push(...(await listTabs({ state, sessionId })))
      }
      const selection = selectOwnedResources({
        sessionIds: [ledger.sessions.a, ledger.sessions.b],
        recordedGroupIds: ledger.groups.map((group) => group.groupId),
        recordedTabIds: ledger.tabs.map((tab) => tab.tabId),
        groups,
        tabs,
      })
      const closedTabs: string[] = []
      const leftReleased: string[] = []
      for (const tab of selection.tabs) {
        if (tab.state !== 'ready') {
          leftReleased.push(`${tab.tabId}:${tab.state}`)
          continue
        }
        const { response } = await apiCall({ state, sessionId: tab.sessionId, operation: { kind: 'tabs.close', tabId: tab.tabId } })
        if (!response.ok) {
          if (response.error.code === 'resource-released') {
            leftReleased.push(`${tab.tabId}:released`)
            continue
          }
          throw new Error(`tabs.close ${tab.tabId} failed: ${response.error.code}: ${response.error.message}`)
        }
        closedTabs.push(tab.tabId)
      }
      await pollUntil({
        description: 'recorded ready tabs disappear from the inventory',
        timeoutMs: 15000,
        intervalMs: 500,
        check: async () => {
          const remaining: BrowserTab[] = []
          for (const sessionId of [ledger.sessions.a, ledger.sessions.b]) {
            remaining.push(...(await listTabs({ state, sessionId })))
          }
          const stillReady = remaining.filter((tab) => selection.tabs.some((owned) => owned.tabId === tab.tabId) && tab.state === 'ready')
          if (stillReady.length === 0) {
            return { done: true as const, value: remaining }
          }
          return { done: false as const, detail: `still ready: ${stillReady.map((tab) => tab.tabId).join(', ')}` }
        },
      })
      const closedGroups: string[] = []
      for (const group of selection.groups) {
        if (group.state !== 'ready') {
          continue
        }
        const { response } = await apiCall({ state, sessionId: group.sessionId, operation: { kind: 'groups.close', groupId: group.groupId } })
        if (!response.ok && response.error.code !== 'resource-released') {
          throw new Error(`groups.close ${group.groupId} failed: ${response.error.code}: ${response.error.message}`)
        }
        closedGroups.push(group.groupId)
      }
      await pollUntil({
        description: 'recorded groups disappear from the inventory',
        timeoutMs: 15000,
        intervalMs: 500,
        check: async () => {
          const remaining: BrowserGroup[] = []
          for (const sessionId of [ledger.sessions.a, ledger.sessions.b]) {
            remaining.push(...(await listGroups({ state, sessionId })))
          }
          const stillReady = remaining.filter((group) => selection.groups.some((owned) => owned.groupId === group.groupId) && group.state === 'ready')
          if (stillReady.length === 0) {
            return { done: true as const, value: remaining }
          }
          return { done: false as const, detail: `still ready: ${stillReady.map((group) => group.groupId).join(', ')}` }
        },
      })
      return {
        evidence: `closed ${closedTabs.length} tabs and ${closedGroups.length} groups; left released/user-owned tabs untouched (${leftReleased.join(', ') || 'none'}); rejected ${selection.rejected.length} foreign records`,
        details: { closedTabs, closedGroups, leftReleased, rejected: selection.rejected },
      }
    },
  })
}

// ---------------------------------------------------------------------------
// Fault phases
// ---------------------------------------------------------------------------

async function runFaultPhases({ config, ledger }: { config: AcceptanceConfig; ledger: Ledger }): Promise<RunState> {
  // Fault phases need a fixture server that outlives the main run process, so
  // an explicit --fixture-url wins over the URL recorded in the ledger.
  const state = createState({ config, fixtureBaseUrl: config.fixtureUrl || ledger.fixtureBaseUrl })
  state.runId = ledger.runId
  state.ledger = ledger
  state.results = []

  const inventorySnapshot = async () => {
    const groups: BrowserGroup[] = []
    const tabs: BrowserTab[] = []
    for (const sessionId of [ledger.sessions.a, ledger.sessions.b]) {
      groups.push(...(await listGroups({ state, sessionId })))
      tabs.push(...(await listTabs({ state, sessionId })))
    }
    return { groups, tabs }
  }

  const recordedGroupIds = ledger.groups.map((group) => group.groupId)
  const recordedTabIds = ledger.tabs.map((tab) => tab.tabId)

  for (const phase of config.faultPhases) {
    if (phase === 'ws-drop' || phase === 'relay-restart') {
      await runStep({
        state,
        id: `${phase}-relay-down`,
        title: 'user stops the test runtime and the endpoint goes unreachable',
        fn: async () => {
          const started = await waitForUser({
            state,
            message: `Stop the TEST runtime now (Ctrl+C in its terminal; it must not be port ${DAILY_RELAY_PORT}). Press Enter after it stopped.`,
          })
          if (!started) {
            return { status: 'skipped', skipReason: 'non-interactive session; fault step is user-driven', evidence: '' }
          }
          const probe = await pollUntil({
            description: 'runtime endpoint becomes unreachable',
            timeoutMs: 20000,
            intervalMs: 1000,
            check: async () => {
              const result = await probeRuntime({ endpoint: state.endpoint, timeoutMs: 2000 })
              if (result.state === 'down') {
                return { done: true as const, value: result }
              }
              return { done: false as const, detail: `${result.state}: ${result.detail}` }
            },
          })
          return { evidence: `endpoint unreachable: ${probe.detail}` }
        },
      })
      await runStep({
        state,
        id: `${phase}-relay-up`,
        title: 'user restarts the runtime and resources come back',
        fn: async () => {
          const started = await waitForUser({
            state,
            message: `Start the TEST runtime again with the same PI_BROWSER_PORT/DATA_DIR/token. Press Enter once it prints it is listening.`,
          })
          if (!started) {
            return { status: 'skipped', skipReason: 'non-interactive session; fault step is user-driven', evidence: '' }
          }
          await pollUntil({
            description: 'runtime endpoint is ready again',
            timeoutMs: 120000,
            intervalMs: 2000,
            check: async () => {
              const result = await probeRuntime({ endpoint: state.endpoint, timeoutMs: 3000 })
              if (result.state === 'ready') {
                return { done: true as const, value: result }
              }
              return { done: false as const, detail: `${result.state}: ${result.detail}` }
            },
          })
          const { groups, tabs } = await pollUntil({
            description: 'recorded resources reappear after reconnect',
            timeoutMs: 60000,
            intervalMs: 2000,
            check: async () => {
              const snapshot = await inventorySnapshot()
              const groupIds = snapshot.groups.map((group) => group.groupId).filter((id) => recordedGroupIds.includes(id))
              const tabIds = snapshot.tabs.map((tab) => tab.tabId).filter((id) => recordedTabIds.includes(id))
              if (sameIdSet({ left: groupIds, right: recordedGroupIds }) && sameIdSet({ left: tabIds, right: recordedTabIds })) {
                return { done: true as const, value: snapshot }
              }
              return { done: false as const, detail: `groups=${groupIds.length}/${recordedGroupIds.length} tabs=${tabIds.length}/${recordedTabIds.length}` }
            },
          })
          const readyTabs = tabs.filter((tab) => recordedTabIds.includes(tab.tabId) && tab.state === 'ready')
          const expectedReady = ledger.tabs.filter((tab) => tab.purpose !== 'B2-release-candidate').length
          if (readyTabs.length < Math.min(expectedReady, recordedTabIds.length)) {
            throw new Error(`only ${readyTabs.length} recorded tabs are ready after reconnect, expected at least ${expectedReady}`)
          }
          const snapshotState = await snapshotTab({ state, sessionId: ledger.sessions.a, tabId: ledger.tabs.find((tab) => tab.purpose === 'A1-main')?.tabId || recordedTabIds[0] })
          if (!snapshotState.text.includes('acceptance:')) {
            throw new Error('post-restart snapshot did not return fixture content')
          }
          state.ledger.finalRevisionByProfile = Object.fromEntries(groups.map((group) => [group.profileId, group.revision]))
          return {
            evidence: `same ${groups.length} groups and ${tabs.length} tabs after restart, ${readyTabs.length} ready, page snapshot works again`,
          }
        },
      })
    }

    if (phase === 'sw-restart') {
      await runStep({
        state,
        id: 'sw-restart-reload',
        title: 'user reloads the fork extension service worker',
        fn: async () => {
          const started = await waitForUser({
            state,
            message:
              'Open chrome://extensions in the isolated Chrome, find the fork extension card (eeklahpecooapnailfaebkjjembkjhhg), click its reload button. Press Enter after it reconnects.',
          })
          if (!started) {
            return { status: 'skipped', skipReason: 'non-interactive session; fault step is user-driven', evidence: '' }
          }
          const { groups, tabs } = await pollUntil({
            description: 'inventory republished with the same resources',
            timeoutMs: 90000,
            intervalMs: 2000,
            check: async () => {
              const snapshot = await inventorySnapshot()
              const groupIds = snapshot.groups.map((group) => group.groupId).filter((id) => recordedGroupIds.includes(id))
              const tabIds = snapshot.tabs.map((tab) => tab.tabId).filter((id) => recordedTabIds.includes(id))
              const profilesReady = snapshot.groups.length === 0 || snapshot.groups.every((group) => group.state !== 'disconnected')
              if (sameIdSet({ left: groupIds, right: recordedGroupIds }) && sameIdSet({ left: tabIds, right: recordedTabIds }) && profilesReady) {
                return { done: true as const, value: snapshot }
              }
              return { done: false as const, detail: `groups=${groupIds.length}/${recordedGroupIds.length} tabs=${tabIds.length}/${recordedTabIds.length} connected=${profilesReady}` }
            },
          })
          const mainTabId = ledger.tabs.find((tab) => tab.purpose === 'A1-main')?.tabId || recordedTabIds[0]
          const snapshotState = await snapshotTab({ state, sessionId: ledger.sessions.a, tabId: mainTabId })
          if (!snapshotState.text.includes('acceptance:')) {
            throw new Error('post-SW-reload snapshot did not return fixture content')
          }
          return { evidence: `same ${groups.length} groups and ${tabs.length} tabs after SW reload; page snapshot works`, details: { mainTabId } }
        },
      })
    }

    if (phase === 'drag-out') {
      await runStep({
        state,
        id: 'drag-out-user',
        title: 'user drags the A2 tab out of its Chrome group',
        fn: async () => {
          const candidate = ledger.tabs.find((tab) => tab.purpose === 'A2-drag-candidate')
          if (!candidate) {
            return { status: 'skipped', skipReason: 'ledger has no A2-drag-candidate tab', evidence: '' }
          }
          const started = await waitForUser({
            state,
            message: `In the isolated Chrome, drag ONLY the tab whose page shows "acceptance:A2-${ledger.runId}" out of its tab group into no group. Press Enter after dragging.`,
          })
          if (!started) {
            return { status: 'skipped', skipReason: 'non-interactive session; fault step is user-driven', evidence: '' }
          }
          const released = await pollUntil({
            description: 'dragged tab is recorded as released',
            timeoutMs: 60000,
            intervalMs: 1000,
            check: async () => {
              const tabs = await listTabs({ state, sessionId: ledger.sessions.a })
              const tab = tabs.find((candidateTab) => candidateTab.tabId === candidate.tabId)
              if (tab && tab.state === 'released') {
                return { done: true as const, value: tab }
              }
              return { done: false as const, detail: `state=${tab?.state || 'missing'}` }
            },
          })
          const snapshotResponse = await apiCall({
            state,
            sessionId: ledger.sessions.a,
            operation: { kind: 'page.snapshot', tabId: candidate.tabId },
          })
          const failure = requireFailure({ response: snapshotResponse.response, what: 'snapshot of user-dragged tab', allowedCodes: ['resource-released'] })
          const groups = await listGroups({ state, sessionId: ledger.sessions.a })
          if (!groups.some((group) => group.groupId === candidate.groupId)) {
            throw new Error('group disappeared after the user dragged its tab out')
          }
          return { evidence: `tab ${candidate.tabId} recorded released after user drag-out; page action rejected ${failure.code}; group still listed` }
        },
      })
      await runStep({
        state,
        id: 'drag-out-last-tab',
        title: 'optional: dragging out the last tab keeps the empty group',
        fn: async () => {
          const candidate = ledger.tabs.find((tab) => tab.purpose === 'B1-last-tab')
          if (!candidate) {
            return { status: 'skipped', skipReason: 'ledger has no B1-last-tab', evidence: '' }
          }
          const started = await waitForUser({
            state,
            message: `Now drag the LAST tab of session B's group (page shows "acceptance:B1-${ledger.runId}") out of its group. Press Enter after dragging.`,
          })
          if (!started) {
            return { status: 'skipped', skipReason: 'non-interactive session; fault step is user-driven', evidence: '' }
          }
          await pollUntil({
            description: 'last tab is recorded as released',
            timeoutMs: 60000,
            intervalMs: 1000,
            check: async () => {
              const tabs = await listTabs({ state, sessionId: ledger.sessions.b })
              const tab = tabs.find((candidateTab) => candidateTab.tabId === candidate.tabId)
              if (tab && tab.state === 'released') {
                return { done: true as const, value: tab }
              }
              return { done: false as const, detail: `state=${tab?.state || 'missing'}` }
            },
          })
          const tabs = await listTabs({ state, sessionId: ledger.sessions.b, groupId: candidate.groupId })
          const ready = tabs.filter((tab) => tab.state === 'ready')
          if (ready.length !== 0) {
            throw new Error(`group still has ${ready.length} ready tabs after the last tab was dragged out`)
          }
          const groups = await listGroups({ state, sessionId: ledger.sessions.b })
          if (!groups.some((group) => group.groupId === candidate.groupId)) {
            throw new Error('empty group disappeared after the last tab was dragged out')
          }
          return { evidence: `group ${candidate.groupId} kept with 0 ready tabs after the last tab was dragged out` }
        },
      })
    }

    if (phase === 'worker-kill') {
      await runStep({
        state,
        id: 'worker-kill-inflight',
        title: 'user kills the executor worker during a long page.execute',
        fn: async () => {
          const mainTab = ledger.tabs.find((tab) => tab.purpose === 'A1-main') || ledger.tabs[0]
          if (!mainTab) {
            return { status: 'skipped', skipReason: 'ledger has no tabs', evidence: '' }
          }
          if (!state.fixtureBaseUrl) {
            throw new Error(
              'no reachable fixture server for the counter check: start one with --fixture-server in another terminal and pass --fixture-url to this fault run',
            )
          }
          const tag = `worker-kill-${ledger.runId}-${state.requestNonce}`
          // Fail fast (before starting the long execute) when the fixture is down.
          const before = await readCounters({ state })
          const executeCode = `await new Promise((resolve) => setTimeout(resolve, 15000)); await fetch('${state.fixtureBaseUrl}/api/echo?tag=${tag}')`
          const requestId = nextRequestId({ state, prefix: 'page-execute-worker-kill' })
          const inFlight = callBrowserApi({
            endpoint: state.endpoint,
            request: makeBrowserRequest({
              requestId,
              sessionId: ledger.sessions.a,
              operation: { kind: 'page.execute', tabId: mainTab.tabId, code: executeCode },
              timeoutMs: 90000,
            }),
            timeoutMs: 90000,
          })
          await new Promise((resolve) => {
            setTimeout(resolve, 3000)
          })
          const started = await waitForUser({
            state,
            message:
              'Kill ONLY the executor worker child process of the test runtime (find it with: lsof -ti tcp:<test port> then pgrep -P <runtime pid>; never kill Chrome). Press Enter after killing it.',
          })
          if (!started) {
            return { status: 'skipped', skipReason: 'non-interactive session; fault step is user-driven', evidence: '' }
          }
          const original = await inFlight
          const failure = requireFailure({ response: original, what: 'worker-killed page.execute' })
          if (failure.outcome !== 'unknown') {
            throw new Error(`killed execution reported outcome ${failure.outcome} (${failure.code}); a killed worker must report unknown`)
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 3000)
          })
          const after = await readCounters({ state })
          const delta = counterDelta({ before, after, tag })
          if (delta > 1) {
            throw new Error(`worker-killed action ran ${delta} times; the runtime must not replay it`)
          }
          const heal = await apiCall({ state, sessionId: ledger.sessions.a, operation: { kind: 'groups.list' } })
          requireSuccess({ response: heal.response, what: 'groups.list after worker kill' })
          return {
            evidence: `killed execution reported ${failure.code}/${failure.outcome}; fixture counter delta ${delta} (no replay); relay still healthy`,
            details: { tag },
          }
        },
      })
    }
  }
  return state
}

async function runCleanupOnly({ config }: { config: AcceptanceConfig }): Promise<void> {
  const ledger = loadLedger({ filePath: config.statePath as string })
  const state = createState({ config, fixtureBaseUrl: config.fixtureUrl || '' })
  state.runId = ledger.runId
  state.ledger = ledger
  console.log(`cleanup-only for run ${ledger.runId} using ledger ${config.statePath}`)
  await cleanupOwnResources({ state, ledger })
  const reportPath = writeReport({ state, extra: { mode: 'cleanup-only' }, nameSuffix: 'cleanup' })
  printSummary({ state, reportPath, ledgerLabel: config.statePath || undefined })
}

async function runLive({ config }: { config: AcceptanceConfig }): Promise<void> {
  const state = createState({ config, fixtureBaseUrl: config.fixtureUrl || '' })
  let fixture: FixtureServer | null = null
  const onSigint = () => {
    console.log('\ninterrupted; writing ledger and report before exit')
    if (fixture) {
      void fixture.close()
    }
    const reportPath = writeReport({ state, extra: { interrupted: true } })
    printSummary({ state, reportPath })
    console.log(`cleanup later with: ${ACCEPTANCE_ENV.runGate}=1 node playwriter/scripts/acceptance/acceptance-harness.ts --cleanup-only --base-url ${config.baseUrl} --state ${ledgerPath({ state })} (add --token if the runtime uses one)`)
    process.exit(130)
  }
  process.once('SIGINT', onSigint)
  try {
    if (config.fixtureServer) {
      fixture = await startFixtureServer({ port: config.fixturePort })
      state.fixture = fixture
      state.fixtureBaseUrl = fixture.baseUrl
      state.ledger.fixtureBaseUrl = fixture.baseUrl
      saveLedger({ state })
      console.log(`fixture server: ${state.fixtureBaseUrl} (fixtures: ${path.join(scriptDir, 'fixtures')})`)
    }
    if (state.fixtureBaseUrl) {
      const probe = await fetch(new URL('/api/counts', state.fixtureBaseUrl).toString(), { signal: AbortSignal.timeout(5000) })
      if (!probe.ok) {
        throw new Error(`fixture server at ${state.fixtureBaseUrl} answered HTTP ${probe.status}`)
      }
    }
    await runMainPhase({ state })

    const failed = state.results.some((result) => result.status === 'fail')
    const shouldCleanup = config.cleanup === 'always' || (config.cleanup === 'on-success' && !failed)
    if (shouldCleanup) {
      await cleanupOwnResources({ state, ledger: state.ledger })
    } else {
      state.results.push({
        id: 'cleanup-own-only',
        title: 'cleanup closes only resources recorded by this run',
        status: 'skipped',
        evidence: failed
          ? `run has failures and --cleanup=${config.cleanup}; resources left for inspection`
          : `--cleanup=${config.cleanup}`,
      })
    }
    const reportPath = writeReport({ state })
    printSummary({ state, reportPath })
    console.log(`cleanup later with: ${ACCEPTANCE_ENV.runGate}=1 node playwriter/scripts/acceptance/acceptance-harness.ts --cleanup-only --base-url ${config.baseUrl} --state ${ledgerPath({ state })} (add --token if the runtime uses one)`)
    if (config.json) {
      console.log(JSON.stringify({ summary: state.results.map(({ id, status, evidence }) => ({ id, status, evidence })) }, null, 2))
    }
    process.exitCode = failed ? 1 : 0
  } finally {
    if (fixture) {
      await fixture.close()
    }
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const configResult = readCliConfig({ argv: process.argv.slice(2) })
  if ('error' in configResult) {
    console.error(configResult.error)
    printUsage()
    process.exitCode = 2
    return
  }
  const config = configResult

  if (config.mode === 'list') {
    for (const item of mainChecklist()) {
      console.log(`${item.how.padEnd(14)} ${item.id.padEnd(28)} ${item.title}`)
      console.log(`${''.padEnd(15)}${item.detail}`)
    }
    for (const phase of ['ws-drop', 'relay-restart', 'sw-restart', 'drag-out', 'worker-kill'] as FaultPhase[]) {
      console.log(`\n[fault phase ${phase}]`)
      for (const item of faultChecklist({ phase })) {
        console.log(`${item.how.padEnd(14)} ${item.id.padEnd(28)} ${item.title}`)
      }
    }
    return
  }

  if (config.mode === 'self-test') {
    const checks = runAcceptanceSelfChecks()
    let failed = 0
    for (const check of checks) {
      if (!check.ok) {
        failed += 1
      }
      console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`)
    }
    console.log(`\n${checks.length - failed}/${checks.length} self-checks passed`)
    process.exitCode = failed > 0 ? 1 : 0
    return
  }

  const issues = validateAcceptanceConfig({ config, env: process.env })
  const errors = issues.filter((issue) => issue.level === 'error')
  for (const issue of issues) {
    console.log(`${issue.level === 'error' ? 'ERROR' : 'WARN '} [${issue.code}] ${issue.message}`)
  }

  if (config.mode === 'dry-run' && config.fixtureServer) {
    const fixture = await startFixtureServer({ port: config.fixturePort })
    console.log(`fixture server only (explicit --fixture-server): ${fixture.baseUrl}`)
    console.log(`fixture pages: ${path.join(scriptDir, 'fixtures')}`)
    console.log('Ctrl+C to stop. No browser and no relay are started by this mode.')
    await new Promise<void>((resolve) => {
      process.once('SIGINT', () => {
        resolve()
      })
      process.once('SIGTERM', () => {
        resolve()
      })
    })
    await fixture.close()
    return
  }

  if (config.mode === 'dry-run') {
    console.log(`\nmode: dry-run (nothing is started or connected)`)
    console.log(`base URL: ${config.baseUrl || '(not set; required for live modes)'}`)
    const portLabel = (() => {
      if (!config.baseUrl) {
        return '(n/a)'
      }
      try {
        return new URL(config.baseUrl).port || '(none)'
      } catch (error) {
        return `(invalid URL: ${error instanceof Error ? error.message : String(error)})`
      }
    })()
    console.log(`port check: ${portLabel} — port ${DAILY_RELAY_PORT} is always refused`)
    console.log(`sessions: A=${config.sessionA} B=${config.sessionB}`)
    console.log(`profiles: ${config.profiles.length > 0 ? config.profiles.join(', ') : '(auto only when exactly one profile is connected)'}`)
    console.log(`fixture: ${config.fixtureServer ? 'start local fixture server' : config.fixtureUrl || '(none)'}`)
    console.log(`fault phases: ${config.faultPhases.join(', ') || '(none)'}`)
    console.log(`cleanup: ${config.cleanup}`)
    console.log(`report dir: ${config.reportDir}`)
    console.log(`\nplanned requests (sent only in --run):`)
    const planned = [
      'GET  /browser/v1/capabilities',
      'GET  /browser/v1/profiles',
      'POST /browser/v1/request groups.create x3 (same name)',
      'POST /browser/v1/request groups.list / tabs.list (session filtered)',
      'POST /browser/v1/request tabs.create for A1, A2, B1',
      'POST /browser/v1/request page.snapshot -> page.click / page.fill (snapshotId)',
      'POST /browser/v1/request page.logs, page.network start/list/stop',
      'POST /browser/v1/request tabs.release, session.release, request.cancel',
      'POST /browser/v1/request tabs.close / groups.close (recorded ids only)',
    ]
    for (const line of planned) {
      console.log(`  ${line}`)
    }
    console.log(`\nchecklist:`)
    for (const item of mainChecklist()) {
      console.log(`  - ${item.id}: ${item.title}`)
    }
    console.log(`\nrun live with: ${ACCEPTANCE_ENV.runGate}=1 node playwriter/scripts/acceptance/acceptance-harness.ts --run --base-url http://127.0.0.1:<test port> --fixture-server`)
    if (errors.length > 0) {
      console.log(`\nnote: live mode is currently blocked by ${errors.length} gate error(s) shown above`)
    }
    return
  }

  if (errors.length > 0) {
    console.error('\nrefusing to run: fix the gate errors above')
    process.exitCode = 2
    return
  }

  if (config.mode === 'run') {
    await runLive({ config })
    return
  }

  if (config.mode === 'cleanup-only') {
    await runCleanupOnly({ config })
    return
  }

  const ledger = loadLedger({ filePath: config.statePath as string })
  const state = await runFaultPhases({ config, ledger })
  const failed = state.results.some((result) => result.status === 'fail')
  const reportPath = writeReport({ state, extra: { mode: 'faults', phases: config.faultPhases }, nameSuffix: 'faults' })
  printSummary({ state, reportPath, ledgerLabel: config.statePath || undefined })
  process.exitCode = failed ? 1 : 0
}

main().catch((error) => {
  console.error('acceptance harness failed:', error)
  process.exitCode = 1
})
