/**
 * Shared utilities for connecting to the relay server.
 * Used by both MCP and CLI.
 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pc from 'picocolors'
import { getListeningPidsForPort, killPortProcess } from './kill-port.js'
import {
  VERSION,
  sleep,
  LOG_FILE_PATH,
  DEFAULT_BROWSER_RUNTIME_PORT,
  resolveBrowserRuntimeConfig,
} from './utils.js'
import { BROWSER_PROTOCOL_VERSION, type BrowserCapabilities } from './browser-protocol.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const RELAY_PORT = Number(process.env.PLAYWRITER_PORT) || 19988

/** Default port of the managed @tom-cat/pi-browser-runtime server. */
export const MANAGED_RUNTIME_PORT = DEFAULT_BROWSER_RUNTIME_PORT

export type ExtensionStatus = {
  extensionId: string
  stableKey?: string
  browser: string | null
  profile: { email: string; id: string } | null
  activeTargets: number
  playwriterVersion: string | null
}

export async function getRelayServerVersion(port: number = RELAY_PORT): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(2000),
    })
    if (!response.ok) {
      return null
    }
    const data = (await response.json()) as { version: string }
    return data.version
  } catch {
    return null
  }
}

export type RelayProbeResult =
  | { state: 'running'; version: string | null }
  | { state: 'unauthorized' }
  | { state: 'down' }

/**
 * Probe a relay port without assuming "no version" means "down".
 * HTTP 401/403 means a relay is up but wants a token, and any other HTTP
 * response means something is listening that is not necessarily a relay.
 * Callers must not kill processes based on this result alone.
 */
export async function probeRelayServer({
  port = RELAY_PORT,
  timeoutMs = 2000,
}: { port?: number; timeoutMs?: number } = {}): Promise<RelayProbeResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.status === 401 || response.status === 403) {
      return { state: 'unauthorized' }
    }
    if (!response.ok) {
      return { state: 'running', version: null }
    }
    const data = (await response.json()) as { version?: unknown }
    return { state: 'running', version: typeof data.version === 'string' ? data.version : null }
  } catch {
    return { state: 'down' }
  }
}

export type ManagedRuntimeProbeResult =
  | { state: 'ready'; version: string | null; capabilities: BrowserCapabilities }
  | { state: 'unsupported'; version: string | null }
  | { state: 'unauthorized' }
  | { state: 'down' }

function parseBrowserCapabilities(value: unknown): BrowserCapabilities | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const isValid =
    record.protocolVersion === BROWSER_PROTOCOL_VERSION &&
    typeof record.managedGroups === 'boolean' &&
    typeof record.persistentOwnership === 'boolean' &&
    typeof record.explicitTabs === 'boolean' &&
    typeof record.isolatedExecution === 'boolean'
  if (!isValid) {
    return null
  }
  return {
    protocolVersion: BROWSER_PROTOCOL_VERSION,
    managedGroups: record.managedGroups as boolean,
    persistentOwnership: record.persistentOwnership as boolean,
    explicitTabs: record.explicitTabs as boolean,
    isolatedExecution: record.isolatedExecution as boolean,
  }
}

/**
 * Probe the managed runtime API on a port. Capability negotiation replaces
 * version comparison: a relay that answers /version but has no managed
 * endpoints is reported as `unsupported` instead of being replaced.
 */
export async function probeManagedRuntime({
  port = MANAGED_RUNTIME_PORT,
  token,
  timeoutMs = 2000,
}: { port?: number; token?: string; timeoutMs?: number } = {}): Promise<ManagedRuntimeProbeResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/browser/v1/capabilities`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    })
    if (response.status === 401 || response.status === 403) {
      return { state: 'unauthorized' }
    }
    if (response.status === 404 || response.status === 405) {
      const relay = await probeRelayServer({ port, timeoutMs })
      return { state: 'unsupported', version: relay.state === 'running' ? relay.version : null }
    }
    if (!response.ok) {
      const relay = await probeRelayServer({ port, timeoutMs })
      return { state: 'unsupported', version: relay.state === 'running' ? relay.version : null }
    }
    const capabilities = parseBrowserCapabilities(await response.json())
    if (!capabilities) {
      return { state: 'unsupported', version: null }
    }
    const relay = await probeRelayServer({ port, timeoutMs })
    return {
      state: 'ready',
      version: relay.state === 'running' ? relay.version : null,
      capabilities,
    }
  } catch {
    return { state: 'down' }
  }
}

/**
 * Poll /version until a relay responds or timeout expires.
 * Used during startup races where a relay may have bound the port
 * but isn't serving HTTP yet (issue #75).
 */
export async function waitForRelayVersion({
  port = RELAY_PORT,
  timeoutMs = 2000,
  intervalMs = 200,
}: {
  port?: number
  timeoutMs?: number
  intervalMs?: number
} = {}): Promise<string | null> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const version = await getRelayServerVersion(port)
    if (version) {
      return version
    }
    await sleep(intervalMs)
  }
  return null
}

export async function getExtensionStatus(
  port: number = RELAY_PORT,
): Promise<{ connected: boolean; activeTargets: number; playwriterVersion: string | null } | null> {
  try {
    const token = process.env.PLAYWRITER_TOKEN
    const response = await fetch(`http://127.0.0.1:${port}/extension/status`, {
      signal: AbortSignal.timeout(500),
      // Without the token a protected relay answers 401, which must not be
      // reported as "extension not connected".
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    })
    if (!response.ok) {
      return null
    }
    return (await response.json()) as { connected: boolean; activeTargets: number; playwriterVersion: string | null }
  } catch {
    return null
  }
}

export async function getExtensionsStatus(port: number = RELAY_PORT): Promise<ExtensionStatus[]> {
  try {
    const token = process.env.PLAYWRITER_TOKEN
    const authHeaders = token ? { authorization: `Bearer ${token}` } : undefined
    const response = await fetch(`http://127.0.0.1:${port}/extensions/status`, {
      signal: AbortSignal.timeout(2000),
      headers: authHeaders,
    })
    if (!response.ok) {
      const fallback = await fetch(`http://127.0.0.1:${port}/extension/status`, {
        signal: AbortSignal.timeout(2000),
        headers: authHeaders,
      })
      if (!fallback.ok) {
        return []
      }

      const fallbackData = (await fallback.json()) as {
        connected: boolean
        activeTargets: number
        browser: string | null
        profile: { email: string; id: string } | null
        playwriterVersion?: string | null
      }

      if (!fallbackData?.connected) {
        return []
      }

      return [
        {
          extensionId: 'default',
          stableKey: undefined,
          browser: fallbackData.browser,
          profile: fallbackData.profile,
          activeTargets: fallbackData.activeTargets,
          playwriterVersion: fallbackData.playwriterVersion || null,
        },
      ]
    }

    const data = (await response.json()) as {
      extensions: ExtensionStatus[]
    }

    return data.extensions || []
  } catch {
    return []
  }
}

/**
 * Wait for at least one extension to appear in extensions status.
 * Returns connected extension entries, or [] on timeout.
 */
export async function waitForConnectedExtensions(
  options: {
    port?: number
    timeoutMs?: number
    pollIntervalMs?: number
    logger?: { log: (...args: any[]) => void }
  } = {},
): Promise<ExtensionStatus[]> {
  const { port = RELAY_PORT, timeoutMs = 5000, pollIntervalMs = 200, logger } = options
  const startTime = Date.now()

  logger?.log(pc.dim('Waiting for extension to connect...'))

  while (Date.now() - startTime < timeoutMs) {
    const extensions = await getExtensionsStatus(port)
    if (extensions.length > 0) {
      logger?.log(pc.green('Extension connected'))
      return extensions
    }
    await sleep(pollIntervalMs)
  }

  logger?.log(pc.yellow('Extension did not connect within timeout'))
  return []
}

async function killRelayServer(options: { port: number; waitForFreeMs?: number }): Promise<void> {
  const { port, waitForFreeMs = 3000 } = options

  try {
    await killPortProcess({ port })
  } catch {
    return
  }

  const startTime = Date.now()
  while (Date.now() - startTime < waitForFreeMs) {
    const pids = await getListeningPidsForPort({ port }).catch(() => [])
    if (pids.length === 0) {
      return
    }
    await sleep(100)
  }
}

/**
 * Compare two semver versions. Returns:
 * - negative if v1 < v2
 * - 0 if v1 === v2
 * - positive if v1 > v2
 */
export function compareVersions(v1: string, v2: string): number {
  const parts1 = v1.split('.').map(Number)
  const parts2 = v2.split('.').map(Number)
  const len = Math.max(parts1.length, parts2.length)

  for (let i = 0; i < len; i++) {
    const p1 = parts1[i] || 0
    const p2 = parts2[i] || 0
    if (p1 !== p2) {
      return p1 - p2
    }
  }
  return 0
}

/**
 * Check if the running playwriter package is older than the version the extension was built with.
 * The extension bundles the playwriter version at build time. If the extension reports a newer
 * version, it means the user's CLI/MCP needs updating.
 * Returns a warning message if outdated, null otherwise.
 */
export function getExtensionOutdatedWarning(extensionPlaywriterVersion: string | null | undefined): string | null {
  if (!extensionPlaywriterVersion) {
    return null
  }
  if (compareVersions(extensionPlaywriterVersion, VERSION) > 0) {
    return `Playwriter ${VERSION} is outdated (extension requires ${extensionPlaywriterVersion}). Run \`npm install -g playwriter@latest\` or update the playwriter package in your project.`
  }
  return null
}

export interface EnsureRelayServerOptions {
  logger?: { log: (...args: any[]) => void }
  /**
   * If true, kill and restart the relay on version mismatch. Default: false.
   * A relay on a shared port may belong to another tool or the user's daily
   * setup, so clients never kill it based on a version string alone. Use the
   * explicit `forceRestart` path (playwriter serve restart) to replace it.
   */
  restartOnVersionMismatch?: boolean
  /** Kill any running relay and start a new one, even if versions match. */
  forceRestart?: boolean
  /** Pass additional environment variables to the relay server process */
  env?: Record<string, string>
}

// Module-level dedup: if ensureRelayServer is called concurrently within the
// same process (e.g. two MCP tool handlers at once), only one spawn runs.
let pendingEnsure: Promise<true | undefined> | null = null

/**
 * Ensures the relay server is running. Starts it if not running.
 * Optionally restarts on version mismatch.
 * Concurrent calls within the same process are deduplicated.
 */
export async function ensureRelayServer(options: EnsureRelayServerOptions = {}): Promise<true | undefined> {
  if (pendingEnsure) {
    return pendingEnsure
  }
  pendingEnsure = ensureRelayServerImpl(options).finally(() => {
    pendingEnsure = null
  })
  return pendingEnsure
}

async function ensureRelayServerImpl(options: EnsureRelayServerOptions = {}): Promise<true | undefined> {
  const { logger, restartOnVersionMismatch = false, env: additionalEnv, forceRestart = false } = options

  if (forceRestart) {
    logger?.log(pc.yellow('Restarting CDP relay server...'))
    await killRelayServer({ port: RELAY_PORT })
  }

  const probe = await probeRelayServer({ port: RELAY_PORT })

  if (!forceRestart && probe.state === 'unauthorized') {
    throw new Error(
      `Relay server on port ${RELAY_PORT} requires a token (HTTP 401). Set PLAYWRITER_TOKEN to the same value, or run \`playwriter serve restart\` yourself to replace it.`,
    )
  }

  if (!forceRestart && probe.state === 'running') {
    if (probe.version === null) {
      throw new Error(
        `Port ${RELAY_PORT} is serving HTTP but has no playwriter /version endpoint. Refusing to stop a process this client does not own.`,
      )
    }
    if (probe.version === VERSION) {
      return
    }
    // Don't restart if server version is higher than our version.
    // This prevents older clients from killing a newer server.
    if (compareVersions(probe.version, VERSION) > 0) {
      return
    }
    if (!restartOnVersionMismatch) {
      logger?.log(
        pc.yellow(
          `Relay v${probe.version} is older than this client v${VERSION}. Using the running relay; run \`playwriter serve restart\` to replace it.`,
        ),
      )
      return
    }
    logger?.log(
      pc.yellow(`CDP relay server version mismatch (server: ${probe.version}, client: ${VERSION}), restarting...`),
    )
    await killRelayServer({ port: RELAY_PORT })
  }

  if (probe.state === 'down') {
    const listeningPids = await getListeningPidsForPort({ port: RELAY_PORT }).catch(() => [])
    if (listeningPids.length > 0) {
      // Something bound the port but /version did not respond yet. It may be a
      // relay that is still starting (race with another CLI/MCP instance), so
      // poll briefly before giving up. Never kill it: it may be a shared
      // process this client does not own (issue #75).
      const foundVersion = await waitForRelayVersion({ port: RELAY_PORT })
      if (foundVersion) {
        if (foundVersion === VERSION || compareVersions(foundVersion, VERSION) > 0) {
          return
        }
        if (!restartOnVersionMismatch) {
          return
        }
        logger?.log(
          pc.yellow(`CDP relay server version mismatch (server: ${foundVersion}, client: ${VERSION}), restarting...`),
        )
        await killRelayServer({ port: RELAY_PORT })
      } else {
        throw new Error(
          `Port ${RELAY_PORT} is in use by a process that is not answering as a playwriter relay (pid(s): ${listeningPids.join(', ')}). Refusing to stop it.`,
        )
      }
    } else {
      logger?.log(pc.dim('CDP relay server not running, starting it...'))
    }
  }

  // Detect if we're running from source (.ts) or compiled (.js)
  // This handles: tsx, vite-node, ts-node, or direct node on compiled output
  const isRunningFromSource = __filename.endsWith('.ts')
  const scriptPath = isRunningFromSource
    ? path.resolve(__dirname, './start-relay-server.ts')
    : path.resolve(__dirname, './start-relay-server.js')

  const serverProcess = spawn(isRunningFromSource ? 'tsx' : process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...additionalEnv },
  })

  serverProcess.unref()

  const startTimeoutMs = 5000
  const startTime = Date.now()

  while (Date.now() - startTime < startTimeoutMs) {
    await sleep(200)
    const newVersion = await getRelayServerVersion(RELAY_PORT)
    if (newVersion) {
      logger?.log(pc.green('CDP relay server started successfully'))
      await sleep(1000)
      return true
    }
  }

  const waitedMs = Date.now() - startTime
  throw new Error(`Failed to start CDP relay server within ${waitedMs}ms. Check logs at: ${LOG_FILE_PATH}`)
}

export type EnsureManagedRuntimeOptions = {
  logger?: { log: (...args: unknown[]) => void }
  port?: number
  host?: string
  token?: string
  dataDir?: string
  /** Extra environment variables merged after the resolved PI_BROWSER_* values. */
  env?: Record<string, string>
  timeoutMs?: number
}

export type EnsureManagedRuntimeResult = {
  started: boolean
  port: number
  version: string | null
  capabilities: BrowserCapabilities
}

/**
 * Resolve how to launch the packaged managed runtime entry point.
 * PI_BROWSER_RUNTIME_PATH wins (absolute path to a runtime-cli file), then the
 * compiled dist entry, then the TypeScript source through tsx for dev worktrees.
 */
function resolveManagedRuntimeEntry(): { command: string; args: string[] } {
  const explicitPath = process.env.PI_BROWSER_RUNTIME_PATH
  if (explicitPath) {
    return { command: process.execPath, args: [explicitPath] }
  }
  const packageRoot = path.resolve(__dirname, '..')
  const compiledEntry = path.join(packageRoot, 'dist', 'runtime-cli.js')
  if (fs.existsSync(compiledEntry)) {
    return { command: process.execPath, args: [compiledEntry] }
  }
  return { command: 'tsx', args: [path.join(packageRoot, 'src', 'runtime-cli.ts')] }
}

let pendingManagedEnsure: Promise<EnsureManagedRuntimeResult> | null = null

/**
 * Ensure the managed @tom-cat/pi-browser-runtime server is running.
 * Capability negotiation replaces version comparison and this never kills a
 * process it does not own: an unknown or token-protected listener on the port
 * is reported as an explicit error instead.
 */
export async function ensureManagedRuntime(
  options: EnsureManagedRuntimeOptions = {},
): Promise<EnsureManagedRuntimeResult> {
  if (pendingManagedEnsure) {
    return pendingManagedEnsure
  }
  pendingManagedEnsure = ensureManagedRuntimeImpl(options).finally(() => {
    pendingManagedEnsure = null
  })
  return pendingManagedEnsure
}

async function ensureManagedRuntimeImpl(
  options: EnsureManagedRuntimeOptions = {},
): Promise<EnsureManagedRuntimeResult> {
  const { logger, port, host, token, dataDir, env: additionalEnv, timeoutMs = 8000 } = options
  const baseConfig = resolveBrowserRuntimeConfig()
  const resolvedPort = port ?? baseConfig.port
  const resolvedHost = host ?? baseConfig.host
  const resolvedToken = token ?? baseConfig.token
  const resolvedDataDir = dataDir ?? baseConfig.dataDir

  const probe = await probeManagedRuntime({ port: resolvedPort, token: resolvedToken })

  if (probe.state === 'ready') {
    return { started: false, port: resolvedPort, version: probe.version, capabilities: probe.capabilities }
  }

  if (probe.state === 'unauthorized') {
    throw new Error(
      `Managed runtime on port ${resolvedPort} rejected the request with HTTP 401. Set the same PI_BROWSER_TOKEN for the client and the runtime; refusing to replace the running process.`,
    )
  }

  if (probe.state === 'unsupported') {
    throw new Error(
      `Port ${resolvedPort} is serving a relay without the managed browser API (${probe.version ? `v${probe.version}` : 'unknown version'}). Refusing to replace it; run \`pi-browser-runtime\` on another port or stop it yourself.`,
    )
  }

  logger?.log(pc.dim(`Managed runtime not running on port ${resolvedPort}, starting it...`))

  const entry = resolveManagedRuntimeEntry()
  const serverProcess = spawn(entry.command, entry.args, {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      PI_BROWSER_HOST: resolvedHost,
      PI_BROWSER_PORT: String(resolvedPort),
      PI_BROWSER_DATA_DIR: resolvedDataDir,
      ...(resolvedToken ? { PI_BROWSER_TOKEN: resolvedToken } : {}),
      ...additionalEnv,
    },
  })
  serverProcess.unref()

  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    await sleep(200)
    const newProbe = await probeManagedRuntime({ port: resolvedPort, token: resolvedToken })
    if (newProbe.state === 'ready') {
      logger?.log(pc.green('Managed runtime started successfully'))
      return { started: true, port: resolvedPort, version: newProbe.version, capabilities: newProbe.capabilities }
    }
    if (newProbe.state === 'unauthorized') {
      throw new Error(
        `Managed runtime on port ${resolvedPort} requires PI_BROWSER_TOKEN that does not match this client. Check the token and the runtime logs at ${path.join(resolvedDataDir, 'relay-server.log')}.`,
      )
    }
  }

  const waitedMs = Date.now() - startTime
  throw new Error(
    `Failed to start managed runtime within ${waitedMs}ms. Check logs at ${path.join(resolvedDataDir, 'relay-server.log')}.`,
  )
}
