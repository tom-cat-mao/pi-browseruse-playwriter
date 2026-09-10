/**
 * Lightweight real HTTP server for acceptance fixtures.
 *
 * It exists so the acceptance run can prove real browser events (fills,
 * clicks, fetch, popups, console logs) without any business backend. Every
 * /api/echo and /api/slow hit increments a per-tag counter, which is how the
 * harness proves "sent exactly once and not replayed after cancel/failure".
 * It only starts when the user passes --fixture-server.
 */

import * as http from 'node:http'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as net from 'node:net'
import { fileURLToPath } from 'node:url'

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

export type FixtureServer = {
  baseUrl: string
  host: string
  port: number
  snapshotCounters: () => Record<string, number>
  close: () => Promise<void>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
}

function json({ response, status, value }: { response: http.ServerResponse; status: number; value: unknown }): void {
  const body = JSON.stringify(value)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

function sleep({ ms }: { ms: number }): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function startFixtureServer({
  host = '127.0.0.1',
  port = 0,
}: {
  host?: string
  port?: number
} = {}): Promise<FixtureServer> {
  const counters = new Map<string, number>()
  const openSockets = new Set<net.Socket>()
  let closed = false

  const bump = ({ tag }: { tag: string }): number => {
    const next = (counters.get(tag) || 0) + 1
    counters.set(tag, next)
    return next
  }

  const serveStatic = ({ pathname, response }: { pathname: string; response: http.ServerResponse }): void => {
    const relative = pathname === '/' ? 'group-page.html' : pathname.replace(/^\/+/, '')
    const filePath = path.resolve(fixturesDir, relative)
    if (!filePath.startsWith(fixturesDir + path.sep)) {
      json({ response, status: 403, value: { error: 'path outside fixtures dir' } })
      return
    }
    const ext = path.extname(filePath)
    const contentType = CONTENT_TYPES[ext]
    if (!contentType) {
      json({ response, status: 404, value: { error: `no fixture route for ${pathname}` } })
      return
    }
    let body: Buffer
    try {
      body = fs.readFileSync(filePath)
    } catch (error) {
      json({ response, status: 404, value: { error: `fixture file missing: ${relative}`, cause: String(error) } })
      return
    }
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
    response.end(body)
  }

  const server = http.createServer((request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`)
        if (url.pathname === '/api/echo') {
          const tag = url.searchParams.get('tag') || 'untagged'
          json({ response, status: 200, value: { tag, count: bump({ tag }), at: Date.now() } })
          return
        }
        if (url.pathname === '/api/slow') {
          const tag = url.searchParams.get('tag') || 'untagged-slow'
          const ms = Math.min(Math.max(Number(url.searchParams.get('ms')) || 1000, 0), 60000)
          await sleep({ ms })
          json({ response, status: 200, value: { tag, count: bump({ tag }), at: Date.now() } })
          return
        }
        if (url.pathname === '/api/counts') {
          json({ response, status: 200, value: Object.fromEntries(counters) })
          return
        }
        serveStatic({ pathname: url.pathname, response })
      } catch (error) {
        console.error('[fixture-server] request failed:', error)
        if (!response.headersSent) {
          json({ response, status: 500, value: { error: error instanceof Error ? error.message : String(error) } })
          return
        }
        response.destroy()
      }
    })()
  })

  server.on('connection', (socket) => {
    openSockets.add(socket)
    socket.on('close', () => {
      openSockets.delete(socket)
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) => {
      reject(new Error(`fixture server failed to listen on ${host}:${port}`, { cause: error }))
    })
    server.listen(port, host, () => {
      resolve()
    })
  })

  const address = server.address()
  if (!address || typeof address === 'string') {
    server.close()
    throw new Error('fixture server did not return a TCP address')
  }

  return {
    baseUrl: `http://${host}:${address.port}`,
    host,
    port: address.port,
    snapshotCounters: () => Object.fromEntries(counters),
    close: async () => {
      if (closed) {
        return
      }
      closed = true
      for (const socket of openSockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(new Error('fixture server failed to close', { cause: error }))
            return
          }
          resolve()
        })
      })
    },
  }
}

export async function readFixtureCounters({ baseUrl }: { baseUrl: string }): Promise<Record<string, number>> {
  const response = await fetch(new URL('/api/counts', baseUrl).toString(), { signal: AbortSignal.timeout(5000) })
  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(`GET /api/counts failed with HTTP ${response.status}: ${bodyText.slice(0, 200)}`)
  }
  return JSON.parse(bodyText) as Record<string, number>
}
