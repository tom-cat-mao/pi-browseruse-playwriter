import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import childProcess from 'node:child_process'
import { build } from 'vite'
import { assertFirefoxCsp } from '../../scripts/firefox-csp.mjs'

const extensionDir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..')
const outDirName = process.env.PI_BROWSER_FIREFOX_DIST || 'dist-firefox'
if (!/^dist-firefox(?:-[a-z0-9-]+)?$/.test(outDirName)) {
  throw new Error('PI_BROWSER_FIREFOX_DIST must be dist-firefox or a dist-firefox-<suffix> directory')
}
const outDir = path.join(extensionDir, outDirName)
const host = process.env.PI_BROWSER_HOST || '127.0.0.1'
const port = process.env.PI_BROWSER_PORT || '19989'
if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
  throw new Error('Firefox builds require a loopback PI_BROWSER_HOST')
}
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  throw new Error('PI_BROWSER_PORT must be an integer between 1 and 65535')
}

const runtimePackage = JSON.parse(fs.readFileSync(path.join(extensionDir, '../playwriter/package.json'), 'utf8'))
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.firefox.json'), 'utf8'))
const chromeManifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'))
assertFirefoxCsp(manifest)
if (manifest.version !== chromeManifest.version) {
  throw new Error('Firefox and Chrome extension manifest versions must match')
}

const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const typecheck = childProcess.spawnSync(pnpmCommand, ['exec', 'tsc', '--project', '.'], {
  cwd: extensionDir,
  stdio: 'inherit',
})
if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1)
}

fs.rmSync(outDir, { recursive: true, force: true })
for (const entry of ['firefox-background', 'firefox-dom', 'firefox-popup']) {
  await build({
    configFile: false,
    root: extensionDir,
    define: {
      'process.env.PI_BROWSER_HOST': JSON.stringify(host),
      'process.env.PI_BROWSER_PORT': JSON.stringify(port),
      __PLAYWRITER_VERSION__: JSON.stringify(runtimePackage.version),
    },
    build: {
      outDir,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      target: 'firefox139',
      lib: {
        entry: path.join(extensionDir, 'src', `${entry}.ts`),
        name: entry.replace(/-([a-z])/g, (_match, letter) => {
          return letter.toUpperCase()
        }),
        formats: ['iife'],
        fileName: () => {
          return `${entry}.js`
        },
      },
    },
  })
}
fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
fs.writeFileSync(path.join(outDir, 'firefox-build.json'), `${JSON.stringify({ host, port: Number(port) }, null, 2)}\n`)
fs.copyFileSync(path.join(extensionDir, 'src/firefox-popup.html'), path.join(outDir, 'firefox-popup.html'))
fs.cpSync(path.join(extensionDir, 'icons'), path.join(outDir, 'icons'), { recursive: true })
console.log(`Built Firefox extension at ${outDir}`)
console.log('Development loading: about:debugging#/runtime/this-firefox → Load Temporary Add-on → manifest.json')
console.log('This unsigned build is not an AMO release. Ordinary permanent Firefox installation requires signing.')
