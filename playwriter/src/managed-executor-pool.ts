import childProcess from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import type {
  BrowserErrorCode,
  BrowserPageOperation,
  BrowserRequest,
  BrowserResponse,
  BrowserTab,
  ManagedCancelReason,
  ManagedExecution,
  ManagedExecutorPoolContract,
  ManagedExecutorPoolOptions,
} from './browser-protocol.js'
import {
  encodeManagedWorkerMessage,
  errorMessage,
  parseManagedWorkerMessage,
  splitManagedWorkerLines,
  type ManagedExecutorWorkerMessage,
} from './managed-executor-protocol.js'

const DEFAULT_EXECUTION_TIMEOUT_MS = 30_000
const MAX_EXECUTION_TIMEOUT_MS = 120_000
const WORKER_FORCE_KILL_DELAY_MS = 250
const WORKER_STARTUP_TIMEOUT_MS = 5_000
const MAX_WORKER_BUFFER_BYTES = 8 * 1024 * 1024

type ManagedWorkerProcess = ReturnType<typeof childProcess.spawn>

interface ManagedWorkerTask {
  commandId: string
  execution: ManagedExecution
  resolve: (response: BrowserResponse) => void
  worker: ManagedWorker | null
  started: boolean
  settled: boolean
  timeoutHandle: NodeJS.Timeout | null
  removeAbortListener: (() => void) | null
}

interface ManagedWorker {
  key: string
  sessionId: string
  profileId: string
  connectionEpoch: string
  cdpUrl: string
  process: ManagedWorkerProcess
  buffer: string
  ready: Promise<void>
  resolveReady: () => void
  rejectReady: (error: Error) => void
  readySettled: boolean
  invalidated: boolean
  exitHandled: boolean
  active: ManagedWorkerTask | null
  queue: ManagedWorkerTask[]
  diagnostics: string
  startupTimeoutHandle: NodeJS.Timeout | null
}

interface WorkerSpawnSpec {
  command: string
  args: string[]
}

interface ManagedExecutorValidation {
  timeoutMs: number
  operation: BrowserPageOperation
}

/**
 * Abort reason the relay plants on the controller it passes into execute().
 * The relay aborts that controller before it reaches pool.cancel(), so the
 * signal listener must read the reason from the signal instead of classifying
 * every abort as a user cancel. Plain aborts (client disconnect, profile
 * disconnect, shutdown) stay `cancelled`.
 */
export class ManagedCancellation extends Error {
  readonly cancelReason: ManagedCancelReason

  constructor(reason: ManagedCancelReason) {
    super(reason === 'timeout' ? 'Managed request deadline expired' : 'Managed request cancelled')
    this.name = 'ManagedCancellation'
    this.cancelReason = reason
  }
}

function cancelReasonFromSignal(signal: AbortSignal): ManagedCancelReason {
  return signal.reason instanceof ManagedCancellation ? signal.reason.cancelReason : 'cancelled'
}

/**
 * Owns one killable Playwright worker per session/profile/connection epoch.
 * The pool never opens a browser itself and never asks a worker to close the
 * user's browser or context. Killing an active worker invalidates its control
 * connection, but cannot undo a CDP action already accepted by Chrome.
 */
export class ManagedExecutorPool implements ManagedExecutorPoolContract {
  private readonly options: ManagedExecutorPoolOptions
  private readonly workers = new Map<string, ManagedWorker>()
  private readonly invalidations = new Map<string, Promise<void>>()
  private readonly pending = new Map<string, ManagedWorkerTask>()
  private nextCommandId = 0
  private disposed = false

  constructor(options: ManagedExecutorPoolOptions = {}) {
    this.options = options
  }

  execute(options: ManagedExecution & { signal?: AbortSignal }): Promise<BrowserResponse> {
    const validation = validateExecution(options)
    if (!validation.ok) {
      return Promise.resolve(validation.response)
    }

    if (this.disposed) {
      return Promise.resolve(
        errorResponse({
          requestId: options.request.requestId,
          code: 'internal-error',
          message: 'Managed executor pool has been disposed',
          outcome: 'not-started',
        }),
      )
    }

    const taskAndPromise = createTaskAndPromise({
      commandId: this.nextCommandIdValue(),
      execution: options,
    })
    const task = taskAndPromise.task
    const requestKey = requestKeyFor({
      sessionId: options.request.sessionId,
      requestId: options.request.requestId,
    })
    if (this.pending.has(requestKey)) {
      return Promise.resolve(
        errorResponse({
          requestId: options.request.requestId,
          code: 'invalid-request',
          message: `Duplicate in-flight requestId ${options.request.requestId}`,
          outcome: 'not-started',
        }),
      )
    }
    this.pending.set(requestKey, task)
    this.installTaskCancellation({
      task,
      requestKey,
      timeoutMs: validation.value.timeoutMs,
      signal: options.signal,
    })
    void this.enqueueTask({ task, key: workerKeyFor(options) })
    return taskAndPromise.promise
  }

  async cancel({
    sessionId,
    requestId,
    reason = 'cancelled',
  }: {
    sessionId: string
    requestId: string
    reason?: ManagedCancelReason
  }): Promise<void> {
    const task = this.pending.get(requestKeyFor({ sessionId, requestId }))
    if (!task) {
      return
    }
    this.abortTask({ task, reason })
  }

  async releaseSession({ sessionId }: { sessionId: string }): Promise<void> {
    const workers = [...this.workers.values()].filter((worker) => worker.sessionId === sessionId)
    await Promise.all(
      workers.map((worker) => {
        return this.invalidateWorker({
          worker,
          activeCode: 'cancelled',
          activeMessage: 'Managed session was released while the request was running',
        })
      }),
    )
    this.cancelUnassignedTasks({
      matches: (task) => task.execution.request.sessionId === sessionId,
      message: 'Managed session was released before the request started',
    })
  }

  async disconnectProfile({ profileId }: { profileId: string }): Promise<void> {
    const workers = [...this.workers.values()].filter((worker) => worker.profileId === profileId)
    await Promise.all(
      workers.map((worker) => {
        return this.invalidateWorker({
          worker,
          activeCode: 'profile-disconnected',
          activeMessage: 'Managed profile disconnected while the request was running',
        })
      }),
    )
    this.cancelUnassignedTasks({
      matches: (task) => task.execution.tab.profileId === profileId,
      message: 'Managed profile disconnected before the request started',
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return
    }
    this.disposed = true
    const workers = [...this.workers.values()]
    await Promise.all(
      workers.map((worker) => {
        return this.invalidateWorker({
          worker,
          activeCode: 'cancelled',
          activeMessage: 'Managed executor pool was disposed while the request was running',
          notify: false,
        })
      }),
    )
    this.cancelUnassignedTasks({
      matches: () => true,
      message: 'Managed executor pool was disposed before the request started',
    })
    this.workers.clear()
  }

  private nextCommandIdValue(): string {
    this.nextCommandId += 1
    return `managed-${this.nextCommandId}`
  }

  private installTaskCancellation({
    task,
    requestKey,
    timeoutMs,
    signal,
  }: {
    task: ManagedWorkerTask
    requestKey: string
    timeoutMs: number
    signal?: AbortSignal
  }): void {
    task.timeoutHandle = setTimeout(() => {
      this.abortTask({ task, reason: 'timeout' })
    }, timeoutMs)
    task.timeoutHandle.unref?.()

    if (!signal) {
      return
    }
    const onAbort = () => {
      this.abortTask({ task, reason: cancelReasonFromSignal(signal) })
    }
    signal.addEventListener('abort', onAbort, { once: true })
    task.removeAbortListener = () => {
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) {
      this.abortTask({ task, reason: cancelReasonFromSignal(signal) })
    }

    if (!this.pending.has(requestKey)) {
      task.removeAbortListener()
      task.removeAbortListener = null
    }
  }

  private async enqueueTask({ task, key }: { task: ManagedWorkerTask; key: string }): Promise<void> {
    if (task.settled) {
      return
    }
    try {
      const worker = await this.getOrCreateWorker({ execution: task.execution, key, task })
      if (task.settled || worker.invalidated) {
        return
      }
      task.worker = worker
      worker.queue.push(task)
      this.pumpWorker({ worker })
    } catch (error) {
      this.settleTask({
        task,
        response: errorResponse({
          requestId: task.execution.request.requestId,
          code: 'internal-error',
          message: `Could not start managed executor worker: ${errorMessage(error)}`,
          outcome: task.started ? 'unknown' : 'not-started',
        }),
      })
    }
  }

  private async getOrCreateWorker({
    execution,
    key,
    task,
  }: {
    execution: ManagedExecution
    key: string
    task: ManagedWorkerTask
  }): Promise<ManagedWorker> {
    const invalidation = this.invalidations.get(key)
    if (invalidation) {
      await invalidation
    }
    const existing = this.workers.get(key)
    if (existing && !existing.invalidated) {
      task.worker = existing
      if (existing.connectionEpoch !== execution.connectionEpoch || existing.cdpUrl !== execution.cdpUrl) {
        await this.invalidateWorker({
          worker: existing,
          activeCode: 'outcome-unknown',
          activeMessage: 'Managed connection epoch changed; the old worker was invalidated',
        })
      } else {
        await existing.ready
        return existing
      }
    }

    const replacement = this.workers.get(key)
    if (replacement && !replacement.invalidated) {
      task.worker = replacement
      await replacement.ready
      return replacement
    }

    const worker = this.spawnWorker({ execution, key })
    this.workers.set(key, worker)
    task.worker = worker
    try {
      await worker.ready
      if (worker.invalidated) {
        throw new Error('Managed executor worker was invalidated during startup')
      }
      return worker
    } catch (error) {
      await this.invalidateWorker({
        worker,
        activeCode: 'internal-error',
        activeMessage: 'Managed executor worker failed during startup',
        notify: false,
      })
      throw error
    }
  }

  private spawnWorker({ execution, key }: { execution: ManagedExecution; key: string }): ManagedWorker {
    const workerPath = resolveWorkerPath({ workerPath: this.options.workerPath })
    const spawnSpec = createWorkerSpawnSpec({ workerPath })
    const child = childProcess.spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(execution.request.cwd && path.isAbsolute(execution.request.cwd) ? { cwd: execution.request.cwd } : {}),
    })
    const ready = createReadyPromise()
    const worker: ManagedWorker = {
      key,
      sessionId: execution.request.sessionId,
      profileId: execution.tab.profileId,
      connectionEpoch: execution.connectionEpoch,
      cdpUrl: execution.cdpUrl,
      process: child,
      buffer: '',
      ready: ready.promise,
      resolveReady: ready.resolve,
      rejectReady: ready.reject,
      readySettled: false,
      invalidated: false,
      exitHandled: false,
      active: null,
      queue: [],
      diagnostics: '',
      startupTimeoutHandle: null,
    }
    worker.startupTimeoutHandle = setTimeout(() => {
      void this.invalidateWorker({
        worker,
        activeCode: 'internal-error',
        activeMessage: 'Managed executor worker did not become ready before the startup deadline',
      })
    }, WORKER_STARTUP_TIMEOUT_MS)
    worker.startupTimeoutHandle?.unref()

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      try {
        const split = splitManagedWorkerLines({ buffer: worker.buffer, chunk })
        worker.buffer = split.remainder
        if (Buffer.byteLength(worker.buffer, 'utf8') > MAX_WORKER_BUFFER_BYTES) {
          throw new Error('Managed executor worker output exceeded the protocol buffer limit')
        }
        split.lines.forEach((line) => {
          if (Buffer.byteLength(line, 'utf8') > MAX_WORKER_BUFFER_BYTES) {
            throw new Error('Managed executor worker message exceeded the protocol buffer limit')
          }
          const message = parseManagedWorkerMessage(line)
          if (message) {
            this.handleWorkerMessage({ worker, message })
          }
        })
      } catch (error) {
        void this.invalidateWorker({
          worker,
          activeCode: 'internal-error',
          activeMessage: `Managed executor worker output was invalid: ${errorMessage(error)}`,
        })
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      worker.diagnostics = `${worker.diagnostics}${chunk}`.slice(-4_000)
    })
    child.stdin?.on('error', (error) => {
      this.handleWorkerFailure({ worker, error })
    })
    child.on('error', (error) => {
      this.handleWorkerFailure({ worker, error })
    })
    child.on('exit', (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      this.handleWorkerFailure({
        worker,
        error: new Error(`Managed executor worker exited with ${suffix}${worker.diagnostics ? `: ${worker.diagnostics}` : ''}`),
      })
    })
    return worker
  }

  private handleWorkerMessage({ worker, message }: { worker: ManagedWorker; message: ManagedExecutorWorkerMessage }): void {
    if (message.type === 'ready') {
      if (!worker.readySettled) {
        worker.readySettled = true
        this.clearStartupTimeout({ worker })
        worker.resolveReady()
      }
      return
    }
    if (message.type === 'response') {
      const active = worker.active
      if (!active || active.commandId !== message.id) {
        return
      }
      worker.active = null
      this.settleTask({ task: active, response: message.response })
      this.pumpWorker({ worker })
      return
    }
    if (message.type === 'error') {
      const error = new Error(message.error.message)
      if (!worker.readySettled) {
        worker.readySettled = true
        worker.rejectReady(error)
      }
      if (message.id && worker.active?.commandId === message.id) {
        const active = worker.active
        worker.active = null
        this.settleTask({
          task: active,
          response: errorResponse({
            requestId: active.execution.request.requestId,
            code: 'execution-failed',
            message: message.error.message,
            outcome: active.started ? 'unknown' : 'not-started',
          }),
        })
        this.pumpWorker({ worker })
      }
    }
  }

  private handleWorkerFailure({ worker, error }: { worker: ManagedWorker; error: Error }): void {
    if (worker.exitHandled) {
      return
    }
    worker.exitHandled = true
    this.clearStartupTimeout({ worker })
    if (!worker.readySettled) {
      worker.readySettled = true
      worker.rejectReady(error)
    }
    if (this.workers.get(worker.key) === worker) {
      this.workers.delete(worker.key)
    }
    const active = worker.active
    worker.active = null
    const queued = worker.queue.splice(0, worker.queue.length)
    queued.forEach((task) => {
      this.settleTask({
        task,
        response: errorResponse({
          requestId: task.execution.request.requestId,
          code: 'internal-error',
          message: `Managed executor worker disconnected before the request started: ${error.message}`,
          outcome: 'not-started',
        }),
      })
    })
    if (!worker.invalidated) {
      worker.invalidated = true
      const shutdown = this.finishFailedWorker({ worker, active })
      this.trackInvalidation({ key: worker.key, promise: shutdown })
      void shutdown.catch((terminationError) => {
        console.error('[managed-executor] failed to terminate a failed worker:', errorMessage(terminationError))
      })
    }
  }

  private pumpWorker({ worker }: { worker: ManagedWorker }): void {
    if (worker.invalidated || worker.active) {
      return
    }
    const next = worker.queue.shift()
    if (!next) {
      return
    }
    if (next.settled) {
      this.pumpWorker({ worker })
      return
    }
    let line: string
    try {
      line = encodeManagedWorkerMessage({
        type: 'execute',
        id: next.commandId,
        execution: next.execution,
      })
    } catch (error) {
      this.settleTask({
        task: next,
        response: errorResponse({
          requestId: next.execution.request.requestId,
          code: 'invalid-request',
          message: `Could not serialize managed executor request: ${errorMessage(error)}`,
          outcome: 'not-started',
        }),
      })
      this.pumpWorker({ worker })
      return
    }
    worker.active = next
    next.started = true
    try {
      worker.process.stdin?.write(line)
    } catch (error) {
      worker.active = null
      this.settleTask({
        task: next,
        response: errorResponse({
          requestId: next.execution.request.requestId,
          code: 'outcome-unknown',
          message: `Managed executor request could not be sent: ${errorMessage(error)}`,
          outcome: 'unknown',
        }),
      })
      void this.invalidateWorker({
        worker,
        activeCode: 'outcome-unknown',
        activeMessage: 'Managed executor control pipe failed',
      })
    }
  }

  private abortTask({ task, reason }: { task: ManagedWorkerTask; reason: 'cancelled' | 'timeout' }): void {
    if (task.settled) {
      return
    }
    if (!task.started) {
      if (task.worker) {
        task.worker.queue = task.worker.queue.filter((queued) => queued !== task)
      }
      this.settleTask({
        task,
        response: errorResponse({
          requestId: task.execution.request.requestId,
          code: reason,
          message: reason === 'timeout' ? 'Managed executor request timed out before dispatch' : 'Managed executor request was cancelled before dispatch',
          outcome: 'not-started',
        }),
      })
      if (task.worker && !task.worker.readySettled) {
        void this.invalidateWorker({
          worker: task.worker,
          activeCode: reason,
          activeMessage: 'Managed executor worker was terminated before startup completed',
        })
      }
      return
    }
    const worker = task.worker
    if (!worker) {
      this.settleTask({
        task,
        response: errorResponse({
          requestId: task.execution.request.requestId,
          code: reason,
          message: reason === 'timeout' ? 'Managed executor request timed out' : 'Managed executor request was cancelled',
          outcome: 'unknown',
        }),
      })
      return
    }
    void this.invalidateWorker({
      worker,
      activeCode: reason,
      activeMessage: reason === 'timeout' ? 'Managed executor request timed out; worker was terminated' : 'Managed executor request was cancelled; worker was terminated',
    })
  }

  private invalidateWorker(options: {
    worker: ManagedWorker
    activeCode: BrowserErrorCode
    activeMessage: string
    notify?: boolean
  }): Promise<void> {
    const existing = this.invalidations.get(options.worker.key)
    if (existing) {
      return existing
    }
    const invalidation = this.performInvalidation(options)
    this.trackInvalidation({ key: options.worker.key, promise: invalidation })
    return invalidation
  }

  private async performInvalidation({
    worker,
    activeCode,
    activeMessage,
    notify = true,
  }: {
    worker: ManagedWorker
    activeCode: BrowserErrorCode
    activeMessage: string
    notify?: boolean
  }): Promise<void> {
    if (worker.invalidated) {
      return
    }
    worker.invalidated = true
    this.clearStartupTimeout({ worker })
    if (this.workers.get(worker.key) === worker) {
      this.workers.delete(worker.key)
    }
    if (!worker.readySettled) {
      worker.readySettled = true
      worker.rejectReady(new Error(activeMessage))
    }
    const active = worker.active
    worker.active = null
    const queued = worker.queue.splice(0, worker.queue.length)
    queued.forEach((task) => {
      this.settleTask({
        task,
        response: errorResponse({
          requestId: task.execution.request.requestId,
          code: 'cancelled',
          message: 'Managed executor worker was terminated before the request started',
          outcome: 'not-started',
        }),
      })
    })
    const termination = terminateWorkerProcess({ process: worker.process })
    try {
      if (notify) {
        await this.notifyInvalidated({ worker })
      }
    } finally {
      await termination
    }
    if (active) {
      this.settleTask({
        task: active,
        response: errorResponse({
          requestId: active.execution.request.requestId,
          code: activeCode,
          message: activeMessage,
          outcome: active.started ? 'unknown' : 'not-started',
        }),
      })
    }
  }

  private async finishFailedWorker({ worker, active }: { worker: ManagedWorker; active: ManagedWorkerTask | null }): Promise<void> {
    const termination = terminateWorkerProcess({ process: worker.process })
    try {
      await this.notifyInvalidated({ worker })
    } finally {
      await termination
    }
    if (active) {
      this.settleTask({
        task: active,
        response: errorResponse({
          requestId: active.execution.request.requestId,
          code: 'outcome-unknown',
          message: 'Managed executor worker disconnected after the request was dispatched',
          outcome: 'unknown',
        }),
      })
    }
  }

  private async notifyInvalidated({ worker }: { worker: ManagedWorker }): Promise<void> {
    const callback = this.options.onInvalidate
    if (!callback) {
      return
    }
    try {
      await callback({
        sessionId: worker.sessionId,
        profileId: worker.profileId,
        connectionEpoch: worker.connectionEpoch,
      })
    } catch (error) {
      console.error('[managed-executor] onInvalidate callback failed:', errorMessage(error))
    }
  }

  private trackInvalidation({ key, promise }: { key: string; promise: Promise<void> }): void {
    this.invalidations.set(key, promise)
    void promise.then(
      () => {
        if (this.invalidations.get(key) === promise) {
          this.invalidations.delete(key)
        }
      },
      () => {
        if (this.invalidations.get(key) === promise) {
          this.invalidations.delete(key)
        }
      },
    )
  }

  private clearStartupTimeout({ worker }: { worker: ManagedWorker }): void {
    if (!worker.startupTimeoutHandle) {
      return
    }
    clearTimeout(worker.startupTimeoutHandle)
    worker.startupTimeoutHandle = null
  }

  private cancelUnassignedTasks({ matches, message }: { matches: (task: ManagedWorkerTask) => boolean; message: string }): void {
    const tasks = [...this.pending.values()].filter((task) => !task.worker && matches(task))
    tasks.forEach((task) => {
      this.settleTask({
        task,
        response: errorResponse({
          requestId: task.execution.request.requestId,
          code: 'cancelled',
          message,
          outcome: 'not-started',
        }),
      })
    })
  }

  private settleTask({ task, response }: { task: ManagedWorkerTask; response: BrowserResponse }): void {
    if (task.settled) {
      return
    }
    task.settled = true
    if (task.timeoutHandle) {
      clearTimeout(task.timeoutHandle)
      task.timeoutHandle = null
    }
    task.removeAbortListener?.()
    task.removeAbortListener = null
    this.pending.delete(
      requestKeyFor({
        sessionId: task.execution.request.sessionId,
        requestId: task.execution.request.requestId,
      }),
    )
    task.resolve(response)
  }
}

function createTaskAndPromise({
  commandId,
  execution,
}: {
  commandId: string
  execution: ManagedExecution
}): { task: ManagedWorkerTask; promise: Promise<BrowserResponse> } {
  let resolveTask: (response: BrowserResponse) => void = () => {}
  const promise = new Promise<BrowserResponse>((resolve) => {
    resolveTask = resolve
  })
  const task: ManagedWorkerTask = {
    commandId,
    execution,
    resolve: resolveTask,
    worker: null,
    started: false,
    settled: false,
    timeoutHandle: null,
    removeAbortListener: null,
  }
  return { task, promise }
}

function createReadyPromise(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolveReady: () => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const promise = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  return { promise, resolve: resolveReady, reject: rejectReady }
}

function validateExecution(
  execution: ManagedExecution & { signal?: AbortSignal },
): { ok: true; value: ManagedExecutorValidation } | { ok: false; response: BrowserResponse } {
  const operation = execution.request.operation
  if (!isBrowserPageOperation(operation) || operation.tabId !== execution.tab.tabId) {
    return {
      ok: false,
      response: errorResponse({
        requestId: execution.request.requestId,
        code: 'invalid-request',
        message: 'Managed executor requires a page operation for the explicit tab in the request',
        outcome: 'not-started',
      }),
    }
  }
  if (!execution.request.sessionId || execution.request.sessionId !== execution.tab.sessionId) {
    return {
      ok: false,
      response: errorResponse({
        requestId: execution.request.requestId,
        code: 'ownership-mismatch',
        message: 'Request session does not own the selected tab',
        outcome: 'not-started',
      }),
    }
  }
  if (!execution.tab.profileId || !execution.tab.targetId) {
    return {
      ok: false,
      response: errorResponse({
        requestId: execution.request.requestId,
        code: 'resource-not-found',
        message: 'Managed executor requires a profile-bound tab with an explicit targetId',
        outcome: 'not-started',
      }),
    }
  }
  if (execution.tab.state !== 'ready') {
    return {
      ok: false,
      response: errorResponse({
        requestId: execution.request.requestId,
        code: execution.tab.state === 'released' ? 'resource-released' : 'profile-disconnected',
        message: `Tab ${execution.tab.tabId} is ${execution.tab.state}`,
        outcome: 'not-started',
      }),
    }
  }
  const timeoutMs = execution.request.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_EXECUTION_TIMEOUT_MS) {
    return {
      ok: false,
      response: errorResponse({
        requestId: execution.request.requestId,
        code: 'invalid-request',
        message: `timeoutMs must be an integer between 1 and ${MAX_EXECUTION_TIMEOUT_MS}`,
        outcome: 'not-started',
      }),
    }
  }
  return { ok: true, value: { timeoutMs, operation } }
}

function isBrowserPageOperation(operation: BrowserRequest['operation']): operation is BrowserPageOperation {
  return operation.kind.startsWith('page.')
}

function workerKeyFor(execution: ManagedExecution): string {
  return JSON.stringify([execution.request.sessionId, execution.tab.profileId])
}

function requestKeyFor({ sessionId, requestId }: { sessionId: string; requestId: string }): string {
  return JSON.stringify([sessionId, requestId])
}

function errorResponse({
  requestId,
  code,
  message,
  outcome,
}: {
  requestId: string
  code: BrowserErrorCode
  message: string
  outcome: 'not-started' | 'unknown'
}): BrowserResponse {
  return {
    requestId,
    ok: false,
    error: { code, message, outcome },
  }
}

function resolveWorkerPath({ workerPath }: { workerPath?: string }): string {
  if (workerPath) {
    return path.resolve(workerPath)
  }
  const currentDirectory = path.dirname(url.fileURLToPath(import.meta.url))
  const compiledPath = path.join(currentDirectory, 'managed-executor-worker.js')
  if (fs.existsSync(compiledPath)) {
    return compiledPath
  }
  return path.join(currentDirectory, 'managed-executor-worker.ts')
}

function createWorkerSpawnSpec({ workerPath }: { workerPath: string }): WorkerSpawnSpec {
  if (path.extname(workerPath).toLowerCase() !== '.ts') {
    return { command: process.execPath, args: [workerPath] }
  }
  const tsxCli = findTsxCli()
  if (tsxCli) {
    return { command: process.execPath, args: [tsxCli, workerPath] }
  }
  const inheritedLoader = process.execArgv.some((argument) => {
    return argument === '--import' || argument === '--loader' || argument === '-r' || argument === '--require'
  })
  if (inheritedLoader) {
    return { command: process.execPath, args: [...process.execArgv, workerPath] }
  }
  throw new Error(`Cannot run TypeScript worker ${workerPath}; start the parent with a TypeScript loader such as tsx`)
}

function findTsxCli(): string | null {
  try {
    const resolved = url.fileURLToPath(import.meta.resolve('tsx/cli'))
    if (fs.existsSync(resolved)) {
      return resolved
    }
  } catch {
    // The compiled runtime does not require tsx. Source mode reports a clear
    // error below when the development loader is not installed.
  }
  const candidates = [
    path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs'),
    path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../../node_modules/tsx/dist/cli.mjs'),
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

async function terminateWorkerProcess({ process: workerProcess }: { process: ManagedWorkerProcess }): Promise<void> {
  if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    let settled = false
    let forceKillTimer: NodeJS.Timeout | null = null
    let settleTimer: NodeJS.Timeout | null = null
    const settle = () => {
      if (settled) {
        return
      }
      settled = true
      if (forceKillTimer) {
        clearTimeout(forceKillTimer)
      }
      if (settleTimer) {
        clearTimeout(settleTimer)
      }
      workerProcess.off('exit', settle)
      workerProcess.off('error', settle)
      resolve()
    }
    workerProcess.once('exit', settle)
    workerProcess.once('error', settle)
    try {
      workerProcess.kill()
    } catch (error) {
      console.error('[managed-executor] stopping worker failed:', errorMessage(error))
      settle()
      return
    }
    forceKillTimer = setTimeout(() => {
      if (workerProcess.exitCode !== null || workerProcess.signalCode !== null) {
        settle()
        return
      }
      try {
        workerProcess.kill('SIGKILL')
      } catch (error) {
        console.error('[managed-executor] force-killing worker failed:', errorMessage(error))
      }
      settleTimer = setTimeout(settle, WORKER_FORCE_KILL_DELAY_MS)
      settleTimer.unref?.()
    }, WORKER_FORCE_KILL_DELAY_MS)
    forceKillTimer.unref?.()
  })
}
