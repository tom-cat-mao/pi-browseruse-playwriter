import { Buffer } from 'buffer/index.js'
import { serializeBrowserJson } from './managed-executor-protocol.js'
import { createFirefoxFacade } from './firefox-executor-facade.js'
import type { BrowserDomCommand, BrowserResultData } from './browser-protocol.js'

type Reply = { ok: true; value?: unknown } | { ok: false; error: { code?: string; message: string; outcome?: string } }
type Bridge = (options: { request: string; respond?: (response: string) => void }) => string
interface Metadata { tabId: string; initialUrl: string; deadline: number; cwd: string; platform: string; nodeVersion: string }
interface Lease { active: boolean; timers: Set<number> }
interface RealmController { begin(metadata: string): void; release(): void; serialize(value: unknown): string }

declare global {
  var __createFirefoxExecutorRealm: ((bridge: Bridge) => RealmController) | undefined
}

/** All script-visible objects are constructed by this bundle inside the execution context. */
globalThis.__createFirefoxExecutorRealm = (bridge: Bridge): RealmController => {
  const globals = globalThis as unknown as Record<string, unknown>
  const state: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  let lease: Lease | undefined
  const parseReply = (serialized: string): unknown => {
    const reply = JSON.parse(serialized) as Reply
    if (!reply.ok) {
      const error = new Error(reply.error.message) as Error & { code?: string; outcome?: string }
      error.code = reply.error.code
      error.outcome = reply.error.outcome
      throw error
    }
    return reply.value
  }
  const call = (request: Record<string, unknown>): unknown => {
    return parseReply(bridge({ request: JSON.stringify(request) }))
  }
  const assertActive = (current: Lease): void => {
    if (!current.active) throw Object.assign(new Error('This Firefox execute lease ended; create fresh page and locators'), { code: 'unsupported-capability' })
  }
  const release = (): void => {
    if (!lease) return
    lease.active = false
    for (const id of lease.timers) call({ kind: 'timer.clear', id })
    lease.timers.clear()
  }
  const serialize = (value: unknown): string => {
    const serialized = JSON.stringify(serializeBrowserJson(value))
    if (serialized === undefined) return 'null'
    if (serialized.length > 2_000_000) throw new Error('Firefox execute result exceeds 2 MB; return fewer fields')
    return serialized
  }
  const createTimer = (options: { current: Lease; handler: unknown; delay: unknown; interval: boolean }): number => {
    assertActive(options.current)
    if (typeof options.handler !== 'function') throw new TypeError('Execute timer callbacks must be functions')
    const handler = options.handler
    const delay = options.delay ?? 0
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0 || delay > 5_000) throw new TypeError('Execute timers require a delay between 0 and 5000 ms')
    let id = 0
    id = parseReply(bridge({
      request: JSON.stringify({ kind: 'timer.create', delay, interval: options.interval }),
      respond: () => {
        if (!options.interval) options.current.timers.delete(id)
        if (options.current.active) handler()
      },
    })) as number
    options.current.timers.add(id)
    return id
  }
  const consoleMethods: Record<string, (...args: unknown[]) => void> = {}
  for (const method of ['log', 'info', 'warn', 'error', 'debug', 'dir', 'table']) {
    consoleMethods[method] = (...args: unknown[]): void => {
      const line = args.map((value) => {
        if (typeof value === 'string') return value
        try { return serialize(value) } catch { return '[unserializable]' }
      }).join(' ')
      call({ kind: 'log', line: `[${method}] ${line.slice(0, 4_000)}` })
    }
  }
  class RealmTextEncoder {
    readonly encoding = 'utf-8'
    encode(value = ''): Uint8Array { return Uint8Array.from(Buffer.from(String(value), 'utf8')) }
    encodeInto(source: string, destination: Uint8Array): { read: number; written: number } {
      let read = 0
      let written = 0
      for (const character of String(source)) {
        const bytes = this.encode(character)
        if (written + bytes.length > destination.length) break
        destination.set(bytes, written)
        written += bytes.length
        read += character.length
      }
      return { read, written }
    }
  }
  class RealmTextDecoder {
    readonly encoding: string
    readonly fatal: boolean
    readonly ignoreBOM: boolean
    constructor(...args: [label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }]) {
      const result = call({ kind: 'decoder.info', label: args[0] ?? 'utf-8', options: args[1] ?? {} }) as { encoding: string; fatal: boolean; ignoreBOM: boolean }
      this.encoding = result.encoding
      this.fatal = result.fatal
      this.ignoreBOM = result.ignoreBOM
    }
    decode(...args: [input?: ArrayBuffer | ArrayBufferView, options?: { stream?: boolean }]): string {
      if (args[1]?.stream) throw new Error('Streaming TextDecoder is not supported by Firefox execute')
      const input = args[0]
      const bytes = input === undefined ? new Uint8Array() : ArrayBuffer.isView(input)
        ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input)
      return call({ kind: 'decoder.decode', label: this.encoding, options: { fatal: this.fatal, ignoreBOM: this.ignoreBOM }, bytes: Array.from(bytes) }) as string
    }
  }
  class RealmURLSearchParams {
    private value: string
    private changed?: (value: string) => void
    constructor(input: unknown = '') {
      const normalized = input instanceof RealmURLSearchParams ? input.toString() : input
      this.value = call({ kind: 'params', value: normalized, method: 'toString', args: [] }) as string
    }
    bind(changed: (value: string) => void): void { this.changed = changed }
    private invoke(options: { method: string; args: unknown[] }): unknown {
      const response = call({ kind: 'params', value: this.value, ...options }) as { value: string; result: unknown }
      this.value = response.value
      if (['append', 'delete', 'set', 'sort'].includes(options.method)) this.changed?.(this.value)
      return response.result
    }
    append(...args: [name: string, value: string]): void { this.invoke({ method: 'append', args }) }
    delete(...args: [name: string, value?: string]): void { this.invoke({ method: 'delete', args }) }
    set(...args: [name: string, value: string]): void { this.invoke({ method: 'set', args }) }
    get(name: string): string | null { return this.invoke({ method: 'get', args: [name] }) as string | null }
    getAll(name: string): string[] { return this.invoke({ method: 'getAll', args: [name] }) as string[] }
    has(...args: [name: string, value?: string]): boolean { return this.invoke({ method: 'has', args }) as boolean }
    sort(): void { this.invoke({ method: 'sort', args: [] }) }
    toString(): string { return this.value }
    entries(): IterableIterator<[string, string]> { return (this.invoke({ method: 'entries', args: [] }) as Array<[string, string]>)[Symbol.iterator]() }
    keys(): IterableIterator<string> { return Array.from(this.entries(), (entry) => { return entry[0] })[Symbol.iterator]() }
    values(): IterableIterator<string> { return Array.from(this.entries(), (entry) => { return entry[1] })[Symbol.iterator]() }
    [Symbol.iterator](): IterableIterator<[string, string]> { return this.entries() }
    get size(): number { return Array.from(this.entries()).length }
    forEach(callback: (value: string, key: string, parent: RealmURLSearchParams) => void): void {
      for (const [key, value] of this.entries()) callback(value, key, this)
    }
  }
  class RealmURL {
    private fields: Record<string, string>
    constructor(...args: [input: string, base?: string]) {
      this.fields = call({ kind: 'url', input: String(args[0]), base: args[1] === undefined ? undefined : String(args[1]) }) as Record<string, string>
    }
    private setField(options: { key: string; value: string }): void {
      this.fields = call({ kind: 'url', input: this.fields.href, ...options }) as Record<string, string>
    }
    get href(): string { return this.fields.href }
    set href(value: string) { this.setField({ key: 'href', value: String(value) }) }
    get origin(): string { return this.fields.origin }
    get protocol(): string { return this.fields.protocol }
    set protocol(value: string) { this.setField({ key: 'protocol', value: String(value) }) }
    get host(): string { return this.fields.host }
    set host(value: string) { this.setField({ key: 'host', value: String(value) }) }
    get hostname(): string { return this.fields.hostname }
    set hostname(value: string) { this.setField({ key: 'hostname', value: String(value) }) }
    get port(): string { return this.fields.port }
    set port(value: string) { this.setField({ key: 'port', value: String(value) }) }
    get pathname(): string { return this.fields.pathname }
    set pathname(value: string) { this.setField({ key: 'pathname', value: String(value) }) }
    get search(): string { return this.fields.search }
    set search(value: string) { this.setField({ key: 'search', value: String(value) }) }
    get hash(): string { return this.fields.hash }
    set hash(value: string) { this.setField({ key: 'hash', value: String(value) }) }
    get username(): string { return this.fields.username }
    set username(value: string) { this.setField({ key: 'username', value: String(value) }) }
    get password(): string { return this.fields.password }
    set password(value: string) { this.setField({ key: 'password', value: String(value) }) }
    get searchParams(): RealmURLSearchParams {
      const params = new RealmURLSearchParams(this.fields.search)
      params.bind((value) => { this.search = value })
      return params
    }
    toString(): string { return this.href }
    toJSON(): string { return this.href }
  }
  return {
    begin: (serialized: string): void => {
      release()
      const metadata = JSON.parse(serialized) as Metadata
      const current: Lease = { active: true, timers: new Set<number>() }
      lease = current
      const send = (command: BrowserDomCommand): Promise<BrowserResultData> => {
        assertActive(current)
        return new Promise<BrowserResultData>((resolve, reject) => {
          bridge({ request: JSON.stringify({ kind: 'dom', command }), respond: (serializedReply) => {
            try { resolve(parseReply(serializedReply) as BrowserResultData) } catch (error) { reject(error) }
          } })
        })
      }
      const facade = createFirefoxFacade({ ...metadata, send, assertActive: () => { assertActive(current) } })
      state.page = facade.page
      state.context = facade.context
      Object.assign(globals, facade.globals, {
        page: facade.page, context: facade.context, state, console: consoleMethods,
        Buffer, TextEncoder: RealmTextEncoder, TextDecoder: RealmTextDecoder, URL: RealmURL, URLSearchParams: RealmURLSearchParams,
        atob: (value: string) => { return Buffer.from(String(value), 'base64').toString('latin1') },
        btoa: (value: string) => { return Buffer.from(String(value), 'latin1').toString('base64') },
        crypto: Object.freeze({ randomUUID: () => { return call({ kind: 'uuid' }) as string } }),
        setTimeout: (...args: unknown[]) => { return createTimer({ current, handler: args[0], delay: args[1], interval: false }) },
        setInterval: (...args: unknown[]) => { return createTimer({ current, handler: args[0], delay: args[1], interval: true }) },
        clearTimeout: (id: number) => { current.timers.delete(id); call({ kind: 'timer.clear', id }) },
        clearInterval: (id: number) => { current.timers.delete(id); call({ kind: 'timer.clear', id }) },
        process: Object.freeze({ cwd: () => { return metadata.cwd }, platform: metadata.platform, versions: Object.freeze({ node: metadata.nodeVersion }) }),
      })
    },
    release,
    serialize,
  }
}
