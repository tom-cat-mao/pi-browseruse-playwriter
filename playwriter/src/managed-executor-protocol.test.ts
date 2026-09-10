import { describe, expect, test } from 'vitest'
import type { BrowserResponse } from './browser-protocol.js'
import {
  encodeManagedWorkerMessage,
  parseManagedWorkerCommand,
  parseManagedWorkerMessage,
  serializeBrowserJson,
  splitManagedWorkerLines,
} from './managed-executor-protocol.js'

describe('managed executor worker protocol', () => {
  test('round-trips structured responses without console marker parsing', () => {
    const response: BrowserResponse = {
      requestId: 'request-1',
      ok: true,
      data: {
        text: 'console.log(never becomes a marker)',
        value: { ok: true, count: 2 },
        logs: ['[log] a structured log'],
      },
    }
    const encoded = encodeManagedWorkerMessage({ type: 'response', id: 'command-1', response })
    expect(parseManagedWorkerMessage(encoded.trim())).toEqual({ type: 'response', id: 'command-1', response })
  })

  test('splits partial stdout chunks and rejects malformed protocol lines', () => {
    const ready = encodeManagedWorkerMessage({ type: 'ready', protocolVersion: 1 })
    const first = splitManagedWorkerLines({ buffer: '', chunk: ready.slice(0, 8) })
    const second = splitManagedWorkerLines({ buffer: first.remainder, chunk: ready.slice(8) })
    expect(second.lines.map((line) => parseManagedWorkerMessage(line))).toEqual([
      { type: 'ready', protocolVersion: 1 },
    ])
    expect(parseManagedWorkerMessage('{not-json}')).toBeNull()
  })

  test('parses an execute command separately from worker output messages', () => {
    const command = {
      type: 'execute' as const,
      id: 'command-1',
      execution: {
        request: {
          requestId: 'request-1',
          sessionId: 'session-1',
          operation: { kind: 'page.execute' as const, tabId: 'tab-1', code: 'return 1' },
        },
        tab: {
          tabId: 'tab-1',
          groupId: 'group-1',
          sessionId: 'session-1',
          profileId: 'profile-1',
          url: 'about:blank',
          title: '',
          state: 'ready' as const,
          browserEpoch: 'epoch-1',
          revision: 1,
          chromeTabId: 1,
          targetId: 'target-1',
        },
        cdpUrl: 'fixture://profile-1',
        connectionEpoch: 'epoch-1',
      },
    }
    const parsed = parseManagedWorkerCommand(JSON.stringify(command))
    expect(parsed).toEqual(command)
  })

  test('bounds circular and non-JSON JavaScript values', () => {
    const circular: { name: string; self?: unknown } = { name: 'root' }
    circular.self = circular
    expect(serializeBrowserJson({ circular, bigint: BigInt(3), undefinedValue: undefined })).toEqual({
      circular: { name: 'root', self: '[Circular]' },
      bigint: '[bigint] 3',
      undefinedValue: null,
    })
  })
})
