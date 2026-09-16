import * as acorn from 'acorn'
import crypto from 'node:crypto'
import fs from 'node:fs'
import url from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import type { BrowserDomCommand, BrowserErrorCode, BrowserImage, BrowserJson, BrowserPageInfo, BrowserResultData, BrowserResponse } from './browser-protocol.js'
import { parseBrowserDomCommand } from './browser-dom-validation.js'
import {
  MAX_FIREFOX_ASSET_COUNT,
  parseFirefoxWorkerCommand,
  validateFirefoxMessageSize,
  type FirefoxAssetFetchRequest,
  type FirefoxAssetFetchResponse,
  type FirefoxAssetTarget,
  type FirefoxWorkerCommand,
  type FirefoxWorkerExecution,
  type FirefoxWorkerExtract,
  type FirefoxWorkerMessage,
} from './firefox-executor-protocol.js'
import { truncateString } from './managed-executor-protocol.js'
import { boundExtractArtifactText, extractPageContent, windowExtractedText, withExtractArtifactText } from './page-extract.js'

interface PendingDom {
  executionId: string
  resolve: (data: BrowserResultData) => void
  reject: (error: Error) => void
}

interface PendingAssetFetch {
  executionId: string
  resolve: (response: FirefoxAssetFetchResponse) => void
  reject: (error: Error) => void
}

/** One image as the page reports it; `src` is already the URL a fetch would use. */
type AssetManifestEntry = {
  src: string
  currentSrc: string
  srcset: string
  alt: string
  naturalWidth: number
  naturalHeight: number
}

interface AssetManifest {
  assets: AssetManifestEntry[]
  /** True when the page held more images than the manifest cap keeps. */
  truncated: boolean
}

type SavedAsset = {
  base64: string
  mimeType: string
  alt?: string
  src: string
}

type FailedAsset = {
  src: string
  reason: string
}

interface AssetOutcomes {
  saved: SavedAsset[]
  failed: FailedAsset[]
}

/** Cap on the manifest itself; only MAX_FIREFOX_ASSET_COUNT images may be fetched. */
const MAX_MANIFEST_ASSETS = 200
const ASSET_SCHEME_REASON = 'unsupported image URL scheme: only http(s) images can be saved'

/**
 * Runs through the existing DOM `evaluate` command, the same page-side path
 * `page.evaluate` uses, so the manifest reports what the page actually shows
 * (currentSrc after srcset selection) rather than only markup.
 */
const ENUMERATE_IMAGES_CODE = `
  return {
    items: Array.from(document.images).map((image) => {
      const currentSrc = typeof image.currentSrc === 'string' ? image.currentSrc : '';
      const src = typeof image.src === 'string' ? image.src : '';
      return {
        src: currentSrc || src,
        currentSrc,
        srcset: image.getAttribute('srcset') || '',
        alt: image.getAttribute('alt') || '',
        naturalWidth: Number.isFinite(image.naturalWidth) ? image.naturalWidth : 0,
        naturalHeight: Number.isFinite(image.naturalHeight) ? image.naturalHeight : 0,
      };
    }),
  };
`

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
  const factory = new vm.Script(`(() => {
    const create = globalThis.__createFirefoxExecutorRealm;
    globalThis.__createFirefoxExecutorRealm = undefined;
    delete globalThis.__createFirefoxExecutorRealm;
    return create;
  })()`).runInContext(context, { timeout: 5_000 }) as (bridge: RealmBridge) => RealmController
  const realm = factory((options) => {
    if (!runBridge) return JSON.stringify({ ok: false, error: { code: 'cancelled', message: 'Firefox execution is inactive' } })
    return runBridge(options)
  })
  process.on('unhandledRejection', (error: unknown) => {
    unhandledError ??= error
  })
  const pending = new Map<string, PendingDom>()
  const pendingAssets = new Map<string, PendingAssetFetch>()
  let activeId: string | null = null
  let nextRpcId = 0
  let nextTimerId = 0
  const requestDom = (options: { id: string; command: BrowserDomCommand }): Promise<BrowserResultData> => {
    if (activeId !== options.id) {
      return Promise.reject(new FirefoxCapabilityError('Firefox executor request has ended'))
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
  /**
   * Asset bytes only exist inside the extension (background fetch with cookies
   * and host permissions), so the worker asks for them over its own IPC channel
   * and waits for an answer bound to the same command lease.
   */
  const requestAssets = (options: { id: string; request: FirefoxAssetFetchRequest }): Promise<FirefoxAssetFetchResponse> => {
    if (activeId !== options.id) {
      return Promise.reject(new FirefoxCapabilityError('Firefox executor request has ended'))
    }
    nextRpcId += 1
    const rpcId = String(nextRpcId)
    const promise = new Promise<FirefoxAssetFetchResponse>((resolve, reject) => {
      pendingAssets.set(rpcId, { executionId: options.id, resolve, reject })
      sendMessage({ type: 'asset-request', id: options.id, rpcId, request: options.request })
    })
    void promise.catch(() => {})
    return promise
  }
  /**
   * A worker serves one command at a time, and every DOM RPC stays bound to
   * that command's lease so a cancelled request can never be answered later.
   */
  const beginCommand = (id: string): {
    lease: ExecutionLease
    send: (command: BrowserDomCommand) => Promise<BrowserResultData>
  } => {
    if (activeId) {
      throw new Error('Firefox executor received concurrent commands')
    }
    activeId = id
    const lease = new ExecutionLease()
    const send = async (domCommand: BrowserDomCommand): Promise<BrowserResultData> => {
      lease.assertActive()
      const promise = requestDom({ id, command: domCommand })
      lease.requests.add(promise)
      try {
        return await promise
      } finally {
        lease.requests.delete(promise)
      }
    }
    return { lease, send }
  }
  const execute = async (command: Extract<FirefoxWorkerCommand, { type: 'execute' }>): Promise<void> => {
    const { lease, send: sendDom } = beginCommand(command.id)
    const logs: string[] = []
    const images: BrowserImage[] = []
    const artifacts: NonNullable<BrowserResultData['artifacts']> = []
    const timerIds = new Map<number, NodeJS.Timeout>()
    unhandledError = undefined
    const send = async (domCommand: BrowserDomCommand): Promise<BrowserResultData> => {
      const data = await sendDom(domCommand)
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
  /**
   * page.extract reads content, never page structure: the extension only
   * serializes the document (or the one strictly matched element) and this
   * worker runs the shared Node pipeline, so both backends extract identically
   * and the relay never blocks on parsing.
   */
  const extract = async (command: Extract<FirefoxWorkerCommand, { type: 'extract' }>): Promise<void> => {
    const { lease, send } = beginCommand(command.id)
    const assets: AssetReader = {
      enumerate: async () => {
        const data = await send({ method: 'evaluate', code: ENUMERATE_IMAGES_CODE })
        return { manifest: readAssetManifest({ value: data.value }), ...(data.pageInfo ? { pageInfo: data.pageInfo } : {}) }
      },
      save: async (input) => {
        lease.assertActive()
        return await saveAssets({
          targets: input.targets,
          plannedFailed: input.failed,
          execution: command.execution,
          fetchOnce: async (request: FirefoxAssetFetchRequest) => {
            return await requestAssets({ id: command.id, request })
          },
        })
      },
    }
    let response: BrowserResponse
    try {
      response = { requestId: command.execution.requestId, ok: true, data: await extractionData({ execution: command.execution, send, assets }) }
    } catch (error) {
      response = extractFailure({ execution: command.execution, error })
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
      if (command.type === 'asset-response') {
        const waiting = pendingAssets.get(command.rpcId)
        if (!waiting || waiting.executionId !== command.id || activeId !== command.id) {
          return
        }
        pendingAssets.delete(command.rpcId)
        waiting.resolve(command.response)
        return
      }
      void (command.type === 'extract' ? extract(command) : execute(command)).catch((error) => {
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

/**
 * Extraction only reads the document, so a failure is reported as not-started
 * unless the DOM transport itself could not tell whether the read happened.
 */
function extractFailure({ execution, error }: { execution: FirefoxWorkerExtract; error: unknown }): BrowserResponse {
  return {
    requestId: execution.requestId, ok: false,
    error: {
      code: readErrorCode(error),
      message: truncateString({ value: `Firefox page.extract: ${messageOf(error)}`, maxLength: 20_000 }),
      outcome: error instanceof FirefoxDomError && error.outcome === 'unknown' ? 'unknown' : 'not-started',
    },
  }
}

/** How extraction reaches page images: a DOM manifest read and, for 'save', extension-fetched bytes. */
interface AssetReader {
  enumerate(): Promise<AssetManifestRead>
  save(input: { targets: FirefoxAssetTarget[]; failed: FailedAsset[] }): Promise<AssetOutcomes>
}

interface AssetManifestRead {
  manifest: AssetManifest
  /** The DOM read reports the tab it came from, like every other Firefox DOM response. */
  pageInfo?: BrowserPageInfo
}

/**
 * Serialized document plus one strictly matched element scope, run through the shared pipeline.
 * Image handling reads the DOM manifest first and only fetches bytes when the caller asked to save them.
 */
async function extractionData({ execution, send, assets }: {
  execution: FirefoxWorkerExtract
  send: (command: BrowserDomCommand) => Promise<BrowserResultData>
  assets: AssetReader
}): Promise<BrowserResultData> {
  const { format, selector, search, offset, limit, images, persist } = execution
  const saving = images === 'save'
  const read = format === 'assets-manifest' || (images !== undefined && images !== 'none') ? await assets.enumerate() : undefined
  const manifest = read?.manifest
  const selected = manifest && saving ? selectAssetTargets({ manifest }) : undefined
  const outcomes = selected ? await assets.save({ targets: selected.targets, failed: selected.failed }) : undefined
  const notFetched = selected?.notFetched ?? 0

  if (format === 'assets-manifest') {
    const listing = manifestListing({ assets: manifest?.assets ?? [] })
    const preview = windowExtractedText({ text: listing, offset, limit })
    return {
      text: preview.text,
      value: withExtractArtifactText({
        value: {
          format,
          count: manifest?.assets.length ?? 0,
          truncated: preview.truncated || (manifest?.truncated ?? false),
          totalBytes: Buffer.byteLength(listing, 'utf8'),
          assets: manifest?.assets ?? [],
          ...assetValue({ outcomes, notFetched }),
        },
        persisted: persist ? boundExtractArtifactText({ text: listing }) : undefined,
      }),
      ...(read?.pageInfo ? { pageInfo: read.pageInfo } : {}),
    }
  }

  const content = await send({ method: 'page', action: 'content', ...(selector ? { selector } : {}) })
  if (typeof content.value !== 'string') {
    throw new Error('Firefox returned no serialized document to extract')
  }
  const html = content.value
  const totalBytes = Buffer.byteLength(html, 'utf8')
  // The read reports the tab it came from; the Chrome worker attaches the same
  // envelope to every result, so a consumer sees one response shape per backend.
  const pageInfo = content.pageInfo
  const manifestValue = { ...(manifest ? { assets: manifest.assets } : {}), ...(manifest?.truncated ? { assetsTruncated: true } : {}) }

  if (format === 'html') {
    const preview = windowExtractedText({ text: html, search, offset, limit })
    return {
      text: preview.text,
      value: withExtractArtifactText({
        value: {
          format,
          truncated: preview.truncated,
          totalBytes,
          ...(pageInfo?.title ? { title: pageInfo.title } : {}),
          ...manifestValue,
          ...assetValue({ outcomes, notFetched }),
        },
        persisted: persist ? boundExtractArtifactText({ text: html }) : undefined,
      }),
      ...(pageInfo ? { pageInfo } : {}),
    }
  }

  const extracted = await extractPageContent({
    html,
    ...(pageInfo?.url ? { url: pageInfo.url } : {}),
    format,
    ...(persist ? { full: true } : { search, offset, limit }),
  })
  // A persisted extraction is complete; the model still gets the window it
  // asked for, and never the whole document inline.
  const preview = persist ? windowExtractedText({ text: extracted.text, search, offset, limit }) : extracted
  return {
    text: preview.text,
    value: withExtractArtifactText({
      value: {
        format,
        truncated: preview.truncated,
        totalBytes: extracted.totalBytes,
        ...(extracted.title ? { title: extracted.title } : {}),
        ...(extracted.metadata ? { metadata: { ...extracted.metadata } } : {}),
        ...manifestValue,
        ...assetValue({ outcomes, notFetched }),
      },
      persisted: persist ? boundExtractArtifactText({ text: extracted.text }) : undefined,
    }),
    ...(pageInfo ? { pageInfo } : {}),
  }
}

/** Asset bytes are only added to the value when the caller asked for them. */
function assetValue({ outcomes, notFetched }: { outcomes?: AssetOutcomes; notFetched: number }): Record<string, BrowserJson> {
  return {
    ...(outcomes && outcomes.saved.length > 0 ? { savedAssets: outcomes.saved.map(savedAssetJson) } : {}),
    ...(outcomes && outcomes.failed.length > 0 ? { failedAssets: outcomes.failed.map(failedAssetJson) } : {}),
    ...(notFetched > 0 ? { assetsNotFetched: notFetched } : {}),
  }
}

function savedAssetJson(asset: SavedAsset): BrowserJson {
  return { base64: asset.base64, mimeType: asset.mimeType, src: asset.src, ...(asset.alt ? { alt: asset.alt } : {}) }
}

function failedAssetJson(asset: FailedAsset): BrowserJson {
  return { src: asset.src, reason: asset.reason }
}

function readAssetManifest({ value }: { value: unknown }): AssetManifest {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : undefined
  if (!items) {
    throw new Error('Firefox returned no image manifest for this page')
  }
  const entries: AssetManifestEntry[] = []
  let truncated = false
  for (const item of items) {
    if (!isRecord(item) || typeof item.src !== 'string' || typeof item.currentSrc !== 'string') {
      continue
    }
    const src = item.src.trim()
    // Inline bytes are page-local, not something the extension can fetch.
    if (!src || src.startsWith('data:')) {
      continue
    }
    if (entries.length === MAX_MANIFEST_ASSETS) {
      truncated = true
      break
    }
    entries.push({
      src,
      currentSrc: item.currentSrc.trim(),
      srcset: typeof item.srcset === 'string' ? item.srcset.trim() : '',
      alt: typeof item.alt === 'string' ? item.alt.trim() : '',
      naturalWidth: naturalDimension(item.naturalWidth),
      naturalHeight: naturalDimension(item.naturalHeight),
    })
  }
  return { assets: entries, truncated }
}

function naturalDimension(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/** One line per image, so the model can read the manifest without the structured value. */
function manifestListing({ assets }: { assets: AssetManifestEntry[] }): string {
  return assets.map((asset, index) => {
    const size = asset.naturalWidth > 0 || asset.naturalHeight > 0 ? ` [${asset.naturalWidth}x${asset.naturalHeight}]` : ''
    const alt = asset.alt ? ` alt: ${asset.alt}` : ''
    return `${index + 1}. ${asset.src}${size}${alt}`
  }).join('\n')
}

/**
 * Only http(s) images can be fetched by the extension background, and only the
 * channel's target bound is attempted; an image that is never attempted is
 * reported rather than silently dropped.
 */
function selectAssetTargets({ manifest }: { manifest: AssetManifest }): { targets: FirefoxAssetTarget[]; failed: FailedAsset[]; notFetched: number } {
  const targets: FirefoxAssetTarget[] = []
  const failed: FailedAsset[] = []
  let notFetched = 0
  for (const asset of manifest.assets) {
    if (!isFetchableAssetUrl(asset.src)) {
      failed.push({ src: asset.src, reason: ASSET_SCHEME_REASON })
      continue
    }
    if (targets.length === MAX_FIREFOX_ASSET_COUNT) {
      notFetched += 1
      continue
    }
    targets.push({ src: asset.src, ...(asset.alt ? { alt: asset.alt } : {}) })
  }
  return { targets, failed, notFetched }
}

function isFetchableAssetUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

/**
 * Bytes come from one bounded channel round trip, and a failed image is data:
 * it never fails the extraction or its sibling images.
 */
async function saveAssets({ targets, plannedFailed, execution, fetchOnce }: {
  targets: FirefoxAssetTarget[]
  /** Images the DOM manifest listed but the channel can never fetch. */
  plannedFailed: FailedAsset[]
  execution: FirefoxWorkerExtract
  fetchOnce: (request: FirefoxAssetFetchRequest) => Promise<FirefoxAssetFetchResponse>
}): Promise<AssetOutcomes> {
  if (targets.length === 0) {
    return { saved: [], failed: [...plannedFailed] }
  }
  const alts = new Map(targets.map((target) => { return [target.src, target.alt] }))
  const failure = (reason: string): AssetOutcomes => {
    return {
      saved: [],
      failed: [...plannedFailed, ...targets.map((target) => { return { src: target.src, reason } })],
    }
  }
  let response: FirefoxAssetFetchResponse
  try {
    response = await fetchOnce({
      requestId: `${execution.requestId}:assets`,
      sessionId: execution.sessionId,
      tabId: execution.tabId,
      browserEpoch: execution.browserEpoch,
      targets,
    })
  } catch (error) {
    return failure(messageOf(error))
  }
  if (response.error) {
    return failure(response.error)
  }
  const outcomes = new Map(response.assets.map((asset) => { return [asset.src, asset] }))
  const saved: SavedAsset[] = []
  const failed: FailedAsset[] = [...plannedFailed]
  for (const target of targets) {
    const asset = outcomes.get(target.src)
    if (!asset) {
      failed.push({ src: target.src, reason: 'the extension returned no result for this image' })
      continue
    }
    if (!asset.ok) {
      failed.push({ src: asset.src, reason: asset.reason })
      continue
    }
    const alt = alts.get(asset.src)
    saved.push({ base64: asset.base64, mimeType: asset.mimeType, src: asset.src, ...(alt ? { alt } : {}) })
  }
  return { saved, failed }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
