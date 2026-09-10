import type {
  BrowserJson,
  BrowserResponse,
  ManagedExecution,
} from './browser-protocol.js'

export const MANAGED_EXECUTOR_WORKER_PROTOCOL_VERSION = 1
export const MAX_MANAGED_WORKER_MESSAGE_BYTES = 8 * 1024 * 1024

export interface ManagedExecutorWorkerExecuteCommand {
  type: 'execute'
  id: string
  execution: ManagedExecution
}

export interface ManagedExecutorWorkerDisposeCommand {
  type: 'dispose'
  id: string
}

export type ManagedExecutorWorkerCommand =
  | ManagedExecutorWorkerExecuteCommand
  | ManagedExecutorWorkerDisposeCommand

export interface ManagedExecutorWorkerReadyMessage {
  type: 'ready'
  protocolVersion: typeof MANAGED_EXECUTOR_WORKER_PROTOCOL_VERSION
}

export interface ManagedExecutorWorkerResponseMessage {
  type: 'response'
  id: string
  response: BrowserResponse
}

export interface ManagedExecutorWorkerDisposedMessage {
  type: 'disposed'
  id: string
}

export interface ManagedExecutorWorkerErrorMessage {
  type: 'error'
  id?: string
  error: {
    message: string
    stack?: string
  }
}

export type ManagedExecutorWorkerMessage =
  | ManagedExecutorWorkerReadyMessage
  | ManagedExecutorWorkerResponseMessage
  | ManagedExecutorWorkerDisposedMessage
  | ManagedExecutorWorkerErrorMessage

export type ManagedExecutorWorkerWireMessage = ManagedExecutorWorkerCommand | ManagedExecutorWorkerMessage

export function serializeBrowserJson(value: unknown): BrowserJson {
  const seen = new WeakSet<object>()

  const serialize = ({ value, depth }: { value: unknown; depth: number }): BrowserJson => {
    if (value === null || value === undefined) {
      return null
    }
    if (typeof value === 'string') {
      return truncateString({ value, maxLength: 100_000 })
    }
    if (typeof value === 'boolean') {
      return value
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'bigint') {
      return `[bigint] ${value.toString()}`
    }
    if (typeof value === 'symbol') {
      return `[symbol] ${value.toString()}`
    }
    if (typeof value === 'function') {
      return `[Function ${value.name || 'anonymous'}]`
    }
    if (depth >= 8) {
      return '[Max serialization depth reached]'
    }
    if (seen.has(value)) {
      return '[Circular]'
    }
    seen.add(value)

    const result: BrowserJson = (() => {
      if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? '[Invalid Date]' : value.toISOString()
      }
      if (value instanceof Error) {
        const errorData: { [key: string]: BrowserJson } = {
          name: value.name,
          message: truncateString({ value: value.message, maxLength: 10_000 }),
        }
        if (value.stack) {
          errorData.stack = truncateString({ value: value.stack, maxLength: 20_000 })
        }
        return errorData
      }
      if (value instanceof Map) {
        return Array.from(value.entries())
          .slice(0, 100)
          .map(([key, entryValue]) => {
            return [
              serialize({ value: key, depth: depth + 1 }),
              serialize({ value: entryValue, depth: depth + 1 }),
            ]
          })
      }
      if (value instanceof Set) {
        return Array.from(value.values())
          .slice(0, 100)
          .map((entryValue) => {
            return serialize({ value: entryValue, depth: depth + 1 })
          })
      }
      if (Array.isArray(value)) {
        return value.slice(0, 100).map((entryValue) => {
          return serialize({ value: entryValue, depth: depth + 1 })
        })
      }

      const record = value as Record<string, unknown>
      const channelType = record._type
      const channelGuid = record._guid
      if (typeof channelType === 'string' && typeof channelGuid === 'string') {
        return `[Playwright ${channelType}]`
      }

      const keys = Object.keys(record).slice(0, 100)
      const entries = keys.map((key): [string, BrowserJson] => {
        const property = (() => {
          try {
            return record[key]
          } catch (error) {
            return `[Unserializable property: ${errorMessage(error)}]`
          }
        })()
        return [key, serialize({ value: property, depth: depth + 1 })]
      })
      return Object.fromEntries(entries)
    })()

    seen.delete(value)
    return result
  }

  return serialize({ value, depth: 0 })
}

export function truncateString({ value, maxLength }: { value: string; maxLength: number }): string {
  if (value.length <= maxLength) {
    return value
  }
  return `${value.slice(0, maxLength)}\n[truncated at ${maxLength} characters]`
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

export function encodeManagedWorkerMessage(message: ManagedExecutorWorkerWireMessage): string {
  const line = JSON.stringify(message)
  const byteLength = Buffer.byteLength(line, 'utf8')
  if (byteLength > MAX_MANAGED_WORKER_MESSAGE_BYTES) {
    throw new Error(
      `Managed executor worker message is ${byteLength} bytes, exceeding the ${MAX_MANAGED_WORKER_MESSAGE_BYTES}-byte limit`,
    )
  }
  return `${line}\n`
}

export function parseManagedWorkerMessage(line: string): ManagedExecutorWorkerMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    return null
  }

  if (parsed.type === 'ready') {
    if (parsed.protocolVersion !== MANAGED_EXECUTOR_WORKER_PROTOCOL_VERSION) {
      return null
    }
    return {
      type: 'ready',
      protocolVersion: MANAGED_EXECUTOR_WORKER_PROTOCOL_VERSION,
    }
  }

  if (parsed.type === 'disposed' && typeof parsed.id === 'string') {
    return { type: 'disposed', id: parsed.id }
  }

  if (parsed.type === 'error') {
    const error = isRecord(parsed.error) ? parsed.error : null
    if (!error || typeof error.message !== 'string') {
      return null
    }
    return {
      type: 'error',
      ...(typeof parsed.id === 'string' ? { id: parsed.id } : {}),
      error: {
        message: error.message,
        ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
      },
    }
  }

  if (parsed.type === 'response' && typeof parsed.id === 'string' && isBrowserResponse(parsed.response)) {
    return {
      type: 'response',
      id: parsed.id,
      response: parsed.response,
    }
  }

  return null
}

export function parseManagedWorkerCommand(line: string): ManagedExecutorWorkerCommand | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  if (!isRecord(parsed) || typeof parsed.type !== 'string' || typeof parsed.id !== 'string') {
    return null
  }
  if (parsed.type === 'dispose') {
    return { type: 'dispose', id: parsed.id }
  }
  if (parsed.type !== 'execute' || !isManagedExecution(parsed.execution)) {
    return null
  }
  return {
    type: 'execute',
    id: parsed.id,
    execution: parsed.execution,
  }
}

export function splitManagedWorkerLines({
  buffer,
  chunk,
}: {
  buffer: string
  chunk: string
}): { lines: string[]; remainder: string } {
  const combined = buffer + chunk
  const parts = combined.split('\n')
  const remainder = parts.pop() ?? ''
  return { lines: parts, remainder }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBrowserResponse(value: unknown): value is BrowserResponse {
  if (!isRecord(value) || typeof value.requestId !== 'string' || typeof value.ok !== 'boolean') {
    return false
  }
  if (value.ok) {
    return isRecord(value.data)
  }
  const errorValue = value.error
  if (!isRecord(errorValue)) {
    return false
  }
  return typeof errorValue.code === 'string' && typeof errorValue.message === 'string' && typeof errorValue.outcome === 'string'
}

function isManagedExecution(value: unknown): value is ManagedExecution {
  if (!isRecord(value) || typeof value.cdpUrl !== 'string' || typeof value.connectionEpoch !== 'string') {
    return false
  }
  const request = value.request
  const tab = value.tab
  if (!isRecord(request) || !isRecord(tab)) {
    return false
  }
  if (typeof request.requestId !== 'string' || typeof request.sessionId !== 'string' || !isRecord(request.operation)) {
    return false
  }
  if (typeof request.operation.kind !== 'string' || typeof tab.tabId !== 'string' || typeof tab.sessionId !== 'string') {
    return false
  }
  if (typeof tab.groupId !== 'string' || typeof tab.profileId !== 'string' || typeof tab.chromeTabId !== 'number') {
    return false
  }
  return true
}
