/**
 * Distribution smoke check for @tom-cat/pi-browser-runtime.
 * Verifies the built package exposes both executables and the protocol types
 * entry without starting any browser or server. Run after `pnpm build`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'))

function fail(message) {
  console.error(`smoke check failed: ${message}`)
  process.exit(1)
}

const requiredFiles = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/runtime-cli.js',
  'dist/browser-protocol.js',
  'bin.js',
  'bin-runtime.js',
]
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(packageDir, file))) {
    fail(`missing ${file} (run pnpm build first)`)
  }
}

if (pkg.name !== '@tom-cat/pi-browser-runtime') {
  fail(`unexpected package name ${pkg.name}`)
}
if (!pkg.bin?.['pi-browser-runtime'] || !pkg.bin?.playwriter) {
  fail('package must expose both the playwriter and pi-browser-runtime bins')
}
if (!pkg.exports?.['./browser-protocol']) {
  fail('package must export ./browser-protocol for Pi type imports')
}

const protocol = await import(pathToFileURL(path.join(packageDir, 'dist/browser-protocol.js')).href)
if (protocol.BROWSER_PROTOCOL_VERSION !== 1) {
  fail(`unexpected protocol version ${protocol.BROWSER_PROTOCOL_VERSION}`)
}

const index = await import(pathToFileURL(path.join(packageDir, 'dist/index.js')).href)
if (typeof index.startPlayWriterCDPRelayServer !== 'function') {
  fail('index must export startPlayWriterCDPRelayServer')
}
if (typeof index.ensureManagedRuntime !== 'function') {
  fail('index must export ensureManagedRuntime')
}

console.log(`smoke check ok: ${pkg.name}@${pkg.version}`)
