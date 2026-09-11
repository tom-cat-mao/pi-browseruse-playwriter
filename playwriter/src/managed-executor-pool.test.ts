import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import { describe, expect, test } from 'vitest'
import type { BrowserPageOperation, BrowserRequest, BrowserResponse, BrowserTab, ManagedExecution } from './browser-protocol.js'
import { ManagedCancellation, ManagedExecutorPool } from './managed-executor-pool.js'

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

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return
    }
    await waitForMilliseconds(10)
  }
  throw new Error(`timed out waiting for ${filePath}`)
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
      expect(fs.existsSync(path.join(cwd, `worker-exit-${firstPid}.txt`))).toBe(true)
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

  test('deadline signal wins over a same-tick explicit cancel and keeps timeout', async () => {
    const cwd = createTestDirectory('managed-executor-race-timeout-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
    try {
      await pool.execute(createExecution({ requestId: 'warmup', code: 'immediate', cwd, timeoutMs: 1_000 }))
      const controller = new AbortController()
      const pending = pool.execute({
        ...createExecution({ requestId: 'race-timeout', code: 'delayed-80', cwd, timeoutMs: 5_000 }),
        signal: controller.signal,
      })
      await waitForFile(path.join(cwd, 'dispatched.txt'))

      // The relay aborts its controller with the deadline reason and then calls
      // cancel() in the same tick; the first abort reason must win.
      controller.abort(new ManagedCancellation('timeout'))
      const cancel = pool.cancel({ sessionId: 'session-1', requestId: 'race-timeout', reason: 'cancelled' })

      const response = await pending
      await cancel
      expect(response).toMatchObject({
        requestId: 'race-timeout',
        ok: false,
        error: { code: 'timeout', outcome: 'unknown' },
      })
      await waitForMilliseconds(140)
      expect(fs.existsSync(path.join(cwd, 'late.txt'))).toBe(false)
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  test('explicit cancel stays cancelled when a deadline signal arrives right after', async () => {
    const cwd = createTestDirectory('managed-executor-race-cancel-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
    try {
      await pool.execute(createExecution({ requestId: 'warmup', code: 'immediate', cwd, timeoutMs: 1_000 }))
      const controller = new AbortController()
      const pending = pool.execute({
        ...createExecution({ requestId: 'race-cancel', code: 'delayed-80', cwd, timeoutMs: 5_000 }),
        signal: controller.signal,
      })
      await waitForFile(path.join(cwd, 'dispatched.txt'))

      const cancel = pool.cancel({ sessionId: 'session-1', requestId: 'race-cancel', reason: 'cancelled' })
      controller.abort(new ManagedCancellation('timeout'))

      await cancel
      const response = await pending
      expect(response).toMatchObject({
        requestId: 'race-cancel',
        ok: false,
        error: { code: 'cancelled', outcome: 'unknown' },
      })
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

  test('captures sync and async onInvalidate failures before completing termination', async () => {
    const cwd = createTestDirectory('managed-executor-invalidate-')
    const callbackCalls: string[] = []
    const pool = new ManagedExecutorPool({
      workerPath: workerPath('managed-executor-test-worker.ts'),
      onInvalidate: () => {
        callbackCalls.push('called')
        if (callbackCalls.length === 1) {
          throw new Error('sync invalidate failure')
        }
        return Promise.reject(new Error('async invalidate failure'))
      },
    })
    try {
      await pool.execute(createExecution({ requestId: 'warmup', code: 'immediate', cwd, timeoutMs: 1_000 }))
      const timedOut = await pool.execute(
        createExecution({ requestId: 'timeout', code: 'delayed-80', cwd, timeoutMs: 10 }),
      )
      expect(timedOut).toMatchObject({
        requestId: 'timeout',
        ok: false,
        error: { code: 'timeout', outcome: 'unknown' },
      })
      await waitForMilliseconds(140)
      expect(fs.existsSync(path.join(cwd, 'late.txt'))).toBe(false)

      await pool.execute(createExecution({ requestId: 'replacement', code: 'immediate', cwd, timeoutMs: 1_000 }))
      await pool.releaseSession({ sessionId: 'session-1' })
      expect(callbackCalls).toEqual(['called', 'called'])
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  test('waits for old worker exit before resolving while invalidation callback is delayed', async () => {
    const cwd = createTestDirectory('managed-executor-invalidate-delay-')
    const pool = new ManagedExecutorPool({
      workerPath: workerPath('managed-executor-test-worker.ts'),
      onInvalidate: async () => {
        await waitForMilliseconds(80)
      },
    })
    try {
      const warmup = await pool.execute(createExecution({ requestId: 'warmup', code: 'immediate', cwd, timeoutMs: 1_000 }))
      const oldPid = responsePid(warmup)
      const startedAt = Date.now()
      const response = await pool.execute(
        createExecution({ requestId: 'timeout', code: 'delayed-80', cwd, timeoutMs: 10 }),
      )

      expect(response).toMatchObject({
        requestId: 'timeout',
        ok: false,
        error: { code: 'timeout', outcome: 'unknown' },
      })
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60)
      expect(fs.existsSync(path.join(cwd, `worker-exit-${oldPid}.txt`))).toBe(true)
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  test('contains malformed stdout and stderr without taking down the parent', async () => {
    const cwd = createTestDirectory('managed-executor-budget-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
    try {
      const malformed = await pool.execute(
        createExecution({ requestId: 'malformed', code: 'malformed-response', cwd, timeoutMs: 2_000 }),
      )
      expect(malformed).toMatchObject({
        requestId: 'malformed',
        ok: false,
        error: { outcome: 'unknown' },
      })

      const stderrPool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
      try {
        const response = await stderrPool.execute(
          createExecution({ requestId: 'stderr', code: 'stderr-burst', cwd, timeoutMs: 2_000 }),
        )
        expect(responsePid(response)).toBeGreaterThan(0)
      } finally {
        await stderrPool.dispose()
      }
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)

  test('reports a broken worker stdin as an unknown in-flight outcome', async () => {
    const cwd = createTestDirectory('managed-executor-stdin-')
    const pool = new ManagedExecutorPool({ workerPath: workerPath('managed-executor-test-worker.ts') })
    try {
      const response = await pool.execute(
        createExecution({ requestId: 'stdin', code: 'stdin-broken', cwd, timeoutMs: 2_000 }),
      )
      expect(response).toMatchObject({
        requestId: 'stdin',
        ok: false,
        error: { code: 'outcome-unknown', outcome: 'unknown' },
      })
    } finally {
      await pool.dispose()
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }, 10_000)
})
