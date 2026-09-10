import { describe, it, expect } from 'vitest'
import * as http from 'node:http'
import * as net from 'node:net'
import { BROWSER_PROTOCOL_VERSION, type BrowserCapabilities } from './browser-protocol.js'
import { ensureManagedRuntime, probeManagedRuntime, probeRelayServer } from './relay-client.js'

const validCapabilities: BrowserCapabilities = {
  protocolVersion: BROWSER_PROTOCOL_VERSION,
  managedGroups: true,
  persistentOwnership: true,
  explicitTabs: true,
  isolatedExecution: true,
}

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

type TestHttpServer = {
  port: number
  requests: string[]
  close: () => Promise<void>
}

async function listenHttp(handler: http.RequestListener): Promise<TestHttpServer> {
  const requests: string[] = []
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? '')
    handler(req, res)
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test http server')
  }
  return {
    port: address.port,
    requests,
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

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

describe('probeRelayServer', () => {
  it('reports a valid /version response as ready', async () => {
    const relay = await listenHttp((req, res) => {
      sendJson(res, 200, { version: '1.2.3' })
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'ready', version: '1.2.3' })

    await relay.close()
  })

  it('reports 401 as unauthorized', async () => {
    const relay = await listenHttp((req, res) => {
      res.statusCode = 401
      res.end('unauthorized')
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'unauthorized' })

    await relay.close()
  })

  it('reports non-2xx responses as occupied, not as a running relay', async () => {
    const relay = await listenHttp((req, res) => {
      res.statusCode = 500
      res.end('boom')
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'occupied' })

    await relay.close()
  })

  it('reports invalid JSON as occupied', async () => {
    const relay = await listenHttp((req, res) => {
      res.statusCode = 200
      res.end('<html>not json</html>')
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'occupied' })

    await relay.close()
  })

  it('reports json without a version as occupied', async () => {
    const relay = await listenHttp((req, res) => {
      sendJson(res, 200, { ok: true })
    })

    expect(await probeRelayServer({ port: relay.port })).toEqual({ state: 'occupied' })

    await relay.close()
  })

  it('reports a closed port as unreachable', async () => {
    const port = await getFreePort()

    expect(await probeRelayServer({ port, timeoutMs: 500 })).toEqual({ state: 'unreachable' })
  })

  it('probes the requested host instead of a hardcoded loopback address', async () => {
    const relay = await listenHttp((req, res) => {
      sendJson(res, 200, { version: '1.0.0' })
    })

    // Bound to 127.0.0.1; probing another loopback address must not see it.
    expect(await probeRelayServer({ host: '127.0.0.2', port: relay.port, timeoutMs: 500 })).toEqual({
      state: 'unreachable',
    })
    expect(await probeRelayServer({ host: '127.0.0.1', port: relay.port })).toEqual({
      state: 'ready',
      version: '1.0.0',
    })

    await relay.close()
  })
})

describe('probeManagedRuntime', () => {
  it('is ready only when capabilities validate', async () => {
    const relay = await listenHttp((req, res) => {
      if (req.url === '/browser/v1/capabilities') {
        sendJson(res, 200, validCapabilities)
        return
      }
      sendJson(res, 200, { version: '9.9.9' })
    })

    expect(await probeManagedRuntime({ port: relay.port })).toEqual({
      state: 'ready',
      version: '9.9.9',
      capabilities: validCapabilities,
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

  it('reports a legacy relay without managed endpoints as unsupported', async () => {
    const relay = await listenHttp((req, res) => {
      if (req.url === '/version') {
        sendJson(res, 200, { version: '0.5.0' })
        return
      }
      res.statusCode = 404
      res.end('not found')
    })

    expect(await probeManagedRuntime({ port: relay.port })).toEqual({ state: 'unsupported', version: '0.5.0' })

    await relay.close()
  })

  it('reports invalid capabilities as unsupported', async () => {
    const relay = await listenHttp((req, res) => {
      sendJson(res, 200, { protocolVersion: BROWSER_PROTOCOL_VERSION })
    })

    expect(await probeManagedRuntime({ port: relay.port })).toEqual({ state: 'unsupported', version: null })

    await relay.close()
  })

  it('reports a closed port as unreachable', async () => {
    const port = await getFreePort()

    expect(await probeManagedRuntime({ port, timeoutMs: 500 })).toEqual({ state: 'unreachable' })
  })

  it('sends the bearer token and reports a mismatch as unauthorized', async () => {
    const relay = await listenHttp((req, res) => {
      if (req.headers.authorization !== 'Bearer secret') {
        res.statusCode = 401
        res.end('unauthorized')
        return
      }
      if (req.url === '/browser/v1/capabilities') {
        sendJson(res, 200, validCapabilities)
        return
      }
      sendJson(res, 200, { version: '1.0.0' })
    })

    expect(await probeManagedRuntime({ port: relay.port, token: 'wrong' })).toEqual({ state: 'unauthorized' })
    expect(await probeManagedRuntime({ port: relay.port, token: 'secret' })).toMatchObject({ state: 'ready' })

    await relay.close()
  })
})

describe('ensureManagedRuntime', () => {
  it('deduplicates in-flight probes for the same endpoint', async () => {
    const relay = await listenHttp((req, res) => {
      if (req.url === '/browser/v1/capabilities') {
        sendJson(res, 200, validCapabilities)
        return
      }
      sendJson(res, 200, { version: '1.0.0' })
    })

    const [first, second] = await Promise.all([
      ensureManagedRuntime({ host: '127.0.0.1', port: relay.port }),
      ensureManagedRuntime({ host: '127.0.0.1', port: relay.port }),
    ])

    expect(first.started).toBe(false)
    expect(second.started).toBe(false)
    expect(relay.requests.filter((url) => url === '/browser/v1/capabilities')).toHaveLength(1)

    await relay.close()
  })

  it('does not share in-flight probes across different tokens', async () => {
    const relay = await listenHttp((req, res) => {
      if (req.url === '/browser/v1/capabilities') {
        sendJson(res, 200, validCapabilities)
        return
      }
      sendJson(res, 200, { version: '1.0.0' })
    })

    await Promise.all([
      ensureManagedRuntime({ host: '127.0.0.1', port: relay.port, token: 'token-a' }),
      ensureManagedRuntime({ host: '127.0.0.1', port: relay.port, token: 'token-b' }),
    ])

    expect(relay.requests.filter((url) => url === '/browser/v1/capabilities')).toHaveLength(2)

    await relay.close()
  })

  it('refuses to start a process for a non-loopback host', async () => {
    await expect(
      ensureManagedRuntime({ host: '192.0.2.1', port: 19989 }),
    ).rejects.toThrow(/non-loopback/)
  }, 30000)
})
