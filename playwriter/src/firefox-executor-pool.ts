import childProcess from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import type {
  BrowserDomRequest,
  BrowserErrorCode,
  BrowserRequest,
  BrowserResponse,
  BrowserTab,
  ManagedCancelReason,
} from './browser-protocol.js'
import { ManagedCancellation } from './managed-executor-pool.js'
import { errorMessage } from './managed-executor-protocol.js'
import {
  isFirefoxBrowserResponse,
  parseFirefoxWorkerMessage,
  validateFirefoxMessageSize,
  type FirefoxWorkerCommand,
  type FirefoxWorkerMessage,
} from './firefox-executor-protocol.js'

export interface FirefoxExecution {
  request: BrowserRequest
  tab: BrowserTab
  connectionEpoch?: string
  signal?: AbortSignal
  sendDomRequest: (request: BrowserDomRequest) => Promise<BrowserResponse>
}

interface FirefoxTask {
  id: string
  key: string
  execution: FirefoxExecution
  deadline: number
  started: boolean
  settled: boolean
  worker: FirefoxWorker | null
  timeout: NodeJS.Timeout | null
  removeAbortListener: () => void
  resolve: (response: BrowserResponse) => void
  rpcIds: Set<string>
  rpcQueue: Promise<void>
}

interface FirefoxWorker {
  key: string
  sessionId: string
  profileId: string
  browserEpoch: string
  connectionEpoch: string
  process: childProcess.ChildProcess
  ready: boolean
  invalidated: boolean
  startupTimeout: NodeJS.Timeout | null
  active: FirefoxTask | null
  queue: FirefoxTask[]
  diagnostics: string
}

/** A killable JS process per session/profile/epoch; every DOM RPC stays bound to the outer request. */
export class FirefoxExecutorPool {
  private readonly workers = new Map<string, FirefoxWorker>()
  private readonly pending = new Map<string, FirefoxTask>()
  private readonly terminations = new Set<Promise<void>>()
  private disposed = false

  execute(options: FirefoxExecution): Promise<BrowserResponse> {
    const validation = validateExecution(options)
    if (validation) {
      return Promise.resolve(validation)
    }
    if (this.disposed) {
      return Promise.resolve(failure({ requestId: options.request.requestId, code: 'cancelled', message: 'Firefox executor is disposed' }))
    }
    const key = JSON.stringify([options.request.sessionId, options.request.requestId])
    if (this.pending.has(key)) {
      return Promise.resolve(failure({ requestId: options.request.requestId, code: 'invalid-request', message: 'Duplicate in-flight requestId' }))
    }
    const execution: FirefoxExecution = {
      ...options,
      request: structuredClone(options.request),
      tab: structuredClone(options.tab),
    }
    let resolveTask: (response: BrowserResponse) => void = () => {}
    const promise = new Promise<BrowserResponse>((resolve) => {
      resolveTask = resolve
    })
    const task: FirefoxTask = {
      id: crypto.randomUUID(), key, execution,
      deadline: Date.now() + (execution.request.timeoutMs ?? 30_000),
      started: false, settled: false, worker: null, timeout: null,
      removeAbortListener: () => {}, resolve: resolveTask,
      rpcIds: new Set<string>(), rpcQueue: Promise.resolve(),
    }
    this.pending.set(key, task)
    task.timeout = setTimeout(() => {
      this.abortTask({ task, reason: 'timeout' })
    }, Math.max(1, task.deadline - Date.now()))
    if (options.signal) {
      const signal = options.signal
      const abort = () => {
        this.abortTask({ task, reason: signal.reason instanceof ManagedCancellation ? signal.reason.cancelReason : 'cancelled' })
      }
      signal.addEventListener('abort', abort, { once: true })
      task.removeAbortListener = () => {
        signal.removeEventListener('abort', abort)
      }
      if (signal.aborted) {
        abort()
      }
    }
    if (!task.settled) {
      this.enqueue(task)
    }
    return promise
  }

  async cancel({ sessionId, requestId, reason = 'cancelled' }: {
    sessionId: string
    requestId: string
    reason?: ManagedCancelReason
  }): Promise<void> {
    const task = this.pending.get(JSON.stringify([sessionId, requestId]))
    if (task) {
      this.abortTask({ task, reason })
    }
    await Promise.all([...this.terminations])
  }

  async releaseSession({ sessionId }: { sessionId: string }): Promise<void> {
    await this.invalidateMatching({
      matches: (worker) => { return worker.sessionId === sessionId },
      code: 'cancelled', message: 'Firefox session was released',
    })
  }

  async disconnectProfile({ profileId }: { profileId: string }): Promise<void> {
    await this.invalidateMatching({
      matches: (worker) => { return worker.profileId === profileId },
      code: 'profile-disconnected', message: 'Firefox profile disconnected',
    })
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.invalidateMatching({
      matches: () => { return true }, code: 'cancelled', message: 'Firefox executor was disposed',
    })
    await Promise.all([...this.terminations])
  }

  private enqueue(task: FirefoxTask): void {
    const execution = task.execution
    const key = JSON.stringify([execution.request.sessionId, execution.tab.profileId])
    let worker = this.workers.get(key)
    const connectionEpoch = execution.connectionEpoch ?? execution.tab.browserEpoch
    if (worker && (worker.browserEpoch !== execution.tab.browserEpoch || worker.connectionEpoch !== connectionEpoch)) {
      void this.invalidate({ worker, code: 'profile-disconnected', message: 'Firefox connection epoch changed' })
      worker = undefined
    }
    try {
      if (!worker) {
        worker = this.spawn({ execution, key, connectionEpoch })
        this.workers.set(key, worker)
      }
      task.worker = worker
      worker.queue.push(task)
      this.pump(worker)
    } catch (error) {
      this.settle({ task, response: failure({ requestId: execution.request.requestId, code: 'internal-error', message: errorMessage(error) }) })
    }
  }

  private spawn({ execution, key, connectionEpoch }: {
    execution: FirefoxExecution
    key: string
    connectionEpoch: string
  }): FirefoxWorker {
    const workerPath = resolveWorkerPath()
    const child = childProcess.fork(workerPath, [], {
      execArgv: workerArguments(workerPath),
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      serialization: 'json',
      cwd: execution.request.cwd ?? process.cwd(),
    })
    const worker: FirefoxWorker = {
      key, sessionId: execution.request.sessionId, profileId: execution.tab.profileId,
      browserEpoch: execution.tab.browserEpoch, connectionEpoch, process: child,
      ready: false, invalidated: false, startupTimeout: null, active: null, queue: [], diagnostics: '',
    }
    worker.startupTimeout = setTimeout(() => {
      void this.invalidate({ worker, code: 'internal-error', message: 'Firefox executor did not start within 5 seconds' })
    }, 5_000)
    child.on('message', (value: unknown) => {
      if (worker.invalidated) {
        return
      }
      try {
        validateFirefoxMessageSize(value)
        const message = parseFirefoxWorkerMessage(value)
        if (!message) {
          throw new Error('Malformed Firefox executor IPC message')
        }
        this.handleMessage({ worker, message })
      } catch (error) {
        void this.invalidate({ worker, code: 'internal-error', message: errorMessage(error) })
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      worker.diagnostics = `${worker.diagnostics}${chunk}`.slice(-4_000)
    })
    child.stdout?.resume()
    child.on('error', (error) => {
      void this.invalidate({ worker, code: 'internal-error', message: `Firefox executor process failed: ${errorMessage(error)}` })
    })
    child.on('exit', (code, signal) => {
      void this.invalidate({
        worker, code: 'outcome-unknown',
        message: `Firefox executor exited (${signal ?? code})${worker.diagnostics ? `: ${worker.diagnostics}` : ''}`,
      })
    })
    return worker
  }

  private handleMessage({ worker, message }: { worker: FirefoxWorker; message: FirefoxWorkerMessage }): void {
    if (message.type === 'ready') {
      if (worker.ready) {
        throw new Error('Firefox executor sent duplicate readiness')
      }
      worker.ready = true
      if (worker.startupTimeout) {
        clearTimeout(worker.startupTimeout)
        worker.startupTimeout = null
      }
      this.pump(worker)
      return
    }
    const task = worker.active
    if (!task || task.id !== message.id || task.settled) {
      return
    }
    if (message.type === 'response') {
      if (message.response.requestId !== task.execution.request.requestId) {
        throw new Error('Firefox executor response requestId does not match its lease')
      }
      worker.active = null
      this.settle({ task, response: message.response })
      this.pump(worker)
      return
    }
    if (task.rpcIds.has(message.rpcId) || task.rpcIds.size >= 10_000) {
      throw new Error('Firefox executor sent duplicate or excessive DOM requests')
    }
    if (message.command.method === 'operation' && message.command.operation.tabId !== task.execution.tab.tabId) {
      throw new Error('Firefox executor DOM operation does not match the selected tab')
    }
    if (message.command.method === 'dispose' || message.command.method === 'screenshot.prepare' || message.command.method === 'screenshot.cleanup') {
      throw new Error('Firefox executor requested an extension-only internal command')
    }
    task.rpcIds.add(message.rpcId)
    task.rpcQueue = task.rpcQueue.then(async () => {
      if (!this.isLeaseActive({ worker, task })) {
        return
      }
      const { execution } = task
      const domRequest: BrowserDomRequest = {
        requestId: `${task.id}:${message.rpcId}`,
        sessionId: execution.request.sessionId,
        tabId: execution.tab.tabId,
        browserEpoch: execution.tab.browserEpoch,
        timeoutMs: Math.max(1, Math.min(5_000, task.deadline - Date.now())),
        command: message.command,
      }
      let response: BrowserResponse
      try {
        response = await execution.sendDomRequest(domRequest)
        if (!isFirefoxBrowserResponse(response) || response.requestId !== domRequest.requestId) {
          throw new Error('Firefox DOM response does not match the request')
        }
        validateFirefoxMessageSize(response)
      } catch (error) {
        response = failure({ requestId: domRequest.requestId, code: 'outcome-unknown', message: `Firefox DOM request failed: ${errorMessage(error)}`, started: true })
      }
      if (this.isLeaseActive({ worker, task })) {
        this.send({ worker, command: { type: 'dom-response', id: task.id, rpcId: message.rpcId, response } })
      }
    }).catch((error) => {
      void this.invalidate({ worker, code: 'outcome-unknown', message: errorMessage(error) })
    })
  }

  private isLeaseActive({ worker, task }: { worker: FirefoxWorker; task: FirefoxTask }): boolean {
    return !this.disposed && !worker.invalidated && worker.active === task && !task.settled &&
      this.pending.get(task.key) === task && this.workers.get(worker.key) === worker &&
      !task.execution.signal?.aborted && Date.now() < task.deadline &&
      task.execution.request.sessionId === worker.sessionId && task.execution.tab.profileId === worker.profileId &&
      task.execution.tab.browserEpoch === worker.browserEpoch
  }

  private pump(worker: FirefoxWorker): void {
    if (!worker.ready || worker.invalidated || worker.active) {
      return
    }
    let task = worker.queue.shift()
    while (task?.settled) {
      task = worker.queue.shift()
    }
    if (!task) {
      return
    }
    const operation = task.execution.request.operation
    if (operation.kind !== 'page.execute') {
      return
    }
    worker.active = task
    task.started = true
    this.send({ worker, command: {
      type: 'execute', id: task.id,
      execution: {
        requestId: task.execution.request.requestId, tabId: task.execution.tab.tabId, code: operation.code,
        deadline: task.deadline, cwd: task.execution.request.cwd ?? process.cwd(), url: task.execution.tab.url,
      },
    } })
  }

  private send({ worker, command }: { worker: FirefoxWorker; command: FirefoxWorkerCommand }): void {
    try {
      validateFirefoxMessageSize(command)
      if (!worker.process.connected) {
        throw new Error('Firefox executor IPC is disconnected')
      }
      worker.process.send(command, (error) => {
        if (error) {
          void this.invalidate({ worker, code: 'outcome-unknown', message: errorMessage(error) })
        }
      })
    } catch (error) {
      void this.invalidate({ worker, code: 'outcome-unknown', message: errorMessage(error) })
    }
  }

  private abortTask({ task, reason }: { task: FirefoxTask; reason: ManagedCancelReason }): void {
    if (task.settled || task.worker?.invalidated) {
      return
    }
    const message = reason === 'timeout' ? 'Firefox execution deadline expired' : 'Firefox execution was cancelled'
    if (task.worker && task.started) {
      void this.invalidate({ worker: task.worker, code: reason, message })
      return
    }
    this.settle({ task, response: failure({ requestId: task.execution.request.requestId, code: reason, message }) })
    if (task.worker && !task.worker.ready) {
      void this.invalidate({ worker: task.worker, code: reason, message })
    }
  }

  private async invalidateMatching({ matches, code, message }: {
    matches: (worker: FirefoxWorker) => boolean
    code: BrowserErrorCode
    message: string
  }): Promise<void> {
    await Promise.all([...this.workers.values()].filter(matches).map((worker) => {
      return this.invalidate({ worker, code, message })
    }))
  }

  private invalidate({ worker, code, message }: {
    worker: FirefoxWorker
    code: BrowserErrorCode
    message: string
  }): Promise<void> {
    if (worker.invalidated) {
      return Promise.resolve()
    }
    worker.invalidated = true
    if (worker.startupTimeout) {
      clearTimeout(worker.startupTimeout)
      worker.startupTimeout = null
    }
    if (this.workers.get(worker.key) === worker) {
      this.workers.delete(worker.key)
    }
    const active = worker.active
    worker.active = null
    for (const task of worker.queue.splice(0)) {
      this.settle({ task, response: failure({ requestId: task.execution.request.requestId, code, message: `${message}; queued request was not started` }) })
    }
    const termination = terminateWorker(worker.process).then(() => {
      if (active) {
        this.settle({ task: active, response: failure({ requestId: active.execution.request.requestId, code, message, started: active.started }) })
      }
    })
    this.terminations.add(termination)
    void termination.finally(() => {
      this.terminations.delete(termination)
    })
    return termination
  }

  private settle({ task, response }: { task: FirefoxTask; response: BrowserResponse }): void {
    if (task.settled) {
      return
    }
    task.settled = true
    if (task.timeout) {
      clearTimeout(task.timeout)
      task.timeout = null
    }
    task.removeAbortListener()
    this.pending.delete(task.key)
    task.resolve(response)
  }
}

function validateExecution(execution: FirefoxExecution): BrowserResponse | null {
  const { request, tab } = execution
  const reject = (options: { code: BrowserErrorCode; message: string }): BrowserResponse => {
    return failure({ requestId: request.requestId, ...options })
  }
  if (request.operation.kind !== 'page.execute' || request.operation.tabId !== tab.tabId ||
    typeof request.operation.code !== 'string' || request.operation.code.length > 1_000_000) {
    return reject({ code: 'invalid-request', message: 'Firefox executor requires page.execute for the explicit selected tab' })
  }
  if (!request.requestId || !request.sessionId || request.sessionId !== tab.sessionId) {
    return reject({ code: 'ownership-mismatch', message: 'Request session does not own the Firefox tab' })
  }
  if (!tab.profileId || !tab.browserEpoch || !Number.isSafeInteger(tab.browserTabId) || (tab.browserTabId ?? -1) < 0 ||
    tab.chromeTabId !== -1 || tab.targetId || tab.cdpSessionId) {
    return reject({ code: 'invalid-request', message: 'Firefox executor requires a real Firefox tab binding without CDP identity' })
  }
  if (tab.state !== 'ready') {
    return reject({ code: tab.state === 'released' ? 'resource-released' : 'profile-disconnected', message: `Firefox tab is ${tab.state}` })
  }
  const timeoutMs = request.timeoutMs ?? 30_000
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    return reject({ code: 'invalid-request', message: 'Firefox execution timeout must be between 1 and 120000 ms' })
  }
  if (request.cwd && !path.isAbsolute(request.cwd)) {
    return reject({ code: 'invalid-request', message: 'Firefox execution cwd must be an absolute path' })
  }
  return null
}

function failure({ requestId, code, message, started = false }: {
  requestId: string
  code: BrowserErrorCode
  message: string
  started?: boolean
}): BrowserResponse {
  return { requestId, ok: false, error: { code, message, outcome: started ? 'unknown' : 'not-started' } }
}

function resolveWorkerPath(): string {
  const directory = path.dirname(url.fileURLToPath(import.meta.url))
  const compiled = path.join(directory, 'firefox-executor-worker.js')
  return fs.existsSync(compiled) ? compiled : path.join(directory, 'firefox-executor-worker.ts')
}

function workerArguments(workerPath: string): string[] {
  if (workerPath.endsWith('.js')) {
    return ['--max-old-space-size=128']
  }
  return ['--max-old-space-size=128', '--import', import.meta.resolve('tsx')]
}

async function terminateWorker(child: childProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return
  }
  await new Promise<void>((resolve) => {
    let forceKill: NodeJS.Timeout | undefined
    let finalTimeout: NodeJS.Timeout | undefined
    let settled = false
    const done = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(forceKill)
      clearTimeout(finalTimeout)
      child.off('exit', done)
      child.off('error', done)
      resolve()
    }
    child.once('exit', done)
    child.once('error', done)
    try {
      child.kill('SIGTERM')
    } catch {
      done()
      return
    }
    forceKill = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        done()
        return
      }
      finalTimeout = setTimeout(done, 250)
    }, 250)
  })
}
