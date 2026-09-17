import type { BrowserOperation, BrowserRequest } from 'playwriter/src/browser-protocol'
import { MAX_FIREFOX_ASSET_COUNT, MAX_FIREFOX_ASSET_ALT_LENGTH, MAX_FIREFOX_ASSET_URL_LENGTH } from 'playwriter/src/firefox-executor-protocol'
import type { FirefoxAssetFetchRequest, FirefoxAssetTarget } from 'playwriter/src/firefox-executor-protocol'
import { isFirefoxRecord } from './firefox-resources'

/** Exported so the capability advertisement can be pinned to the operations this validator accepts. */
export const FIELDS: Record<BrowserOperation['kind'], string[]> = {
  'profiles.list': [],
  'groups.list': ['profileId'],
  'groups.create': ['profileId', 'name'],
  'groups.rename': ['groupId', 'name'],
  'groups.close': ['groupId'],
  'tabs.list': ['groupId', 'sourceTabId'],
  'tabs.create': ['groupId', 'url'],
  'tabs.discover': ['profileId', 'windowId', 'query', 'includeManaged'],
  'tabs.attach': ['candidateId'],
  'tabs.activate': ['tabId'],
  'tabs.close': ['tabId'],
  'tabs.release': ['tabId'],
  'tab.resolve': ['tabId'],
  'session.release': [],
  'request.cancel': ['targetRequestId'],
  'page.navigate': ['tabId', 'url'],
  'page.back': ['tabId'],
  'page.snapshot': ['tabId', 'selector', 'search', 'full', 'interactiveOnly'],
  'page.click': ['tabId', 'selector', 'snapshotId'],
  'page.fill': ['tabId', 'selector', 'value', 'snapshotId'],
  'page.evaluate': ['tabId', 'code'],
  'page.execute': ['tabId', 'code'],
  'page.screenshot': ['tabId', 'path', 'fullPage', 'labels'],
  'page.network': ['tabId', 'action', 'filter'],
  'page.logs': ['tabId', 'limit'],
  'page.extract': ['tabId', 'format', 'selector', 'search', 'offset', 'limit', 'path', 'images'],
}

export function parseFirefoxBrowserRequest(raw: unknown): BrowserRequest | null {
  if (
    !isFirefoxRecord(raw) ||
    Object.keys(raw).some((key) => {
      return !['requestId', 'sessionId', 'operation', 'cwd', 'timeoutMs'].includes(key)
    })
  )
    return null
  for (const key of ['requestId', 'sessionId']) {
    if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > 256) return null
  }
  if (raw.cwd !== undefined && (typeof raw.cwd !== 'string' || raw.cwd.length > 8192)) return null
  if (
    raw.timeoutMs !== undefined &&
    (!Number.isSafeInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 1 || Number(raw.timeoutMs) > 300000)
  )
    return null
  const op = raw.operation
  if (!isFirefoxRecord(op) || typeof op.kind !== 'string' || !Object.hasOwn(FIELDS, op.kind)) return null
  const kind = op.kind as BrowserOperation['kind']
  const fields = FIELDS[kind]
  if (
    Object.keys(op).some((key) => {
      return key !== 'kind' && !fields.includes(key)
    })
  )
    return null
  const booleans = ['includeManaged', 'full', 'fullPage', 'interactiveOnly', 'labels']
  const numbers = ['windowId', 'limit']
  for (const key of fields) {
    const value = op[key]
    if (value === undefined) continue
    if (booleans.includes(key)) {
      if (typeof value !== 'boolean') return null
    } else if (numbers.includes(key)) {
      if (
        !Number.isSafeInteger(value) ||
        Number(value) < (key === 'limit' ? 1 : 0) ||
        Number(value) > (key === 'limit' ? 1000 : 2147483647)
      )
        return null
    } else {
      const max =
        key === 'code' ? 262144 : key === 'value' ? 1048576 : key === 'name' ? 200 : key.endsWith('Id') ? 256 : 8192
      if (typeof value !== 'string' || value.length > max) return null
      if (key !== 'value' && !value.trim()) return null
    }
  }
  const required: string[] = []
  if (kind.startsWith('page.') || ['tabs.activate', 'tabs.close', 'tabs.release', 'tab.resolve'].includes(kind))
    required.push('tabId')
  if (['groups.rename', 'groups.close', 'tabs.create'].includes(kind)) required.push('groupId')
  if (kind === 'groups.create') required.push('profileId', 'name')
  if (kind === 'groups.rename') required.push('name')
  if (kind === 'tabs.attach') required.push('candidateId')
  if (kind === 'request.cancel') required.push('targetRequestId')
  if (kind === 'page.click' || kind === 'page.fill') required.push('selector')
  if (kind === 'page.fill') required.push('value')
  if (kind === 'tabs.create' || kind === 'page.navigate') required.push('url')
  if (kind === 'page.evaluate' || kind === 'page.execute') required.push('code')
  if (kind === 'page.network' && !['start', 'list', 'stop'].includes(String(op.action))) return null
  if (
    required.some((key) => {
      return op[key] === undefined
    })
  )
    return null
  return raw as unknown as BrowserRequest
}

const ASSET_REQUEST_FIELDS = ['requestId', 'sessionId', 'tabId', 'browserEpoch', 'targets']
const ASSET_TARGET_FIELDS = ['src', 'alt']
const MAX_ASSET_IDENTITY_LENGTH = 256

/**
 * `browserAssetRequest`: the page.extract 'save' byte channel. Image bytes come
 * from this extension because only a background fetch carries the browser's
 * cookies and host permissions, so the request names the tab whose images are
 * being saved and is bounded exactly like every other Firefox request.
 */
export function parseFirefoxAssetRequest(raw: unknown): FirefoxAssetFetchRequest | null {
  if (!isFirefoxRecord(raw) || Object.keys(raw).some((key) => !ASSET_REQUEST_FIELDS.includes(key))) return null
  for (const key of ['requestId', 'sessionId', 'tabId', 'browserEpoch']) {
    const value = raw[key]
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_ASSET_IDENTITY_LENGTH) return null
  }
  const targets = raw.targets
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_FIREFOX_ASSET_COUNT) return null
  const parsed: FirefoxAssetTarget[] = []
  for (const target of targets) {
    if (!isFirefoxRecord(target) || Object.keys(target).some((key) => !ASSET_TARGET_FIELDS.includes(key))) return null
    if (!imageAssetUrl(target.src)) return null
    if (target.alt !== undefined && (typeof target.alt !== 'string' || target.alt.length > MAX_FIREFOX_ASSET_ALT_LENGTH)) return null
    parsed.push({ src: target.src, ...(target.alt !== undefined ? { alt: target.alt } : {}) })
  }
  return {
    requestId: raw.requestId as string,
    sessionId: raw.sessionId as string,
    tabId: raw.tabId as string,
    browserEpoch: raw.browserEpoch as string,
    targets: parsed,
  }
}

/** Only web images may leave through this channel: never file:, data: or a browser-internal scheme. */
function imageAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_FIREFOX_ASSET_URL_LENGTH) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
