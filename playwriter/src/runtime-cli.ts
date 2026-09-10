/**
 * Entry point for the `pi-browser-runtime` executable.
 *
 * This is the managed runtime Pi tools talk to: its own port (default 19989),
 * its own data directory (default ~/.pi-browser-use) and its own logs, so it
 * can run next to the legacy playwriter relay on 19988 without either process
 * restarting or hijacking the other. All options come from PI_BROWSER_* env:
 *
 *   PI_BROWSER_HOST      bind/connect host, default 127.0.0.1
 *   PI_BROWSER_PORT      port, default 19989
 *   PI_BROWSER_TOKEN     optional shared token, required for non-loopback binds
 *   PI_BROWSER_DATA_DIR  data directory, default ~/.pi-browser-use
 *   PI_BROWSER_LOG_FILE_PATH / PI_BROWSER_CDP_LOG_FILE_PATH  log overrides
 */

import path from 'node:path'
import { createCdpLogger } from './cdp-log.js'
import { createFileLogger } from './create-logger.js'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { resolveBrowserRuntimeConfig } from './utils.js'
import { probeRelayServer } from './relay-client.js'

process.title = 'pi-browser-runtime'

const config = resolveBrowserRuntimeConfig()

// Export the resolved config so managed request handlers and any child
// processes observe the same values the server was started with.
process.env.PI_BROWSER_HOST = config.host
process.env.PI_BROWSER_PORT = String(config.port)
process.env.PI_BROWSER_DATA_DIR = config.dataDir
if (config.token) {
  process.env.PI_BROWSER_TOKEN = config.token
}

const logger = createFileLogger({ logFilePath: config.logFilePath })
const cdpLogger = createCdpLogger({ logFilePath: config.cdpLogFilePath })

process.on('uncaughtException', async (error) => {
  await logger.error('Uncaught Exception:', error)
  await logger.flush()
  process.exit(1)
})

process.on('unhandledRejection', async (reason) => {
  await logger.error('Unhandled Rejection:', reason)
  await logger.flush()
  process.exit(1)
})

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}

export async function startRuntimeServer() {
  if (!isLoopbackHost(config.host) && !config.token) {
    console.error(`Refusing to bind ${config.host} without PI_BROWSER_TOKEN.`)
    process.exit(1)
  }

  let server
  try {
    server = await startPlayWriterCDPRelayServer({
      port: config.port,
      host: config.host,
      token: config.token,
      logger,
      cdpLogger,
    })
  } catch (error: unknown) {
    const errWithCode = error as NodeJS.ErrnoException
    if (errWithCode?.code !== 'EADDRINUSE') {
      throw error
    }
    const probe = await probeRelayServer({ port: config.port })
    if (probe.state === 'running') {
      await logger.log(
        `Another relay (v${probe.version ?? 'unknown'}) already owns port ${config.port}, not replacing it`,
      )
      await logger.flush()
      process.exit(0)
    }
    if (probe.state === 'unauthorized') {
      await logger.error(
        `Port ${config.port} is owned by a token-protected relay this process cannot authenticate against; not replacing it`,
      )
      await logger.flush()
      process.exit(1)
    }
    await logger.error(`Port ${config.port} is in use by a non-relay process; not replacing it`)
    await logger.flush()
    process.exit(1)
  }

  console.log(`pi-browser-runtime listening on ${config.host}:${config.port}`)
  console.log('Logs are being written to:', logger.logFilePath)
  console.log('CDP logs are being written to:', cdpLogger.logFilePath)
  console.log('Data directory:', path.resolve(config.dataDir))

  const shutdown = async () => {
    server.close()
    await logger.flush()
    cdpLogger.flush()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return server
}

startRuntimeServer().catch(async (error) => {
  await logger.error('Failed to start pi-browser-runtime:', error)
  await logger.flush()
  process.exit(1)
})
