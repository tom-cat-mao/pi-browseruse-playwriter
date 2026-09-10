import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, expect, test } from 'vitest'
import type { BrowserPageOperation, BrowserRequest, BrowserResponse, BrowserTab, ManagedExecution } from './browser-protocol.js'
import { ManagedExecutorPool } from './managed-executor-pool.js'

function createTestDirectory(prefix: string): string {
  const root = path.join(process.cwd(), 'tmp')
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, prefix))
}

function createExecution({
  requestId,
  code,
  cwd,
  timeoutMs,
}: {
  requestId: string
  code: string
  cwd: string
  timeoutMs: number
}): ManagedExecution {
  const request: BrowserRequest & { operation: BrowserPageOperation } = {
    requestId,
    sessionId: 'session-1',
    cwd,
    timeoutMs,
    operation: {
      kind: 'page.execute',
      tabId: 'tab-1',
      code,
    },
  }
  const tab: BrowserTab = {
    tabId: 'tab-1',
    groupId: 'group-1',
    sessionId: 'session-1',
    profileId: 'profile-1',
    url: 'about:blank',
    title: '',
    state: 'ready',
    browserEpoch: 'epoch-1',
    revision: 1,
    chromeTabId: 1,
    targetId: 'target-1',
  }
  return {
    request,
    tab,
    cdpUrl: 'fixture://profile-1',
    connectionEpoch: 'epoch-1',
  }
}

function workerPath(name: string): string {
  return url.fileURLToPath(new URL(`./${name}`, import.meta.url))
}

function responsePid(response: BrowserResponse): number {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  const value = response.data.value
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.pid !== 'number') {
    throw new Error('fixture response did not contain a pid')
  }
  return value.pid
}

async function waitForMilliseconds(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

describe('ManagedExecutorPool child-process lifecycle', () => {
  test('deadline kills a dispatched worker and the next request gets a new worker', async () => {
    const cwd = createTestDirectory('managed-executor-timeout-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
    try {
      const warmup = await pool.execute(createExecution({ requestId: 'warmup', code: 'immediate', cwd, timeoutMs: 1_000 }))
      const firstPid = responsePid(warmup)

      const timedOut = await pool.execute(
        createExecution({ requestId: 'timeout', code: 'delayed-80', cwd, timeoutMs: 10 }),
      )
      expect(timedOut).toMatchObject({
        requestId: 'timeout',
        ok: false,
        error: { code: 'timeout', outcome: 'unknown' },
      })
      expect(fs.existsSync(path.join(cwd, 'dispatched.txt'))).toBe(true)

      await waitForMilliseconds(140)
      expect(fs.existsSync(path.join(cwd, 'late.txt'))).toBe(false)

      const replacement = await pool.execute(
        createExecution({ requestId: 'replacement', code: 'immediate', cwd, timeoutMs: 1_000 }),
      )
      expect(responsePid(replacement)).not.toBe(firstPid)
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  test('abort kills a dispatched worker and does not replay its delayed command', async () => {
    const cwd = createTestDirectory('managed-executor-abort-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
    try {
      await pool.execute(createExecution({ requestId: 'warmup', code: 'immediate', cwd, timeoutMs: 1_000 }))
      const controller = new AbortController()
      const pending = pool.execute({
        ...createExecution({ requestId: 'abort', code: 'delayed-80', cwd, timeoutMs: 1_000 }),
        signal: controller.signal,
      })
      setTimeout(() => {
        controller.abort(new Error('test cancellation'))
      }, 10)

      const cancelled = await pending
      expect(cancelled).toMatchObject({
        requestId: 'abort',
        ok: false,
        error: { code: 'cancelled', outcome: 'unknown' },
      })
      expect(fs.existsSync(path.join(cwd, 'dispatched.txt'))).toBe(true)
      await waitForMilliseconds(140)
      expect(fs.existsSync(path.join(cwd, 'late.txt'))).toBe(false)
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  test('cancelling while startup is silent terminates the unready child', async () => {
    const cwd = createTestDirectory('managed-executor-silent-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-silent-worker.ts') })
    try {
      const response = await pool.execute(
        createExecution({ requestId: 'silent', code: 'ignored', cwd, timeoutMs: 300 }),
      )
      expect(response).toMatchObject({
        requestId: 'silent',
        ok: false,
        error: { code: 'timeout', outcome: 'not-started' },
      })
      expect(fs.existsSync(path.join(cwd, 'silent-worker-started.txt'))).toBe(true)
      await waitForMilliseconds(700)
      expect(fs.existsSync(path.join(cwd, 'silent-worker-late.txt'))).toBe(false)
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)
})
