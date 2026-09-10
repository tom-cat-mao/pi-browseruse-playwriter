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

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const steps = [
  ['exec', 'tsc', '--project', '.'],
  ['exec', 'vite', 'build', '--config', 'vite.config.mts'],
  ['exec', 'tsx', 'scripts/download-prism.ts'],
]

for (const args of steps) {
  const result = spawnSync(pnpmCommand, args, { cwd: extensionDir, env, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}
