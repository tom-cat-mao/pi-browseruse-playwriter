import * as acorn from 'acorn'
import crypto from 'node:crypto'
import path from 'node:path'
import vm from 'node:vm'
import type { BrowserDomCommand, BrowserErrorCode, BrowserImage, BrowserResultData, BrowserResponse } from './browser-protocol.js'
import { parseBrowserDomCommand } from './browser-dom-validation.js'
import { createFirefoxFacade, FirefoxCapabilityError, FirefoxSnapshotError } from './firefox-executor-facade.js'
import {
  parseFirefoxWorkerCommand,
  validateFirefoxMessageSize,
  type FirefoxWorkerCommand,
  type FirefoxWorkerExecution,
  type FirefoxWorkerMessage,
} from './firefox-executor-protocol.js'
import { serializeBrowserJson, truncateString } from './managed-executor-protocol.js'

interface PendingDom {
  executionId: string
  resolve: (data: BrowserResultData) => void
  reject: (error: Error) => void
}

class FirefoxDomError extends Error {
  readonly code: BrowserErrorCode
  readonly outcome: 'not-started' | 'unknown'

  constructor(error: Extract<BrowserResponse, { ok: false }>['error']) {
    super(error.message)
    this.code = error.code
    this.outcome = error.outcome
  }
}

class ExecutionLease {
  active = true
  readonly requests = new Set<Promise<BrowserResultData>>()
  private readonly timers = new Set<NodeJS.Timeout>()

  assertActive(): void {
    if (!this.active) {
      throw new FirefoxCapabilityError('This Firefox execute lease ended; create page/locators in the current request')
    }
  }

  timer({ handler, delay, interval }: { handler: unknown; delay: unknown; interval: boolean }): NodeJS.Timeout {
    this.assertActive()
    if (typeof handler !== 'function' || (delay !== undefined && (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 5_000))) {
      throw new Error('Execute timers require a function and a delay between 0 and 5000 ms')
    }
    const run = () => {
      if (!interval) {
        this.timers.delete(timer)
      }
      if (this.active) {
        handler()
      }
    }
    const timer = interval ? setInterval(run, Number(delay ?? 0)) : setTimeout(run, Number(delay ?? 0))
    this.timers.add(timer)
    return timer
  }

  clear(timer: NodeJS.Timeout): void {
    clearTimeout(timer)
    clearInterval(timer)
    this.timers.delete(timer)
  }

  release(): void {
    this.active = false
    for (const timer of this.timers) {
      clearTimeout(timer)
      clearInterval(timer)
    }
    this.timers.clear()
  }
}

export function startFirefoxExecutorWorker(): void {
  const userState: Record<string, unknown> = {}
  const pending = new Map<string, PendingDom>()
  let activeId: string | null = null
  let nextRpcId = 0
  const requestDom = (options: { id: string; command: BrowserDomCommand }): Promise<BrowserResultData> => {
    if (activeId !== options.id) {
      return Promise.reject(new FirefoxCapabilityError('Firefox execute request has ended'))
    }
    const command = parseBrowserDomCommand(options.command)
    if (!command) {
      return Promise.reject(new FirefoxCapabilityError('The requested Firefox DOM command or options are not supported'))
    }
    nextRpcId += 1
    const rpcId = String(nextRpcId)
    const promise = new Promise<BrowserResultData>((resolve, reject) => {
      pending.set(rpcId, { executionId: options.id, resolve, reject })
      sendMessage({ type: 'dom-request', id: options.id, rpcId, command })
    })
    void promise.catch(() => {})
    return promise
  }
  const execute = async (command: Extract<FirefoxWorkerCommand, { type: 'execute' }>): Promise<void> => {
    if (activeId) {
      throw new Error('Firefox executor received concurrent execute commands')
    }
    activeId = command.id
    const lease = new ExecutionLease()
    const logs: string[] = []
    const images: BrowserImage[] = []
    const artifacts: NonNullable<BrowserResultData['artifacts']> = []
    const send = async (domCommand: BrowserDomCommand): Promise<BrowserResultData> => {
      lease.assertActive()
      const promise = requestDom({ id: command.id, command: domCommand })
      lease.requests.add(promise)
      try {
        const data = await promise
        if (data.images) {
          const bytes = [...images, ...data.images].reduce((size, image) => { return size + image.data.length }, 0)
          if (bytes > 6 * 1024 * 1024) {
            throw new Error('Firefox execute image results exceed the 6 MiB output budget; capture fewer screenshots per request')
          }
          images.push(...data.images)
        }
        if (data.artifacts) {
          artifacts.push(...data.artifacts)
        }
        return data
      } finally {
        lease.requests.delete(promise)
      }
    }
    let response: BrowserResponse
    let started = false
    try {
      const initial = await requestDom({ id: command.id, command: { method: 'invalidate' } })
      const facade = createFirefoxFacade({
        tabId: command.execution.tabId,
        initialUrl: initial.pageInfo?.url ?? command.execution.url,
        deadline: command.execution.deadline,
        send,
        assertActive: () => { lease.assertActive() },
      })
      userState.page = facade.page
      userState.context = facade.context
      const context = vm.createContext({
        ...facade.globals,
        page: facade.page,
        context: facade.context,
        state: userState,
        console: createConsole(logs),
        Buffer, TextDecoder, TextEncoder, URL, URLSearchParams,
        AbortController, AbortSignal, structuredClone, crypto,
        setTimeout: (...args: unknown[]) => { return lease.timer({ handler: args[0], delay: args[1], interval: false }) },
        setInterval: (...args: unknown[]) => { return lease.timer({ handler: args[0], delay: args[1], interval: true }) },
        clearTimeout: (timer: NodeJS.Timeout) => { lease.clear(timer) },
        clearInterval: (timer: NodeJS.Timeout) => { lease.clear(timer) },
        process: Object.freeze({ cwd: () => { return command.execution.cwd }, platform: process.platform, versions: Object.freeze({ node: process.versions.node }) }),
      })
      const script = new vm.Script(wrapExecutionCode(command.execution.code), {
        filename: path.join(command.execution.cwd, '.firefox-executor-eval.js'),
      })
      started = true
      const value: unknown = await script.runInContext(context, {
        timeout: Math.max(1, Math.min(5_000, command.execution.deadline - Date.now())),
        displayErrors: true,
      })
      lease.release()
      await Promise.allSettled([...lease.requests])
      await requestDom({ id: command.id, command: { method: 'invalidate' } })
      response = {
        requestId: command.execution.requestId,
        ok: true,
        data: {
          value: serializeFirefoxValue(value),
          ...(logs.length > 0 ? { logs } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
        },
      }
    } catch (error) {
      lease.release()
      await Promise.allSettled([...lease.requests])
      try {
        await requestDom({ id: command.id, command: { method: 'invalidate' } })
      } catch {
        // The parent invalidates the lease on disconnect/cancellation; no browser action is retried.
      }
      response = executionFailure({ execution: command.execution, error, started, logs })
    } finally {
      lease.release()
      activeId = null
    }
    sendMessage({ type: 'response', id: command.id, response })
  }
  process.on('message', (value: unknown) => {
    try {
      validateFirefoxMessageSize(value)
      const command = parseFirefoxWorkerCommand(value)
      if (!command) {
        throw new Error('Malformed Firefox executor parent command')
      }
      if (command.type === 'dom-response') {
        const waiting = pending.get(command.rpcId)
        if (!waiting || waiting.executionId !== command.id || activeId !== command.id) {
          return
        }
        pending.delete(command.rpcId)
        if (command.response.ok) {
          waiting.resolve(command.response.data)
        } else {
          waiting.reject(new FirefoxDomError(command.response.error))
        }
        return
      }
      void execute(command).catch((error) => {
        process.stderr.write(`Firefox executor failed: ${messageOf(error)}\n`)
        process.exit(1)
      })
    } catch (error) {
      process.stderr.write(`Firefox executor protocol failed: ${messageOf(error)}\n`)
      process.exit(1)
    }
  })
  process.on('disconnect', () => {
    process.exit(0)
  })
  sendMessage({ type: 'ready', protocolVersion: 1 })
}

function createConsole(logs: string[]): Record<string, (...args: unknown[]) => void> {
  const methods: Record<string, (...args: unknown[]) => void> = {}
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table']) {
    methods[method] = (...args: unknown[]) => {
      const line = args.map((arg) => {
        return typeof arg === 'string' ? arg : JSON.stringify(serializeFirefoxValue(arg))
      }).join(' ')
      logs.push(`[${method}] ${truncateString({ value: line, maxLength: 4_000 })}`)
      if (logs.length > 100) {
        logs.shift()
      }
    }
  }
  return methods
}

function serializeFirefoxValue(value: unknown): ReturnType<typeof serializeBrowserJson> {
  try {
    return serializeBrowserJson(structuredClone(value))
  } catch {
    return serializeBrowserJson(value)
  }
}

function executionFailure({ execution, error, started, logs }: {
  execution: FirefoxWorkerExecution
  error: unknown
  started: boolean
  logs: string[]
}): BrowserResponse {
  const vmTimeout = error && typeof error === 'object' && 'code' in error && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
  const code = error instanceof FirefoxDomError ? error.code : error instanceof FirefoxCapabilityError || error instanceof FirefoxSnapshotError ? error.code : vmTimeout ? 'timeout' : 'execution-failed'
  const logText = logs.length > 0 ? `\nExecute console:\n${logs.join('\n')}` : ''
  return {
    requestId: execution.requestId, ok: false,
    error: {
      code,
      message: truncateString({ value: `Firefox page.execute: ${messageOf(error)}${logText}`, maxLength: 20_000 }),
      outcome: started || (error instanceof FirefoxDomError && error.outcome === 'unknown') ? 'unknown' : 'not-started',
    },
  }
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    return error.message
  }
  return String(error)
}

function wrapExecutionCode(code: string): string {
  try {
    const ast = acorn.parse(code, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true })
    const statement = ast.body.length === 1 ? ast.body[0] : undefined
    if (statement?.type === 'ExpressionStatement' && !['AssignmentExpression', 'UpdateExpression', 'SequenceExpression'].includes(statement.expression.type) &&
      !(statement.expression.type === 'UnaryExpression' && statement.expression.operator === 'delete')) {
      return `(async () => { return await (${code.slice(statement.expression.start, statement.expression.end)}) })()`
    }
  } catch {
    // vm.Script reports the original syntax error, including its source location.
  }
  return `(async () => { ${code}\n })()`
}

function sendMessage(message: FirefoxWorkerMessage): void {
  validateFirefoxMessageSize(message)
  if (!process.send || !process.connected) {
    throw new Error('Firefox executor IPC channel is unavailable')
  }
  process.send(message)
}

if (process.send) {
  startFirefoxExecutorWorker()
}
