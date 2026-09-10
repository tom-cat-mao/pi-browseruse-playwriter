import { describe, it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as net from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeTestTmpDir, removeTestTmpDir } from './test-tmp.js'
import { VERSION } from './utils.js'

const playwriterDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteNodeBinary = path.join(
  playwriterDir,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vite-node.cmd' : 'vite-node',
)

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

function spawnRuntime({
  port,
  dataDir,
  token,
}: {
  port: number
  dataDir: string
  token?: string
}): ChildProcess {
  return spawn(viteNodeBinary, ['src/runtime-cli.ts'], {
    cwd: playwriterDir,
    env: {
      ...process.env,
      PI_BROWSER_PORT: String(port),
      PI_BROWSER_DATA_DIR: dataDir,
      ...(token ? { PI_BROWSER_TOKEN: token } : {}),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
}

async function waitForVersion({ port, timeoutMs }: { port: number; timeoutMs: number }): Promise<boolean> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(500) })
      if (response.ok) {
        return true
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

describe('pi-browser-runtime entry', () => {
  it('starts on PI_BROWSER_PORT and writes logs into PI_BROWSER_DATA_DIR', async () => {
    const tmpDir = makeTestTmpDir('runtime-cli')
    const port = await getFreePort()
    const child = spawnRuntime({ port, dataDir: tmpDir })

    try {
      expect(await waitForVersion({ port, timeoutMs: 30000 })).toBe(true)
      const versionResponse = (await (await fetch(`http://127.0.0.1:${port}/version`)).json()) as { version: string }
      expect(versionResponse.version).toBe(VERSION)
      expect(fs.existsSync(path.join(tmpDir, 'relay-server.log'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'cdp.jsonl'))).toBe(true)
    } finally {
      child.kill('SIGTERM')
      await once(child, 'exit')
      removeTestTmpDir(tmpDir)
    }
  }, 60000)

  it('rejects unauthenticated privileged requests when a token is configured', async () => {
    const tmpDir = makeTestTmpDir('runtime-cli-token')
    const port = await getFreePort()
    const child = spawnRuntime({ port, dataDir: tmpDir, token: 'test-secret-token' })

    try {
      expect(await waitForVersion({ port, timeoutMs: 30000 })).toBe(true)

      const unauthorized = await fetch(`http://127.0.0.1:${port}/extension/status`)
      expect(unauthorized.status).toBe(401)

      const authorized = await fetch(`http://127.0.0.1:${port}/extension/status`, {
        headers: { authorization: 'Bearer test-secret-token' },
      })
      expect(authorized.status).toBe(200)
    } finally {
      child.kill('SIGTERM')
      await once(child, 'exit')
      removeTestTmpDir(tmpDir)
    }
  }, 60000)

  it('does not report success for an occupied port without the managed API and keeps the owner log intact', async () => {
    const tmpDir = makeTestTmpDir('runtime-cli-occupied')
    const logFile = path.join(tmpDir, 'relay-server.log')
    const marker = 'log-line-from-owner\n'
    fs.writeFileSync(logFile, marker)

    const port = await getFreePort()
    const foreignServer = http.createServer((req, res) => {
      if (req.url === '/version') {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ version: '0.5.0' }))
        return
      }
      res.statusCode = 404
      res.end('not found')
    })
    await new Promise<void>((resolve) => {
      foreignServer.listen(port, '127.0.0.1', resolve)
    })

    const child = spawnRuntime({ port, dataDir: tmpDir })
    try {
      const [exitCode] = await once(child, 'exit')
      expect(exitCode).toBe(1)
      expect(fs.readFileSync(logFile, 'utf-8')).toContain(marker)
    } finally {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        foreignServer.close(() => resolve())
      })
      removeTestTmpDir(tmpDir)
    }
  }, 60000)

  it('a second runtime on the same port does not truncate the running runtime log', async () => {
    const tmpDir = makeTestTmpDir('runtime-cli-race')
    const port = await getFreePort()
    const first = spawnRuntime({ port, dataDir: tmpDir })

    try {
      expect(await waitForVersion({ port, timeoutMs: 30000 })).toBe(true)

      const logFile = path.join(tmpDir, 'relay-server.log')
      const marker = 'log-line-from-first-runtime\n'
      fs.appendFileSync(logFile, marker)

      const second = spawnRuntime({ port, dataDir: tmpDir })
      await once(second, 'exit')

      expect(fs.readFileSync(logFile, 'utf-8')).toContain(marker)
      const stillUp = await fetch(`http://127.0.0.1:${port}/version`, { signal: AbortSignal.timeout(1000) })
      expect(stillUp.ok).toBe(true)
    } finally {
      first.kill('SIGTERM')
      await once(first, 'exit')
      removeTestTmpDir(tmpDir)
    }
  }, 60000)

  it('refuses to bind a non-loopback host without a token', async () => {
    const tmpDir = makeTestTmpDir('runtime-cli-public')
    const port = await getFreePort()
    const publicChild = spawn(viteNodeBinary, ['src/runtime-cli.ts'], {
      cwd: playwriterDir,
      env: {
        ...process.env,
        PI_BROWSER_HOST: '0.0.0.0',
        PI_BROWSER_PORT: String(port),
        PI_BROWSER_TOKEN: '',
        PI_BROWSER_DATA_DIR: tmpDir,
      },
      stdio: 'ignore',
    })

    const [exitCode] = await once(publicChild, 'exit')
    expect(exitCode).toBe(1)

    removeTestTmpDir(tmpDir)
  }, 60000)
})
