import { BROWSER_PROTOCOL_VERSION } from 'playwriter/src/browser-protocol'
import type {
  BrowserCapabilities,
  BrowserErrorCode,
  BrowserGroup,
  BrowserInventory,
  BrowserRequest,
  BrowserResponse,
  BrowserTab,
} from 'playwriter/src/browser-protocol'
import type { FirefoxTab } from './firefox-api'

export const FIREFOX_CAPABILITIES: BrowserCapabilities = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  managedGroups: true,
  persistentOwnership: true,
  explicitTabs: true,
  isolatedExecution: true,
  existingTabControl: true,
  backend: 'webextension',
  inputMode: 'dom',
  snapshotMode: 'dom-aria',
  executeMode: 'dom-compatible',
  evaluateWorld: 'isolated',
  limitations: [
    'Firefox uses DOM interaction; input events are not browser-native trusted input.',
    'Snapshots use DOM/ARIA instead of the browser accessibility tree.',
    'Evaluate runs in an isolated content-script world; page globals are not ordinary globals.',
    'Execute supports the documented page/locator subset; CDP and browser/context control are unavailable.',
    'Network capture starts on request and retains bounded text bodies; console capture begins after attachment.',
  ],
}

export interface FirefoxLedgerEntry {
  sessionId: string
  requestId: string
  fingerprint: string
  phase: 'pending' | 'completed'
  createdAt: number
  response?: BrowserResponse
}

export interface FirefoxRegistry extends BrowserInventory {
  ledger: FirefoxLedgerEntry[]
}

export class FirefoxResourceError extends Error {
  readonly code: BrowserErrorCode
  readonly outcome: 'not-started' | 'unknown'

  constructor(options: { code: BrowserErrorCode; message: string; outcome?: 'not-started' | 'unknown' }) {
    super(options.message)
    this.code = options.code
    this.outcome = options.outcome ?? 'not-started'
  }
}

export function firefoxId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`
}

export function isFirefoxRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function firefoxPageSupported(raw: string | undefined): boolean {
  if (!raw) return false
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    // Firefox prohibits content scripts on these privileged Mozilla domains.
    const restricted = [
      'accounts-static.cdn.mozilla.net',
      'accounts.firefox.com',
      'addons.cdn.mozilla.net',
      'addons.mozilla.org',
      'api.accounts.firefox.com',
      'content.cdn.mozilla.net',
      'discovery.addons.mozilla.org',
      'oauth.accounts.firefox.com',
      'profile.accounts.firefox.com',
      'support.mozilla.org',
      'sync.services.mozilla.com',
    ]
    return !restricted.includes(url.hostname)
  } catch {
    return false
  }
}

export function emptyFirefoxRegistry(options: { profileId: string; browserEpoch: string }): FirefoxRegistry {
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    ...options,
    revision: 0,
    backend: 'webextension',
    capabilities: FIREFOX_CAPABILITIES,
    groups: [],
    tabs: [],
    ledger: [],
  }
}

function validIdentity(record: Record<string, unknown>): boolean {
  return (
    ['sessionId', 'profileId', 'browserEpoch'].every((key) => {
      return typeof record[key] === 'string' && record[key].length > 0 && record[key].length <= 256
    }) &&
    typeof record.revision === 'number' &&
    Number.isSafeInteger(record.revision) &&
    record.revision >= 0 &&
    ['ready', 'released', 'disconnected', 'needs-rebind'].includes(String(record.state))
  )
}

export function parseFirefoxRegistry(raw: unknown): FirefoxRegistry | null {
  if (!isFirefoxRecord(raw) || raw.protocolVersion !== BROWSER_PROTOCOL_VERSION || raw.backend !== 'webextension')
    return null
  if (
    typeof raw.profileId !== 'string' ||
    !raw.profileId ||
    typeof raw.browserEpoch !== 'string' ||
    !raw.browserEpoch ||
    !Number.isSafeInteger(raw.revision) ||
    Number(raw.revision) < 0
  )
    return null
  if (!Array.isArray(raw.groups) || !Array.isArray(raw.tabs) || !Array.isArray(raw.ledger)) return null
  for (const group of raw.groups) {
    if (
      !isFirefoxRecord(group) ||
      !validIdentity(group) ||
      typeof group.groupId !== 'string' ||
      !group.groupId ||
      typeof group.name !== 'string' ||
      !group.name ||
      group.profileId !== raw.profileId ||
      Number(group.revision) > Number(raw.revision)
    )
      return null
    if (
      group.chromeGroupId !== undefined ||
      (group.browserGroupId !== undefined &&
        (!Number.isSafeInteger(group.browserGroupId) || Number(group.browserGroupId) < 0))
    )
      return null
  }
  for (const tab of raw.tabs) {
    if (
      !isFirefoxRecord(tab) ||
      !validIdentity(tab) ||
      typeof tab.tabId !== 'string' ||
      !tab.tabId ||
      typeof tab.groupId !== 'string' ||
      typeof tab.url !== 'string' ||
      typeof tab.title !== 'string' ||
      tab.profileId !== raw.profileId ||
      Number(tab.revision) > Number(raw.revision)
    )
      return null
    if (
      tab.chromeTabId !== -1 ||
      !Number.isSafeInteger(tab.browserTabId) ||
      Number(tab.browserTabId) < 0 ||
      tab.targetId !== undefined ||
      tab.cdpSessionId !== undefined
    )
      return null
    const group = raw.groups.find((candidate: unknown) => {
      return isFirefoxRecord(candidate) && candidate.groupId === tab.groupId && candidate.sessionId === tab.sessionId
    })
    if (!group) return null
  }
  const groupIds = new Set(
    raw.groups.map((group: { groupId: string }) => {
      return group.groupId
    }),
  )
  const tabIds = new Set(
    raw.tabs.map((tab: { tabId: string }) => {
      return tab.tabId
    }),
  )
  if (groupIds.size !== raw.groups.length || tabIds.size !== raw.tabs.length) return null
  const physicalIds = new Set<number>()
  for (const tab of raw.tabs) {
    if (tab.state !== 'ready' && tab.state !== 'disconnected') continue
    if (tab.browserEpoch !== raw.browserEpoch || physicalIds.has(tab.browserTabId)) return null
    physicalIds.add(tab.browserTabId)
  }
  for (const entry of raw.ledger) {
    if (
      !isFirefoxRecord(entry) ||
      typeof entry.sessionId !== 'string' ||
      typeof entry.requestId !== 'string' ||
      typeof entry.fingerprint !== 'string' ||
      !Number.isFinite(entry.createdAt) ||
      (entry.phase !== 'pending' && entry.phase !== 'completed')
    )
      return null
    if (
      entry.response !== undefined &&
      (!isFirefoxRecord(entry.response) ||
        entry.response.requestId !== entry.requestId ||
        typeof entry.response.ok !== 'boolean')
    )
      return null
  }
  return { ...(raw as unknown as FirefoxRegistry), capabilities: FIREFOX_CAPABILITIES }
}

export function firefoxInventory(registry: FirefoxRegistry): BrowserInventory {
  const { ledger: _ledger, ...inventory } = registry
  return inventory
}

export function reconcileFirefoxRegistry(options: {
  registry: FirefoxRegistry
  browserEpoch: string
  observedTabs: FirefoxTab[]
}): FirefoxRegistry {
  const { registry, browserEpoch } = options
  const revision = registry.revision + 1
  if (registry.browserEpoch !== browserEpoch) {
    return {
      ...registry,
      browserEpoch,
      revision,
      groups: registry.groups.map((group) => {
        if (group.state === 'released') return group
        const { browserGroupId: _groupId, windowId: _windowId, ...rest } = group
        return { ...rest, state: 'needs-rebind', revision }
      }),
      tabs: registry.tabs.map((tab) => {
        return tab.state === 'released' ? tab : { ...tab, state: 'needs-rebind', revision }
      }),
    }
  }
  const observed = new Map(
    options.observedTabs.map((tab) => {
      return [tab.id, tab]
    }),
  )
  const tabs = registry.tabs.map((tab): BrowserTab => {
    if (tab.state === 'released' || tab.state === 'needs-rebind') return tab
    const actual = observed.get(tab.browserTabId)
    const group = registry.groups.find((candidate) => {
      return candidate.groupId === tab.groupId
    })
    if (
      !actual ||
      !group ||
      group.state !== 'ready' ||
      (group.browserGroupId !== undefined && actual.groupId !== group.browserGroupId)
    )
      return { ...tab, state: 'released', revision }
    return { ...tab, url: actual.url ?? '', title: actual.title ?? '', state: 'ready', revision }
  })
  return releaseFirefoxTabs({ registry: { ...registry, tabs }, tabIds: [] })
}

export function ownedFirefoxTab(options: {
  registry: FirefoxRegistry
  sessionId: string
  tabId: string
  browserEpoch?: string
}): BrowserTab {
  const { registry } = options
  const tab = registry.tabs.find((candidate) => {
    return candidate.tabId === options.tabId
  })
  if (!tab) throw new FirefoxResourceError({ code: 'resource-not-found', message: `Unknown tab ${options.tabId}` })
  if (tab.sessionId !== options.sessionId)
    throw new FirefoxResourceError({ code: 'ownership-mismatch', message: 'This tab belongs to another Pi session' })
  if (tab.state === 'released')
    throw new FirefoxResourceError({
      code: 'resource-released',
      message: 'This tab was released; discover and explicitly attach it again',
    })
  if (tab.state === 'needs-rebind' || tab.browserEpoch !== registry.browserEpoch)
    throw new FirefoxResourceError({
      code: 'needs-rebind',
      message: 'Firefox restarted; discover and attach the current tab again',
    })
  if (options.browserEpoch !== undefined && options.browserEpoch !== registry.browserEpoch)
    throw new FirefoxResourceError({ code: 'needs-rebind', message: 'The request belongs to an earlier Firefox run' })
  const group = registry.groups.find((candidate) => {
    return candidate.groupId === tab.groupId
  })
  if (!group || group.sessionId !== options.sessionId || group.state !== 'ready')
    throw new FirefoxResourceError({ code: 'resource-released', message: 'The owning group is no longer ready' })
  if (tab.state !== 'ready' || tab.browserTabId === undefined)
    throw new FirefoxResourceError({ code: 'profile-disconnected', message: 'Firefox tab is not ready' })
  return tab
}

export function activeFirefoxTab(options: { registry: FirefoxRegistry; browserTabId: number }): BrowserTab | undefined {
  return options.registry.tabs.find((tab) => {
    return (
      tab.browserTabId === options.browserTabId &&
      tab.browserEpoch === options.registry.browserEpoch &&
      (tab.state === 'ready' || tab.state === 'disconnected')
    )
  })
}

export function releaseFirefoxTabs(options: {
  registry: FirefoxRegistry
  tabIds: string[]
  groupIds?: string[]
}): FirefoxRegistry {
  const revision = options.registry.revision + 1
  const tabs = options.registry.tabs.map((tab): BrowserTab => {
    return options.tabIds.includes(tab.tabId) ? { ...tab, state: 'released', revision } : tab
  })
  return {
    ...options.registry,
    revision,
    tabs,
    groups: options.registry.groups.map((group) => {
      if (options.groupIds?.includes(group.groupId)) return { ...group, state: 'released', revision }
      if (
        group.browserGroupId !== undefined &&
        !tabs.some((tab) => {
          return tab.groupId === group.groupId && tab.state === 'ready'
        })
      ) {
        const { browserGroupId: _binding, windowId: _windowId, ...logical } = group
        return { ...logical, revision }
      }
      return group
    }),
  }
}

export function firefoxRequestFingerprint(
  request: BrowserRequest | { command: unknown; sessionId: string; tabId: string; browserEpoch: string },
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical)
    if (!isFirefoxRecord(value)) return value
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          return [key, canonical(value[key])]
        }),
    )
  }
  return JSON.stringify(
    canonical(
      'operation' in request
        ? request.operation
        : { command: request.command, tabId: request.tabId, browserEpoch: request.browserEpoch },
    ),
  )
}

export function firefoxFailure(options: {
  requestId: string
  error: unknown
  outcome?: 'not-started' | 'unknown'
}): BrowserResponse {
  const error = options.error
  return {
    requestId: options.requestId,
    ok: false,
    error: {
      code: error instanceof FirefoxResourceError ? error.code : 'execution-failed',
      message: error instanceof Error ? error.message : String(error),
      outcome: error instanceof FirefoxResourceError ? error.outcome : (options.outcome ?? 'not-started'),
    },
  }
}
