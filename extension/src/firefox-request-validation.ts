import type { BrowserOperation, BrowserRequest } from 'playwriter/src/browser-protocol'
import { isFirefoxRecord } from './firefox-resources'

const FIELDS: Record<BrowserOperation['kind'], string[]> = {
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
