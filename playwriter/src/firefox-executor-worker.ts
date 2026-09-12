import * as acorn from 'acorn'
import crypto from 'node:crypto'
import fs from 'node:fs'
import url from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import type { BrowserDomCommand, BrowserErrorCode, BrowserImage, BrowserResultData, BrowserResponse } from './browser-protocol.js'
import { parseBrowserDomCommand } from './browser-dom-validation.js'
import {
  parseFirefoxWorkerCommand,
  validateFirefoxMessageSize,
  type FirefoxWorkerCommand,
  type FirefoxWorkerExecution,
  type FirefoxWorkerMessage,
} from './firefox-executor-protocol.js'
import { truncateString } from './managed-executor-protocol.js'

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

class FirefoxCapabilityError extends Error {
  readonly code = 'unsupported-capability'
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
  interface RealmController { begin(metadata: string): void; release(): void; serialize(value: unknown): string }
  type RealmBridge = (options: { request: string; respond?: (response: string) => void }) => string
  let runBridge: RealmBridge | null = null
  let unhandledError: unknown
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } })
  const realmFile = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '../dist/firefox-executor-realm-bundle.js')
  new vm.Script(fs.readFileSync(realmFile, 'utf8'), { filename: realmFile }).runInContext(context, { timeout: 5_000 })
  const factory = context.__createFirefoxExecutorRealm as (bridge: RealmBridge) => RealmController
  delete context.__createFirefoxExecutorRealm
  const realm = factory((options) => {
    if (!runBridge) return JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'Firefox execution is inactive' } })
    return runBridge(options)
  })
  process.on('unhandledRejection', (error: unknown) => {
    unhandledError ??= error
  })
  const pending = new Map<string, PendingDom>()
  let activeId: string | null = null
  let nextRpcId = 0
  let nextTimerId = 0
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
    const timerIds = new Map<number, NodeJS.Timeout>()
    unhandledError = undefined
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
      runBridge = (options): string => {
        const ok = (value?: unknown): string => { return JSON.stringify({ ok: true, value }) }
        const failed = (error: unknown): string => {
          return JSON.stringify({ ok: false, error: { code: readErrorCode(error), message: messageOf(error), outcome: started ? 'unknown' : 'not-started' } })
        }
        try {
          if (!options || typeof options.request !== 'string' || options.request.length > 8 * 1024 * 1024) throw new Error('Invalid Firefox realm message')
          const request: unknown = JSON.parse(options.request)
          if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Firefox realm request')
          const record = request as Record<string, unknown>
          if (record.kind === 'dom') {
            lease.assertActive()
            const domCommand = parseBrowserDomCommand(record.command)
            const respond = options.respond
            if (!domCommand || typeof respond !== 'function') throw new Error('Invalid Firefox realm DOM request')
            void send(domCommand).then((data) => {
              respond(ok(data))
            }, (error: unknown) => {
              respond(failed(error))
            }).catch((error: unknown) => { unhandledError ??= error })
            return ok()
          }
          if (record.kind === 'log') {
            if (typeof record.line !== 'string') throw new Error('Invalid Firefox console message')
            logs.push(record.line.slice(0, 4_000))
            if (logs.length > 100) logs.shift()
            return ok()
          }
          if (record.kind === 'timer.create') {
            const respond = options.respond
            if (typeof respond !== 'function') throw new Error('Invalid Firefox timer callback')
            nextTimerId += 1
            const id = nextTimerId
            const timer = lease.timer({
              handler: () => {
                if (!record.interval) timerIds.delete(id)
                try { respond('{}') } catch (error) { unhandledError ??= error }
              },
              delay: record.delay,
              interval: record.interval === true,
            })
            timerIds.set(id, timer)
            return ok(id)
          }
          if (record.kind === 'timer.clear') {
            if (typeof record.id === 'number') {
              const timer = timerIds.get(record.id)
              if (timer) lease.clear(timer)
              timerIds.delete(record.id)
            }
            return ok()
          }
          return ok(realmUtility(record))
        } catch (error) {
          const response = failed(error)
          if (typeof options?.respond === 'function') {
            try { options.respond(response) } catch (callbackError) { unhandledError ??= callbackError }
          }
          return response
        }
      }
      realm.begin(JSON.stringify({
        tabId: command.execution.tabId,
        initialUrl: initial.pageInfo?.url ?? command.execution.url,
        deadline: command.execution.deadline,
        cwd: command.execution.cwd,
        platform: process.platform,
        nodeVersion: process.versions.node,
      }))
      const script = new vm.Script(wrapExecutionCode(command.execution.code), {
        filename: path.join(command.execution.cwd, '.firefox-executor-eval.js'),
      })
      started = true
      const value: unknown = await script.runInContext(context, {
        timeout: Math.max(1, Math.min(5_000, command.execution.deadline - Date.now())),
        displayErrors: true,
      })
      realm.release()
      lease.release()
      await Promise.allSettled([...lease.requests])
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      if (unhandledError) throw unhandledError
      await requestDom({ id: command.id, command: { method: 'invalidate' } })
      response = {
        requestId: command.execution.requestId,
        ok: true,
        data: {
          value: JSON.parse(realm.serialize(value)) as BrowserResultData['value'],
          ...(logs.length > 0 ? { logs } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...(artifacts.length > 0 ? { artifacts } : {}),
        },
      }
    } catch (error) {
      realm.release()
      lease.release()
      await Promise.allSettled([...lease.requests])
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      try {
        await requestDom({ id: command.id, command: { method: 'invalidate' } })
      } catch {
        // The parent invalidates the lease on disconnect/cancellation; no browser action is retried.
      }
      response = executionFailure({ execution: command.execution, error, started, logs })
    } finally {
      realm.release()
      lease.release()
      runBridge = null
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

function realmUtility(record: Record<string, unknown>): unknown {
  if (record.kind === 'uuid') return crypto.randomUUID()
  if (record.kind === 'decoder.info' || record.kind === 'decoder.decode') {
    if (typeof record.label !== 'string') throw new Error('Decoder label must be a string')
    const options = record.options && typeof record.options === 'object' ? record.options as { fatal?: boolean; ignoreBOM?: boolean } : {}
    const decoder = new TextDecoder(record.label, options)
    if (record.kind === 'decoder.info') return { encoding: decoder.encoding, fatal: decoder.fatal, ignoreBOM: decoder.ignoreBOM }
    if (!Array.isArray(record.bytes) || record.bytes.length > 1_000_000 || !record.bytes.every((value) => { return Number.isInteger(value) && value >= 0 && value <= 255 })) throw new Error('Decoder input must be bounded bytes')
    return decoder.decode(Uint8Array.from(record.bytes as number[]))
  }
  if (record.kind === 'url') {
    if (typeof record.input !== 'string' || (record.base !== undefined && typeof record.base !== 'string')) throw new Error('URL input must be a string')
    const parsed = new URL(record.input, record.base as string | undefined)
    const keys = ['href', 'origin', 'protocol', 'host', 'hostname', 'port', 'pathname', 'search', 'hash', 'username', 'password']
    if (record.key !== undefined) {
      if (typeof record.key !== 'string' || record.key === 'origin' || !keys.includes(record.key) || typeof record.value !== 'string') throw new Error('Invalid URL field')
      ;(parsed as unknown as Record<string, string>)[record.key] = record.value
    }
    return Object.fromEntries(keys.map((key) => { return [key, (parsed as unknown as Record<string, string>)[key]] }))
  }
  if (record.kind === 'params') {
    if (typeof record.value !== 'string' && (!record.value || typeof record.value !== 'object')) throw new Error('Invalid URLSearchParams input')
    const params = new URLSearchParams(record.value as string | Record<string, string> | Array<[string, string]>)
    const args = Array.isArray(record.args) ? record.args.map((value) => { return String(value) }) : []
    let result: unknown
    switch (record.method) {
      case 'toString': return params.toString()
      case 'append': params.append(args[0], args[1]); break
      case 'delete': params.delete(args[0], args[1]); break
      case 'set': params.set(args[0], args[1]); break
      case 'get': result = params.get(args[0]); break
      case 'getAll': result = params.getAll(args[0]); break
      case 'has': result = params.has(args[0], args[1]); break
      case 'sort': params.sort(); break
      case 'entries': result = Array.from(params.entries()); break
      default: throw new Error('Unsupported URLSearchParams operation')
    }
    return { value: params.toString(), result: result ?? null }
  }
  throw new Error('Unsupported Firefox realm utility')
}

function readErrorCode(error: unknown): BrowserErrorCode {
  if (error && typeof error === 'object' && 'code' in error) {
    if (error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return 'timeout'
    const codes: BrowserErrorCode[] = ['invalid-request', 'unsupported-capability', 'profile-disconnected', 'resource-not-found', 'ownership-mismatch', 'resource-released', 'needs-rebind', 'stale-snapshot', 'execution-failed', 'cancelled', 'timeout', 'outcome-unknown', 'internal-error']
    if (typeof error.code === 'string' && codes.includes(error.code as BrowserErrorCode)) return error.code as BrowserErrorCode
  }
  return 'execution-failed'
}

function executionFailure({ execution, error, started, logs }: {
  execution: FirefoxWorkerExecution
  error: unknown
  started: boolean
  logs: string[]
}): BrowserResponse {
  const code = readErrorCode(error)
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
