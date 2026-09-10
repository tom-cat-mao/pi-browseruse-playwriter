import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Playwriter extension IDs - used for validation and Chrome flag commands
export const EXTENSION_IDS = [
  'jfeammnjpkecdekppnclgkkffahnhfhe', // Production (Chrome Web Store)
  'pebbngnfojnignonigcnkdilknapkgid', // Dev extension (stable ID from manifest key)
]

// Fork dev extension identity, built with PLAYWRITER_FORK_DEV_KEY=1 from the
// public key in extension/vite.config.mts. Keeping it separate from the legacy
// dev ID lets the fork be installed side by side with upstream and stops the
// two dev builds from answering for each other.
export const FORK_EXTENSION_IDS = [
  'eeklahpecooapnailfaebkjjembkjhhg', // Fork dev extension (stable ID from fork manifest key)
]

// Legacy IDs stay accepted so a browser with the upstream extension can still
// talk to this runtime, but only these exact origins are allowed.
export const ALLOWED_EXTENSION_IDS = [...EXTENSION_IDS, ...FORK_EXTENSION_IDS]

export const DEFAULT_BROWSER_RUNTIME_PORT = 19989
export const DEFAULT_BROWSER_DATA_DIR = path.join(os.homedir(), '.pi-browser-use')

export type BrowserRuntimeConfig = {
  host: string
  port: number
  token?: string
  dataDir: string
  logFilePath: string
  cdpLogFilePath: string
}

function resolvePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || Math.floor(parsed) !== parsed) {
    return fallback
  }
  return parsed
}

/**
 * Resolve the managed runtime startup config from PI_BROWSER_* env vars.
 * The managed runtime never shares the legacy 19988 port or ~/.playwriter
 * data dir, so both can run side by side without cross-talk.
 */
export function resolveBrowserRuntimeConfig({
  env = process.env,
}: { env?: Record<string, string | undefined> } = {}): BrowserRuntimeConfig {
  const dataDir = env.PI_BROWSER_DATA_DIR || DEFAULT_BROWSER_DATA_DIR
  const token = env.PI_BROWSER_TOKEN || undefined
  return {
    host: env.PI_BROWSER_HOST || '127.0.0.1',
    port: resolvePositiveInt(env.PI_BROWSER_PORT, DEFAULT_BROWSER_RUNTIME_PORT),
    token,
    dataDir,
    logFilePath: env.PI_BROWSER_LOG_FILE_PATH || path.join(dataDir, 'relay-server.log'),
    cdpLogFilePath: env.PI_BROWSER_CDP_LOG_FILE_PATH || path.join(dataDir, 'cdp.jsonl'),
  }
}

/**
 * Parse a relay host string into HTTP and WebSocket base URLs.
 * Supports both plain hostnames (appends port) and full URLs (uses as-is).
 *
 * Examples:
 *   "192.168.1.10"                        → http://192.168.1.10:19988, ws://192.168.1.10:19988
 *   "https://my-machine-tunnel.traforo.dev" → https://my-machine-tunnel.traforo.dev, wss://my-machine-tunnel.traforo.dev
 */
export function parseRelayHost(host: string, port: number = 19988): { httpBaseUrl: string; wsBaseUrl: string } {
  if (host.startsWith('https://') || host.startsWith('http://')) {
    const url = new URL(host)
    const httpBaseUrl = url.origin
    const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsBaseUrl = `${wsProtocol}//${url.host}`
    return { httpBaseUrl, wsBaseUrl }
  }
  return {
    httpBaseUrl: `http://${host}:${port}`,
    wsBaseUrl: `ws://${host}:${port}`,
  }
}

export function getCdpUrl({
  port = 19988,
  host = '127.0.0.1',
  token,
  extensionId,
}: {
  port?: number
  host?: string
  token?: string
  extensionId?: string | null
} = {}) {
  const id = `${Math.random().toString(36).substring(2, 15)}_${Date.now()}`
  const params = new URLSearchParams()
  if (token) {
    params.set('token', token)
  }
  if (extensionId) {
    params.set('extensionId', extensionId)
  }
  const queryString = params.toString()
  const suffix = queryString ? `?${queryString}` : ''
  const { wsBaseUrl } = parseRelayHost(host, port)
  return `${wsBaseUrl}/cdp/${id}${suffix}`
}

export function shouldAutoEnablePlaywriter(): boolean {
  return process.env.PLAYWRITER_AUTO_ENABLE?.toLowerCase() !== 'false'
}

// Use ~/.playwriter for logs so each OS user gets their own dir (avoids permission errors on shared machines, see #44)
const LOG_BASE_DIR = path.join(os.homedir(), '.playwriter')
export const LOG_FILE_PATH = process.env.PLAYWRITER_LOG_FILE_PATH || path.join(LOG_BASE_DIR, 'relay-server.log')
export const LOG_CDP_FILE_PATH =
  process.env.PLAYWRITER_CDP_LOG_FILE_PATH || path.join(path.dirname(LOG_FILE_PATH), 'cdp.jsonl')

const packageJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
export const VERSION = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')).version as string

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
