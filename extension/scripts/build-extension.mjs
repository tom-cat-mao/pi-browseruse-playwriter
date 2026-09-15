/**
 * Extension build entry with explicit identity modes.
 *
 *   --fork    fork dev ID (PLAYWRITER_FORK_DEV_KEY=1) and port 19989 default
 *   --legacy  upstream dev ID and legacy port 19988 default
 *
 * The fork mode is what `pnpm build` runs: a plain build must never hand a
 * fork user the upstream dev extension ID or point it at the legacy port.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const mode = process.argv.includes('--fork') ? 'fork' : process.argv.includes('--legacy') ? 'legacy' : null
if (!mode) {
  console.error('Usage: node scripts/build-extension.mjs --fork|--legacy')
  process.exit(1)
}

const extensionDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
if (mode === 'fork') {
  env.PLAYWRITER_FORK_DEV_KEY = '1'
  env.PLAYWRITER_PORT = env.PLAYWRITER_PORT || '19989'
} else {
  delete env.PLAYWRITER_FORK_DEV_KEY
  env.PLAYWRITER_PORT = env.PLAYWRITER_PORT || '19988'
}

const outDirName = env.PLAYWRITER_EXTENSION_DIST || 'dist'
if (!/^dist(?:-[a-z0-9]+)*$/.test(outDirName) || /^dist-firefox(?:-|$)/.test(outDirName)) {
  throw new Error('PLAYWRITER_EXTENSION_DIST must be dist or a Chrome dist-<suffix> directory')
}
const outDir = path.join(extensionDir, outDirName)
fs.rmSync(outDir, { recursive: true, force: true })

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const steps = [
  ['exec', 'tsc', '--project', '.'],
  ['exec', 'vite', 'build', '--config', 'vite.config.mts'],
]

for (const args of steps) {
  const result = spawnSync(pnpmCommand, args, { cwd: extensionDir, env, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
