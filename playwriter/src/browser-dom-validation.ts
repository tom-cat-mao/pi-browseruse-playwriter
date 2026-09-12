import type { BrowserDomCommand, BrowserDomRequest } from './browser-protocol.js'

const MAX_CODE_LENGTH = 1_000_000
const MAX_STRING_LENGTH = 20_000
const LOCATOR_ACTIONS = new Set<string>([
  'count', 'click', 'dblclick', 'fill', 'type', 'press', 'check', 'uncheck', 'setChecked',
  'selectOption', 'hover', 'focus', 'blur', 'scrollIntoViewIfNeeded', 'waitFor',
  'textContent', 'innerText', 'innerHTML', 'inputValue', 'getAttribute',
  'allTextContents', 'allInnerTexts', 'isVisible', 'isHidden', 'isEnabled', 'isDisabled',
  'isEditable', 'isChecked', 'boundingBox',
])
const SELECTOR_ENGINES = new Set<string>(['css', 'role', 'text', 'label', 'placeholder', 'testId', 'alt', 'title'])

export function parseBrowserDomCommand(value: unknown): BrowserDomCommand | null {
  if (!isRecord(value) || typeof value.method !== 'string' || !boundedJson(value)) {
    return null
  }
  let valid = false
  switch (value.method) {
    case 'snapshot':
      valid = fields({ value, keys: ['method', 'selector', 'search', 'full', 'interactiveOnly'] }) &&
        optionalString(value.selector) && optionalString(value.search) && optionalBoolean(value.full) && optionalBoolean(value.interactiveOnly)
      break
    case 'click':
      valid = fields({ value, keys: ['method', 'selector', 'snapshotId'] }) && nonemptyString(value.selector) && optionalString(value.snapshotId)
      break
    case 'fill':
      valid = fields({ value, keys: ['method', 'selector', 'snapshotId', 'value'] }) &&
        nonemptyString(value.selector) && optionalString(value.snapshotId) && boundedString(value.value)
      break
    case 'evaluate':
      valid = fields({ value, keys: ['method', 'code', 'locator'] }) && typeof value.code === 'string' &&
        value.code.length <= MAX_CODE_LENGTH && (value.locator === undefined || validLocator({ value: value.locator, depth: 0 }))
      break
    case 'locator':
      valid = fields({ value, keys: ['method', 'locator', 'action', 'args'] }) &&
        typeof value.action === 'string' && LOCATOR_ACTIONS.has(value.action) && validLocator({ value: value.locator, depth: 0 }) &&
        (value.args === undefined || (Array.isArray(value.args) && value.args.length <= 4))
      break
    case 'page':
      valid = fields({ value, keys: ['method', 'action'] }) && ['title', 'url', 'content'].includes(String(value.action))
      break
    case 'invalidate':
    case 'dispose':
    case 'screenshot.cleanup':
      valid = fields({ value, keys: ['method'] })
      break
    case 'screenshot.prepare':
      valid = fields({ value, keys: ['method', 'fullPage', 'labels'] }) && optionalBoolean(value.fullPage) && optionalBoolean(value.labels)
      break
    case 'logs':
      valid = fields({ value, keys: ['method', 'limit'] }) && optionalInteger({ value: value.limit, minimum: 0, maximum: 500 })
      break
    case 'operation':
      valid = fields({ value, keys: ['method', 'operation'] }) && validPageOperation(value.operation)
      break
  }
  return valid ? value as unknown as BrowserDomCommand : null
}

export function parseBrowserDomRequest(value: unknown): BrowserDomRequest | null {
  if (!isRecord(value) || !fields({ value, keys: ['requestId', 'sessionId', 'tabId', 'browserEpoch', 'command', 'timeoutMs'] }) ||
    !identifier(value.requestId) || !identifier(value.sessionId) || !identifier(value.tabId) || !identifier(value.browserEpoch) ||
    !optionalInteger({ value: value.timeoutMs, minimum: 1, maximum: 120_000 })) {
    return null
  }
  const command = parseBrowserDomCommand(value.command)
  if (!command || (command.method === 'operation' && command.operation.tabId !== value.tabId)) {
    return null
  }
  return {
    requestId: value.requestId, sessionId: value.sessionId, tabId: value.tabId,
    browserEpoch: value.browserEpoch, command,
    ...(typeof value.timeoutMs === 'number' ? { timeoutMs: value.timeoutMs } : {}),
  }
}

function validPageOperation(value: unknown): boolean {
  if (!isRecord(value) || !identifier(value.tabId) || typeof value.kind !== 'string') {
    return false
  }
  const keys = ['kind', 'tabId']
  switch (value.kind) {
    case 'page.navigate':
      return fields({ value, keys: [...keys, 'url'] }) && nonemptyString(value.url)
    case 'page.back':
      return fields({ value, keys })
    case 'page.snapshot':
      return fields({ value, keys: [...keys, 'selector', 'search', 'full', 'interactiveOnly'] }) &&
        optionalString(value.selector) && optionalString(value.search) && optionalBoolean(value.full) && optionalBoolean(value.interactiveOnly)
    case 'page.click':
      return fields({ value, keys: [...keys, 'selector', 'snapshotId'] }) && nonemptyString(value.selector) && optionalString(value.snapshotId)
    case 'page.fill':
      return fields({ value, keys: [...keys, 'selector', 'value', 'snapshotId'] }) && nonemptyString(value.selector) &&
        boundedString(value.value) && optionalString(value.snapshotId)
    case 'page.evaluate':
      return fields({ value, keys: [...keys, 'code'] }) && typeof value.code === 'string' && value.code.length <= MAX_CODE_LENGTH
    case 'page.screenshot':
      return fields({ value, keys: [...keys, 'path', 'fullPage', 'labels'] }) &&
        optionalString(value.path) && optionalBoolean(value.fullPage) && optionalBoolean(value.labels)
    case 'page.network':
      return fields({ value, keys: [...keys, 'action', 'filter'] }) &&
        ['start', 'list', 'stop'].includes(String(value.action)) && optionalString(value.filter)
    case 'page.logs':
      return fields({ value, keys: [...keys, 'limit'] }) && optionalInteger({ value: value.limit, minimum: 0, maximum: 500 })
    default:
      return false
  }
}

function validLocator({ value, depth }: { value: unknown; depth: number }): boolean {
  if (depth > 8 || !isRecord(value) || !fields({ value, keys: ['steps'] }) ||
    !Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 32) {
    return false
  }
  return value.steps.every((step) => {
    if (!isRecord(step)) {
      return false
    }
    switch (step.kind) {
      case 'selector':
        return fields({ value: step, keys: ['kind', 'engine', 'value', 'name', 'exact', 'options'] }) &&
          typeof step.engine === 'string' && SELECTOR_ENGINES.has(step.engine) && boundedString(step.value) &&
          (step.engine !== 'css' || step.value.length > 0) && optionalString(step.name) && optionalBoolean(step.exact) &&
          (step.options === undefined || validRoleOptions(step.options))
      case 'nth':
        return fields({ value: step, keys: ['kind', 'index'] }) && typeof step.index === 'number' &&
          Number.isSafeInteger(step.index) && step.index >= -1 && step.index <= 100_000
      case 'filter':
        return fields({ value: step, keys: ['kind', 'hasText', 'hasNotText', 'has', 'hasNot'] }) &&
          optionalString(step.hasText) && optionalString(step.hasNotText) &&
          (step.has === undefined || validLocator({ value: step.has, depth: depth + 1 })) &&
          (step.hasNot === undefined || validLocator({ value: step.hasNot, depth: depth + 1 }))
      case 'frame':
        return fields({ value: step, keys: ['kind', 'selector'] }) && nonemptyString(step.selector)
      default:
        return false
    }
  })
}

function validRoleOptions(value: unknown): boolean {
  const booleanKeys = ['checked', 'disabled', 'expanded', 'selected', 'pressed', 'includeHidden']
  if (!isRecord(value) || !fields({ value, keys: [...booleanKeys, 'level'] })) {
    return false
  }
  return booleanKeys.every((key) => {
    return optionalBoolean(value[key])
  }) && optionalInteger({ value: value.level, minimum: 1, maximum: 100 })
}

function boundedJson(value: unknown): boolean {
  let count = 0
  let stringLength = 0
  const seen = new Set<object>()
  const visit = (options: { value: unknown; depth: number }): boolean => {
    count += 1
    if (count > 20_000 || options.depth > 32) {
      return false
    }
    const entry = options.value
    if (entry === null || entry === undefined || typeof entry === 'boolean') {
      return true
    }
    if (typeof entry === 'number') {
      return Number.isFinite(entry)
    }
    if (typeof entry === 'string') {
      stringLength += entry.length
      return stringLength <= 2_000_000
    }
    if (typeof entry !== 'object' || seen.has(entry)) {
      return false
    }
    seen.add(entry)
    const entries: unknown[] = Array.isArray(entry) ? entry : Object.entries(entry).flatMap(([key, property]) => {
      return [key, property]
    })
    return entries.every((property) => {
      return visit({ value: property, depth: options.depth + 1 })
    })
  }
  return visit({ value, depth: 0 })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function fields({ value, keys }: { value: Record<string, unknown>; keys: string[] }): boolean {
  return Object.keys(value).every((key) => {
    return keys.includes(key)
  })
}

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 2048
}

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH
}

function nonemptyString(value: unknown): value is string {
  return boundedString(value) && value.length > 0
}

function optionalString(value: unknown): boolean {
  return value === undefined || boundedString(value)
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function optionalInteger({ value, minimum, maximum }: { value: unknown; minimum: number; maximum: number }): boolean {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum)
}
