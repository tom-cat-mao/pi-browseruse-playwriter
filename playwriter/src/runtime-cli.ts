/**
 * Entry point for the `pi-browser-runtime` executable.
 *
 * Config comes from PI_BROWSER_HOST / PI_BROWSER_PORT / PI_BROWSER_TOKEN /
 * PI_BROWSER_DATA_DIR. Defaults to 127.0.0.1:19989 and ~/.pi-browser-use so it
 * can run next to the legacy relay on 19988 without cross-talk.
 */

import * as path from 'node:path'
import { createCdpLogger } from './cdp-log.js'
import { createFileLogger } from './create-logger.js'
import { startPlayWriterCDPRelayServer } from './cdp-relay.js'
import { probeManagedRuntime } from './relay-client.js'
import { isLoopbackHost, resolveBrowserRuntimeConfig, type BrowserRuntimeConfig } from './utils.js'

process.title = 'pi-browser-runtime'

function loadConfig(): BrowserRuntimeConfig {
  try {
    return resolveBrowserRuntimeConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

const config = loadConfig()

// Managed handlers and child processes read the same resolved values.
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
    // Only another fully capable managed runtime counts as "already running".
    const probe = await probeManagedRuntime({ host: config.host, port: config.port, token: config.token })
    if (probe.state === 'ready') {
      await logger.log(`Another managed runtime already owns ${config.host}:${config.port}, not replacing it`)
      await logger.flush()
      process.exit(0)
    }
    const reason =
      probe.state === 'unauthorized'
        ? 'a token-protected listener'
        : probe.state === 'incompatible'
          ? `a runtime missing required capabilities (${probe.missing.join(', ')})`
          : probe.state === 'unsupported'
            ? 'a listener without the managed browser API'
            : 'an unreachable listener'
    await logger.error(`Port ${config.port} is owned by ${reason}; not replacing it`)
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
    await cdpLogger.flush()
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
