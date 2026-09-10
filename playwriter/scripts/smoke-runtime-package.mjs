/**
 * Distribution smoke check for @tom-cat/pi-browser-runtime.
 * Verifies the built package owns the pi-browser-runtime bin, exports the
 * protocol types, and ships an extension bundle with the fork identity on
 * port 19989. Runs after `pnpm build`; starts no browser or server.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf-8'))

const FORK_EXTENSION_ID = 'eeklahpecooapnailfaebkjjembkjhhg'

function fail(message) {
  console.error(`smoke check failed: ${message}`)
  process.exit(1)
}

function extensionIdFromKey(key) {
  const hash = crypto.createHash('sha256').update(Buffer.from(key, 'base64')).digest()
  return [...hash.subarray(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .split('')
    .map((char) => 'abcdefghijklmnop'[parseInt(char, 16)])
    .join('')
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
if (!pkg.bin?.['pi-browser-runtime']) {
  fail('package must expose the pi-browser-runtime bin')
}
if (pkg.bin?.playwriter) {
  fail('package must not install a playwriter binary (it would shadow the upstream CLI)')
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

const bundledManifestPath = path.join(packageDir, 'dist', 'extension', 'manifest.json')
if (!fs.existsSync(bundledManifestPath)) {
  fail('missing dist/extension/manifest.json (packaged extension bundle)')
}
const bundledManifest = JSON.parse(fs.readFileSync(bundledManifestPath, 'utf-8'))
if (!bundledManifest.key) {
  fail('packaged extension must embed the fork dev key')
}
const bundledExtensionId = extensionIdFromKey(bundledManifest.key)
if (bundledExtensionId !== FORK_EXTENSION_ID) {
  fail(`packaged extension ID ${bundledExtensionId} is not the fork ID`)
}
const bundledBackground = fs.readFileSync(path.join(packageDir, 'dist', 'extension', 'background.js'), 'utf-8')
if (!bundledBackground.includes('19989')) {
  fail('packaged extension must target the managed runtime port 19989')
}

console.log(`smoke check ok: ${pkg.name}@${pkg.version}, bundled extension ${bundledExtensionId} on 19989`)
