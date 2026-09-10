import { describe, it, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { BROWSER_PROTOCOL_VERSION } from './browser-protocol.js'
import { probeManagedRuntime, probeRelayServer } from './relay-client.js'

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Failed to get an ephemeral port'))
        })
        return
      }
      const { port } = address
      server.close(() => {
        resolve(port)
      })
    })
  })
}

async function listenHttp(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test http server')
  }
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error)
            return
          }
          resolve()
        })
      })
    },
  }
}

describe('probeRelayServer', () => {
  it('reports the version of a running relay', async () => {
    const relay = await listenHttp((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ version: '1.2.3' }))
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'running', version: '1.2.3' })

    await relay.close()
  })

  it('reports 401 as unauthorized instead of down', async () => {
    const relay = await listenHttp((req, res) => {
      res.statusCode = 401
      res.end('unauthorized')
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'unauthorized' })

    await relay.close()
  })

  it('reports an http listener without /version as running without a version', async () => {
    const relay = await listenHttp((req, res) => {
      res.statusCode = 500
      res.end('boom')
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'running', version: null })

    await relay.close()
  })

  it('reports down when nothing is listening', async () => {
    const port = await getFreePort()

    expect(await probeRelayServer({ port, timeoutMs: 500 })).toEqual({ state: 'down' })
  })
})

describe('probeManagedRuntime', () => {
  it('parses valid capabilities', async () => {
    const capabilities = {
      protocolVersion: BROWSER_PROTOCOL_VERSION,
      managedGroups: true,
      persistentOwnership: true,
      explicitTabs: true,
      isolatedExecution: true,
    }
    const relay = await listenHttp((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/browser/v1/capabilities') {
        res.end(JSON.stringify(capabilities))
        return
      }
      res.end(JSON.stringify({ version: '9.9.9' }))
    })

    expect(await probeManagedRuntime({ port: relay.port })).toEqual({
      state: 'ready',
      version: '9.9.9',
      capabilities,
    })

    await relay.close()
  })

  it('reports 401 as unauthorized', async () => {
    const relay = await listenHttp((req, res) => {
      res.statusCode = 401
      res.end('unauthorized')
    })

    expect(await probeManagedRuntime({ port: relay.port })).toEqual({ state: 'unauthorized' })

    await relay.close()
  })

  it('reports a relay without managed endpoints as unsupported', async () => {
    const relay = await listenHttp((req, res) => {
      if (req.url === '/version') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ version: '0.5.0' }))
        return
      }
      res.statusCode = 404
      res.end('not found')
    })

    expect(await probeManagedRuntime({ port: relay.port })).toEqual({ state: 'unsupported', version: '0.5.0' })

    await relay.close()
  })

  it('reports down when nothing is listening', async () => {
    const port = await getFreePort()

    expect(await probeManagedRuntime({ port, timeoutMs: 500 })).toEqual({ state: 'down' })
  })
})
