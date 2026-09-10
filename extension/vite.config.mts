import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'vite'
import { viteStaticCopy } from 'vite-plugin-static-copy'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// Bundle the playwriter package version into the extension so it can report
// which playwriter version it was built against. CLI/MCP use this to warn
// when the extension is outdated.
const playwriterPkg = JSON.parse(readFileSync(resolve(__dirname, '../playwriter/package.json'), 'utf-8'))

// Stable dev extension ID: pebbngnfojnignonigcnkdilknapkgid
const LEGACY_DEV_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAwCJoq5UYhOo5x8s50pVBUHjQ8idyUHnZFDj1JspWJPe6kvM7RFIaE/y5WTAH05kuK0R7v/ipcGA4ywA5wKdPKHZzkl5xstlNPj0Ivu4CqLobU7eY5G3k3Gq7wql2pbwb/A8Nat4VLbfBjQLA6TGWd3LQOHS6M0B3AvrtEw7DLDUdGKh4SCLewCbdlDIzpXQwKOzrRPyLFBwj9eEeITy5aNwJ9r9JMNBvACVZiRCHsGI6DufU+OiIO232l/8OoNNt6kdTMyNgiqOogFApXPJwREUwZHGqjXD3s6bXiBIQtwkNyZfemHKkxj6g/fhCV2EMgTY6+ikQEY1gEJMrRVmcYQIDAQAB'

// Fork dev extension key. Stable ID: eeklahpecooapnailfaebkjjembkjhhg
// Only the public key lives here; the private key stays out of the repo.
// Set PLAYWRITER_FORK_DEV_KEY=1 to build the extension with the fork identity,
// which lets it be installed side by side with the upstream dev extension.
const FORK_DEV_EXTENSION_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAukhlH+0zbP8qOsy2KJSGU9z0PH/ip/TMvmKwDPHM4hBRcN/l5ZwAajHS5eM5dnypsemviVMSmkvIrFk8xbdGp/f06Yzvr+Az/WWA4ICFIQZkLrCR3dyvw4tkYWtYZjpWA/fhqgQxUMSKlImJYOu8BwSUGmGxVoi+zCpt1Tu3Im77PEIJ8lH/TAxtdYdDAVp9mU9f453/rDdZ103W53rPvcTV2WmDIJp2lKGP70bzLnJMLlZXB75e11OT91EaDA1fs4TR1FAj8sGk4iNsh/FaUNGOi9R81csXpsiHvRxNWsq/J9Oq0heNrkCmV3P61M6cbjJW/GNoc7QpgY4gdmAeOwIDAQAB'

const useForkDevKey = process.env.PLAYWRITER_FORK_DEV_KEY === '1' || process.env.PLAYWRITER_FORK_DEV_KEY === 'true'

const defineEnv: Record<string, string> = {
  // Fork dev builds target the managed runtime port; legacy and production
  // builds keep the old relay port.
  'process.env.PLAYWRITER_PORT': JSON.stringify(
    process.env.PLAYWRITER_PORT || (!process.env.PRODUCTION && useForkDevKey ? '19989' : '19988'),
  ),
  __PLAYWRITER_VERSION__: JSON.stringify(playwriterPkg.version),
  __PLAYWRITER_OPEN_WELCOME_PAGE__: JSON.stringify(process.env.PLAYWRITER_OPEN_WELCOME_PAGE !== '0'),
}
if (process.env.TESTING) {
  defineEnv['import.meta.env.TESTING'] = 'true'
}

// Allow tests to build per-port extension outputs to avoid parallel run conflicts.
const outDir = process.env.PLAYWRITER_EXTENSION_DIST || 'dist'

export default defineConfig({
  plugins: [
    viteStaticCopy({
      targets: [
        {
          src: resolve(__dirname, 'icons/*'),
          dest: 'icons',
        },

        {
          src: resolve(__dirname, 'manifest.json'),
          dest: '.',
          transform: (content) => {
            const manifest = JSON.parse(content)

            // Only include tabs permission during testing
            if (process.env.TESTING) {
              if (!manifest.permissions.includes('tabs')) {
                manifest.permissions.push('tabs')
              }
            }

            // Inject key for stable extension ID in dev/test builds (not production).
            // Default build keeps the legacy dev ID (pebbngnfojnignonigcnkdilknapkgid)
            // so existing tests keep working. The fork key gives the runtime its own
            // dev identity (eeklahpecooapnailfaebkjjembkjhhg).
            if (!process.env.PRODUCTION) {
              manifest.key = useForkDevKey ? FORK_DEV_EXTENSION_KEY : LEGACY_DEV_EXTENSION_KEY
            }

            return JSON.stringify(manifest, null, 2)
          },
        },
      ],
    }),
  ],

  build: {
    outDir,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: {
        background: resolve(__dirname, 'src/background.ts'),
        offscreen: resolve(__dirname, 'src/offscreen.html'),
        welcome: resolve(__dirname, 'src/welcome.html'),
        tutorial: resolve(__dirname, 'src/tutorial.html'),
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
  define: defineEnv,
})
