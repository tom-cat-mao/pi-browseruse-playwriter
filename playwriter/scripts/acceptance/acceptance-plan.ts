/**
 * Pure acceptance plan, gates and evidence helpers for the Pi browser rebuild.
 *
 * This module performs no I/O, starts no server and touches no browser. The
 * live runner (acceptance-harness.ts) only drives the real /browser/v1 HTTP API
 * of a test runtime that the user started, after the user opened an isolated
 * Chrome with the fork extension. Rules encoded here:
 *
 * - Running anything live needs the hard gate PI_BROWSER_ACCEPTANCE=1 and an
 *   explicit test base URL. Port 19988 is always refused: that is the user's
 *   daily relay and must never be touched by acceptance.
 * - Fault injection phases (relay restart, SW restart, user drag-out, worker
 *   kill) need a second env gate PI_BROWSER_ACCEPTANCE_FAULTS=1 plus
 *   --confirm-test-ownership, because they interrupt a running runtime.
 * - Cleanup may only act on resources this harness created and recorded, and
 *   only when the live inventory still proves the recorded owner session.
 *   No default context, no pages[0], no URL-based owner guessing.
 */

import {
  BROWSER_PROTOCOL_VERSION,
  type BrowserGroup,
  type BrowserOperation,
  type BrowserRequest,
  type BrowserTab,
} from '../../src/browser-protocol.ts'

export const ACCEPTANCE_ENV = {
  runGate: 'PI_BROWSER_ACCEPTANCE',
  faultGate: 'PI_BROWSER_ACCEPTANCE_FAULTS',
  baseUrl: 'PI_BROWSER_ACCEPTANCE_BASE_URL',
  token: 'PI_BROWSER_ACCEPTANCE_TOKEN',
  chromeCdp: 'PI_BROWSER_ACCEPTANCE_CHROME_CDP',
} as const

export const DAILY_RELAY_PORT = 19988
export const FORK_DEFAULT_PORT = 19989
export const EXPECTED_PROTOCOL_VERSION = BROWSER_PROTOCOL_VERSION

export type HarnessMode = 'dry-run' | 'list' | 'self-test' | 'run' | 'faults' | 'cleanup-only'

export type FaultPhase = 'ws-drop' | 'relay-restart' | 'sw-restart' | 'drag-out' | 'worker-kill'

export type CleanupPolicy = 'on-success' | 'always' | 'never'

export type AcceptanceConfig = {
  mode: HarnessMode
  baseUrl: string | null
  token: string | null
  profiles: string[]
  sessionA: string
  sessionB: string
  fixtureServer: boolean
  fixtureUrl: string | null
  fixturePort: number
  faultPhases: FaultPhase[]
  confirmTestOwnership: boolean
  cleanup: CleanupPolicy
  reportDir: string
  timeoutMs: number
  chromeCdpUrl: string | null
  json: boolean
  statePath: string | null
  nonInteractive: boolean
  allowRemoteHost: boolean
}

export type ConfigIssue = {
  level: 'error' | 'warning'
  code: string
  message: string
}

export type ChecklistItem = {
  id: string
  title: string
  how: 'auto' | 'auto-or-skip' | 'manual-user' | 'manual-visual'
  detail: string
}

export function isLoopbackHostname({ hostname }: { hostname: string }): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]'
}

export function makeBrowserRequest({
  requestId,
  sessionId,
  operation,
  timeoutMs,
}: {
  requestId: string
  sessionId: string
  operation: BrowserOperation
  timeoutMs?: number
}): BrowserRequest {
  return timeoutMs == null ? { requestId, sessionId, operation } : { requestId, sessionId, operation, timeoutMs }
}

function parseBaseUrl({
  baseUrl,
}: {
  baseUrl: string
}): { ok: true; url: URL } | { ok: false; reason: string } {
  try {
    return { ok: true, url: new URL(baseUrl) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

export function validateAcceptanceConfig({
  config,
  env,
}: {
  config: AcceptanceConfig
  env: Record<string, string | undefined>
}): ConfigIssue[] {
  const issues: ConfigIssue[] = []
  const isLive = config.mode === 'run' || config.mode === 'faults' || config.mode === 'cleanup-only'

  if (isLive && env[ACCEPTANCE_ENV.runGate] !== '1') {
    issues.push({
      level: 'error',
      code: 'run-gate-missing',
      message:
        `live acceptance requires ${ACCEPTANCE_ENV.runGate}=1. ` +
        'This gate exists so no browser or runtime is ever touched without the user explicitly authorizing the run.',
    })
  }

  if (isLive && !config.baseUrl) {
    issues.push({
      level: 'error',
      code: 'base-url-required',
      message: `an explicit test runtime URL is required (--base-url or ${ACCEPTANCE_ENV.baseUrl}); acceptance never defaults to a port`,
    })
  }

  const parsed = config.baseUrl ? parseBaseUrl({ baseUrl: config.baseUrl }) : null

  if (parsed && !parsed.ok) {
    issues.push({ level: 'error', code: 'base-url-invalid', message: `base URL is not a valid URL: ${parsed.reason}` })
  }

  if (parsed && parsed.ok) {
    const url = parsed.url
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push({
        level: 'error',
        code: 'base-url-scheme',
        message: `base URL must use http or https, got ${url.protocol}`,
      })
    }
    if (url.port === '') {
      issues.push({
        level: 'error',
        code: 'base-url-port-required',
        message: 'base URL must include an explicit port so the daily relay can never be targeted implicitly',
      })
    }
    const port = Number(url.port)
    if (url.port === String(DAILY_RELAY_PORT)) {
      issues.push({
        level: 'error',
        code: 'daily-relay-port',
        message: `refusing port ${DAILY_RELAY_PORT}: that is the user's daily relay and is off limits for acceptance`,
      })
    }
    if (url.port === String(FORK_DEFAULT_PORT)) {
      issues.push({
        level: 'warning',
        code: 'fork-default-port',
        message: `port ${FORK_DEFAULT_PORT} is the fork's default runtime port; make sure this listener is the dedicated acceptance runtime and not the user's daily one`,
      })
    }
    if (!isLoopbackHostname({ hostname: url.hostname })) {
      if (!config.allowRemoteHost) {
        issues.push({
          level: 'error',
          code: 'remote-host-not-allowed',
          message: `remote host ${url.hostname} requires --allow-remote-host and a runtime token`,
        })
      } else if (!config.token) {
        issues.push({
          level: 'error',
          code: 'remote-token-required',
          message: `remote host ${url.hostname} requires a runtime token (--token or ${ACCEPTANCE_ENV.token})`,
        })
      }
    }
  }

  if (config.faultPhases.length > 0) {
    if (env[ACCEPTANCE_ENV.faultGate] !== '1') {
      issues.push({
        level: 'error',
        code: 'fault-gate-missing',
        message:
          `fault phases require ${ACCEPTANCE_ENV.faultGate}=1 in addition to the normal run gate. ` +
          'They interrupt a running relay/extension and must be authorized separately.',
      })
    }
    if (!config.confirmTestOwnership) {
      issues.push({
        level: 'error',
        code: 'ownership-confirmation-missing',
        message:
          'fault phases require --confirm-test-ownership: the runtime, Chrome profile and all visible groups/tabs must belong to this acceptance test only',
      })
    }
    if (config.mode !== 'faults') {
      issues.push({
        level: 'error',
        code: 'fault-mode-mismatch',
        message: 'fault phases can only run in --fault-mode with --state <ledger from the main run>',
      })
    }
  }

  if (config.mode === 'faults' && config.faultPhases.length === 0) {
    issues.push({ level: 'error', code: 'fault-phase-required', message: '--fault-mode requires at least one --fault-phase' })
  }

  if (config.mode === 'faults' && !config.statePath) {
    issues.push({
      level: 'error',
      code: 'state-required',
      message: '--fault-mode requires --state pointing at the ledger file written by a completed --run',
    })
  }

  if (config.mode === 'cleanup-only' && !config.statePath) {
    issues.push({
      level: 'error',
      code: 'state-required',
      message: '--cleanup-only requires --state pointing at a ledger file; cleanup never guesses resources',
    })
  }

  if (config.mode === 'run' && !config.fixtureServer && !config.fixtureUrl) {
    issues.push({
      level: 'error',
      code: 'fixture-required',
      message: 'a live run needs fixture pages: pass --fixture-server or --fixture-url <url of an already running fixture server>',
    })
  }

  if (config.mode === 'run' && config.profiles.length > 1) {
    issues.push({
      level: 'warning',
      code: 'multi-profile-selected',
      message: `multi-profile phase will use profiles in this order: ${config.profiles.join(', ')}`,
    })
  }

  return issues
}

export function redactAcceptanceConfig({ config }: { config: AcceptanceConfig }): Record<string, unknown> {
  return {
    ...config,
    token: config.token ? '***redacted***' : null,
  }
}

export function mainChecklist(): ChecklistItem[] {
  return [
    {
      id: 'preflight',
      title: 'capabilities + connected profiles',
      how: 'auto',
      detail: 'GET /browser/v1/capabilities and /profiles; protocolVersion must be 1 and isolatedExecution must be true',
    },
    {
      id: 'profile-selection',
      title: 'explicit profile selection',
      how: 'auto-or-skip',
      detail: 'one connected profile may be used implicitly; with several profiles every id must come from --profile',
    },
    {
      id: 'groups-same-name',
      title: 'session A creates two same-name groups, session B one same-name group',
      how: 'auto',
      detail: 'groups.create x3; groupIds must be distinct and names must never merge',
    },
    {
      id: 'groups-session-filter',
      title: 'groups.list is filtered per session',
      how: 'auto',
      detail: 'session A sees exactly its own groups, session B exactly its own; no cross-session names',
    },
    {
      id: 'multi-profile',
      title: 'one session spans two profiles without cross-talk',
      how: 'auto-or-skip',
      detail: 'second group on the second profile; profile-filtered listing must prove isolation',
    },
    {
      id: 'tab-create',
      title: 'tabs.create returns a ready owned tab with targetId',
      how: 'auto',
      detail: 'tab.groupId must equal the requested group, state ready, and the inventory must show it',
    },
    {
      id: 'cdp-target-crosscheck',
      title: 'optional: real Chrome still has the recorded targetIds',
      how: 'auto-or-skip',
      detail: 'runs only with --chrome-cdp <devtools ws/http endpoint of the isolated Chrome>',
    },
    {
      id: 'snapshot-click',
      title: 'page.snapshot -> page.click with snapshotId',
      how: 'auto',
      detail: 'click the fixture submit button with the fresh snapshotId and observe the fixture log/counter',
    },
    {
      id: 'snapshot-fill',
      title: 'page.fill with snapshotId and visible value check',
      how: 'auto',
      detail: 'fill the fixture input, verify the typed value and the echo text was produced by a real click',
    },
    {
      id: 'stale-snapshot',
      title: 'stale snapshotId is rejected, not silently first()',
      how: 'auto',
      detail: 'reuse an old snapshotId after a DOM mutation: must fail with stale-snapshot and produce no side effect',
    },
    {
      id: 'unknown-ref',
      title: 'unknown aria-ref fails without clicking anything',
      how: 'auto',
      detail: 'fill aria-ref=e<nonexistent> with a valid snapshotId; counter must not move',
    },
    {
      id: 'logs',
      title: 'page.logs returns real page console output',
      how: 'auto',
      detail: 'fixture markers and submitted values appear in the logs result',
    },
    {
      id: 'network',
      title: 'page.network start/list/stop observes the fixture request exactly once',
      how: 'auto',
      detail: 'filtered network list must contain the fixture request and the server-side counter must prove one send',
    },
    {
      id: 'popup-blank',
      title: 'target=_blank link opens in the source group',
      how: 'auto',
      detail: 'new tab appears in session A group A1 inventory with our fixture popup URL',
    },
    {
      id: 'popup-window-open',
      title: 'window.open popup opens in the source group',
      how: 'auto',
      detail: 'popup relocated into the same Chrome group as the opener, still owned by the source session',
    },
    {
      id: 'popup-visual',
      title: 'user confirms both popups are inside the group in Chrome',
      how: 'manual-visual',
      detail: 'the user looks at the group and confirms; this is reported as user-confirmed, never as automated evidence',
    },
    {
      id: 'cross-session',
      title: 'session B cannot operate on session A resources',
      how: 'auto',
      detail: 'snapshot of A tab from B must fail ownership-mismatch; B listings must not contain A resources',
    },
    {
      id: 'release-tab',
      title: 'tabs.release keeps the group and blocks later page actions',
      how: 'auto',
      detail: 'released tab stays listed, page.snapshot returns resource-released, group still listed',
    },
    {
      id: 'session-release-retains',
      title: 'session.release keeps groups and tabs and stays operable',
      how: 'auto',
      detail: 'after release the listings are unchanged and a new request re-acquires the executor',
    },
    {
      id: 'cancel-no-replay',
      title: 'request.cancel reports unknown outcome and never replays the action',
      how: 'auto',
      detail: 'cancel an in-flight page.execute; the fixture counter must show at most one execution and no retry',
    },
    {
      id: 'cleanup-own-only',
      title: 'cleanup closes only recorded resources of this run',
      how: 'auto',
      detail: 'tabs.close/groups.close only for recorded ids that the inventory still attributes to our sessions',
    },
  ]
}

export function faultChecklist({ phase }: { phase: FaultPhase }): ChecklistItem[] {
  const common: ChecklistItem[] = [
    {
      id: `${phase}-gate`,
      title: 'fault gates and ownership confirmation',
      how: 'auto',
      detail: `requires ${ACCEPTANCE_ENV.faultGate}=1 and --confirm-test-ownership`,
    },
  ]
  if (phase === 'ws-drop' || phase === 'relay-restart') {
    return [
      ...common,
      {
        id: 'relay-down',
        title: 'user stops the test runtime; the endpoint becomes unreachable',
        how: 'manual-user',
        detail: 'the user stops the runtime process in their terminal; the harness only observes connection failures',
      },
      {
        id: 'relay-up',
        title: 'user restarts the test runtime; the extension reconnects',
        how: 'manual-user',
        detail: 'after restart the same groupIds/tabIds must come back with no duplicates and a fresh revision',
      },
      {
        id: 'resources-intact',
        title: 'groups and tabs survive the transport outage',
        how: 'auto',
        detail: 'recorded ids are compared before and after; page actions must work again without re-creating resources',
      },
    ]
  }
  if (phase === 'sw-restart') {
    return [
      ...common,
      {
        id: 'sw-reload',
        title: 'user reloads the fork extension service worker',
        how: 'manual-user',
        detail: 'chrome://extensions -> fork card -> reload button; the harness polls for the re-published inventory',
      },
      {
        id: 'resources-restored',
        title: 'the persisted registry restores the same resources',
        how: 'auto',
        detail: 'same groupIds/tabIds, revision increases, recorded tabs become ready again',
      },
    ]
  }
  if (phase === 'drag-out') {
    return [
      ...common,
      {
        id: 'drag-out-user',
        title: 'user drags the instructed tab out of its Chrome group',
        how: 'manual-user',
        detail: 'the user picks the tab whose marker the harness prints; the extension must record a user release',
      },
      {
        id: 'release-recorded',
        title: 'the dragged tab becomes released and cannot be operated on',
        how: 'auto',
        detail: 'tabs.list shows state released and page.snapshot fails resource-released; the group stays listed',
      },
      {
        id: 'last-tab-drag-out',
        title: 'optional: dragging out the last tab keeps the empty group',
        how: 'manual-user',
        detail: 'session B group must stay listed with no ready tabs after its last tab is dragged out',
      },
    ]
  }
  return [
    ...common,
    {
      id: 'worker-kill',
      title: 'user kills the executor worker during a long page.execute',
      how: 'manual-user',
      detail: 'harness prints the runtime pid discovery command; the user kills the worker child process, never the Chrome process',
    },
    {
      id: 'worker-outcome',
      title: 'in-flight action reports an unknown outcome and is not replayed',
      how: 'auto',
      detail: 'the request must not report success; the fixture counter must stay at most one and never grow afterwards',
    },
  ]
}

export function extractAriaRefs({ snapshotText }: { snapshotText: string }): string[] {
  const matches = snapshotText.match(/aria-ref=[A-Za-z0-9_-]+/g) || []
  return Array.from(new Set(matches))
}

export function counterDelta({
  before,
  after,
  tag,
}: {
  before: Record<string, number>
  after: Record<string, number>
  tag: string
}): number {
  const previous = before[tag] || 0
  const current = after[tag] || 0
  return current - previous
}

export type OwnedResourceSelection = {
  groups: BrowserGroup[]
  tabs: BrowserTab[]
  rejected: { kind: 'group' | 'tab'; id: string; reason: string }[]
}

/**
 * Cleanup safety: a resource is selectable only when its id was recorded by
 * this run AND the live inventory attributes it to one of this run's sessions
 * with a matching group. Anything else is reported as rejected and untouched.
 */
export function selectOwnedResources({
  sessionIds,
  recordedGroupIds,
  recordedTabIds,
  groups,
  tabs,
}: {
  sessionIds: string[]
  recordedGroupIds: string[]
  recordedTabIds: string[]
  groups: BrowserGroup[]
  tabs: BrowserTab[]
}): OwnedResourceSelection {
  const sessionSet = new Set(sessionIds)
  const recordedGroupSet = new Set(recordedGroupIds)
  const recordedTabSet = new Set(recordedTabIds)
  const rejected: OwnedResourceSelection['rejected'] = []

  const ownedGroups = groups.filter((group) => {
    if (!recordedGroupSet.has(group.groupId)) {
      return false
    }
    if (!sessionSet.has(group.sessionId)) {
      rejected.push({
        kind: 'group',
        id: group.groupId,
        reason: `inventory session ${group.sessionId} is not one of this run's sessions`,
      })
      return false
    }
    return true
  })

  const ownedTabs = tabs.filter((tab) => {
    if (!recordedTabSet.has(tab.tabId)) {
      return false
    }
    if (!sessionSet.has(tab.sessionId)) {
      rejected.push({
        kind: 'tab',
        id: tab.tabId,
        reason: `inventory session ${tab.sessionId} is not one of this run's sessions`,
      })
      return false
    }
    if (!recordedGroupSet.has(tab.groupId)) {
      rejected.push({
        kind: 'tab',
        id: tab.tabId,
        reason: `tab group ${tab.groupId} was not created by this run`,
      })
      return false
    }
    return true
  })

  return { groups: ownedGroups, tabs: ownedTabs, rejected }
}

export type SelfCheck = { name: string; ok: boolean; detail: string }

function baseConfig(overrides: Partial<AcceptanceConfig>): AcceptanceConfig {
  return {
    mode: 'run',
    baseUrl: 'http://127.0.0.1:19990',
    token: null,
    profiles: [],
    sessionA: '00000000-0000-4000-8000-00000000000a',
    sessionB: '00000000-0000-4000-8000-00000000000b',
    fixtureServer: true,
    fixtureUrl: null,
    fixturePort: 0,
    faultPhases: [],
    confirmTestOwnership: false,
    cleanup: 'on-success',
    reportDir: 'tmp/acceptance',
    timeoutMs: 30000,
    chromeCdpUrl: null,
    json: false,
    statePath: null,
    nonInteractive: false,
    allowRemoteHost: false,
    ...overrides,
  }
}

function errorCodes({ issues }: { issues: ConfigIssue[] }): string[] {
  return issues.filter((issue) => issue.level === 'error').map((issue) => issue.code)
}

export function runAcceptanceSelfChecks(): SelfCheck[] {
  const checks: SelfCheck[] = []
  const run = ({ name, fn }: { name: string; fn: () => string | null }) => {
    try {
      const failure = fn()
      checks.push({ name, ok: failure === null, detail: failure || 'ok' })
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }

  run({
    name: 'run gate is required for live modes',
    fn: () => {
      const issues = errorCodes({ issues: validateAcceptanceConfig({ config: baseConfig({}), env: {} }) })
      return issues.includes('run-gate-missing') ? null : `expected run-gate-missing, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'dry-run needs no gate and no url',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({ config: baseConfig({ mode: 'dry-run', baseUrl: null, fixtureServer: false }), env: {} }),
      })
      return issues.length === 0 ? null : `expected no errors, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'port 19988 is always refused',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({
          config: baseConfig({ baseUrl: 'http://127.0.0.1:19988' }),
          env: { [ACCEPTANCE_ENV.runGate]: '1' },
        }),
      })
      return issues.includes('daily-relay-port') ? null : `expected daily-relay-port, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'port without explicit number is refused',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({
          config: baseConfig({ baseUrl: 'http://127.0.0.1' }),
          env: { [ACCEPTANCE_ENV.runGate]: '1' },
        }),
      })
      return issues.includes('base-url-port-required') ? null : `expected base-url-port-required, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'fault phases require fault gate and ownership confirmation',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({
          config: baseConfig({ mode: 'faults', faultPhases: ['relay-restart'], statePath: 'tmp/ledger.json' }),
          env: { [ACCEPTANCE_ENV.runGate]: '1' },
        }),
      })
      const ok = issues.includes('fault-gate-missing') && issues.includes('ownership-confirmation-missing')
      return ok ? null : `expected fault gates, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'authorized fault phase passes validation',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({
          config: baseConfig({
            mode: 'faults',
            faultPhases: ['relay-restart'],
            statePath: 'tmp/ledger.json',
            confirmTestOwnership: true,
          }),
          env: { [ACCEPTANCE_ENV.runGate]: '1', [ACCEPTANCE_ENV.faultGate]: '1' },
        }),
      })
      return issues.length === 0 ? null : `expected no errors, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'remote host requires flag and token',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({
          config: baseConfig({ baseUrl: 'http://10.0.0.5:19990' }),
          env: { [ACCEPTANCE_ENV.runGate]: '1' },
        }),
      })
      return issues.includes('remote-host-not-allowed') ? null : `expected remote-host-not-allowed, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'live run requires an explicit fixture source',
    fn: () => {
      const issues = errorCodes({
        issues: validateAcceptanceConfig({
          config: baseConfig({ fixtureServer: false, fixtureUrl: null }),
          env: { [ACCEPTANCE_ENV.runGate]: '1' },
        }),
      })
      return issues.includes('fixture-required') ? null : `expected fixture-required, got ${JSON.stringify(issues)}`
    },
  })

  run({
    name: 'checklists have unique ids and descriptions',
    fn: () => {
      const items = [...mainChecklist(), ...faultChecklist({ phase: 'relay-restart' }), ...faultChecklist({ phase: 'worker-kill' })]
      const ids = items.map((item) => item.id)
      if (new Set(ids).size !== ids.length) {
        return `duplicate checklist ids: ${ids.join(', ')}`
      }
      const missing = items.filter((item) => !item.title || !item.detail)
      return missing.length === 0 ? null : `checklist items missing text: ${missing.map((item) => item.id).join(', ')}`
    },
  })

  run({
    name: 'redaction never leaks the token',
    fn: () => {
      const redacted = redactAcceptanceConfig({ config: baseConfig({ token: 'super-secret' }) })
      return redacted.token === '***redacted***' ? null : `token leak: ${String(redacted.token)}`
    },
  })

  run({
    name: 'aria-ref extraction finds refs once',
    fn: () => {
      const refs = extractAriaRefs({ snapshotText: 'button "Save" aria-ref=e12\nlink aria-ref=e12\ninput aria-ref=e3' })
      return refs.length === 2 && refs.includes('aria-ref=e12') && refs.includes('aria-ref=e3')
        ? null
        : `unexpected refs ${JSON.stringify(refs)}`
    },
  })

  run({
    name: 'counter delta uses tag counters only',
    fn: () => {
      const delta = counterDelta({ before: { a: 1 }, after: { a: 3, b: 9 }, tag: 'a' })
      return delta === 2 ? null : `expected 2, got ${delta}`
    },
  })

  run({
    name: 'cleanup selection refuses foreign or unrecorded resources',
    fn: () => {
      const selection = selectOwnedResources({
        sessionIds: ['session-a'],
        recordedGroupIds: ['g1', 'g3'],
        recordedTabIds: ['t1', 't3'],
        groups: [
          { groupId: 'g1', sessionId: 'session-a', profileId: 'p', name: 'n', state: 'ready', browserEpoch: 'e', revision: 1 },
          { groupId: 'g2', sessionId: 'session-a', profileId: 'p', name: 'n', state: 'ready', browserEpoch: 'e', revision: 1 },
          { groupId: 'g3', sessionId: 'session-b', profileId: 'p', name: 'n', state: 'ready', browserEpoch: 'e', revision: 1 },
        ],
        tabs: [
          { tabId: 't1', groupId: 'g1', sessionId: 'session-a', profileId: 'p', url: 'u', title: 't', state: 'ready', browserEpoch: 'e', revision: 1, chromeTabId: 1 },
          { tabId: 't2', groupId: 'g2', sessionId: 'session-a', profileId: 'p', url: 'u', title: 't', state: 'ready', browserEpoch: 'e', revision: 1, chromeTabId: 2 },
          { tabId: 't3', groupId: 'g1', sessionId: 'session-b', profileId: 'p', url: 'u', title: 't', state: 'ready', browserEpoch: 'e', revision: 1, chromeTabId: 3 },
        ],
      })
      if (selection.groups.length !== 1 || selection.groups[0].groupId !== 'g1') {
        return `expected only g1, got ${selection.groups.map((group) => group.groupId).join(',')}`
      }
      if (selection.tabs.length !== 1 || selection.tabs[0].tabId !== 't1') {
        return `expected only t1, got ${selection.tabs.map((tab) => tab.tabId).join(',')}`
      }
      if (selection.rejected.length !== 2) {
        return `expected g3 and t3 rejected as foreign sessions, got ${JSON.stringify(selection.rejected)}`
      }
      return null
    },
  })

  run({
    name: 'expected protocol version is the shared contract value',
    fn: () => {
      return EXPECTED_PROTOCOL_VERSION === 1 ? null : `unexpected protocol version ${EXPECTED_PROTOCOL_VERSION}`
    },
  })

  return checks
}
