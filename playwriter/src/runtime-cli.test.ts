import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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

async function waitForVersion({
  port,
  timeoutMs,
}: {
  port: number
  timeoutMs: number
}): Promise<{ version: string } | null> {
  const startTime = Date.now()
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) {
        return (await response.json()) as { version: string }
      }
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return null
}

describe('pi-browser-runtime entry', () => {
  it('starts on PI_BROWSER_PORT and writes logs into PI_BROWSER_DATA_DIR', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cli-test-'))
    const port = await getFreePort()
    let stderr = ''
    const child = spawn(viteNodeBinary, ['src/runtime-cli.ts'], {
      cwd: playwriterDir,
      env: {
        ...process.env,
        PI_BROWSER_PORT: String(port),
        PI_BROWSER_DATA_DIR: tmpDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    try {
      const versionResponse = await waitForVersion({ port, timeoutMs: 30000 })
      if (!versionResponse) {
        throw new Error(`pi-browser-runtime did not start on port ${port}. stderr:\n${stderr}`)
      }
      expect(versionResponse.version).toBe(VERSION)
      expect(fs.existsSync(path.join(tmpDir, 'relay-server.log'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'cdp.jsonl'))).toBe(true)
    } finally {
      child.kill('SIGTERM')
      await once(child, 'exit')
      fs.rmSync(tmpDir, { recursive: true })
    }
  }, 60000)

  it('refuses to bind a non-loopback host without a token', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-cli-test-'))
    const port = await getFreePort()
    const child = spawn(viteNodeBinary, ['src/runtime-cli.ts'], {
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

    const [exitCode] = await once(child, 'exit')
    expect(exitCode).toBe(1)

    fs.rmSync(tmpDir, { recursive: true })
  }, 60000)
})
