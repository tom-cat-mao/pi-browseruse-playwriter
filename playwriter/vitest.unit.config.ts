import { defineConfig } from 'vitest/config'

/**
 * Browser-free unit suites for CI. Chrome-dependent tests (for example
 * src/locator-selector.test.ts, which launches chromium) run only in the
 * user-authorized browser phase.
 *
 * Files run one at a time. Several suites bind real ports and a kill-by-port
 * test could otherwise race a parallel file, kill its in-process server and
 * crash the vitest fork pool with ERR_IPC_CHANNEL_CLOSED.
 *
 * New browser-free suites are picked up automatically when named
 * `*.unit.test.ts`, `*managed*.test.ts`, `*worker*.test.ts` or
 * `*group*.test.ts`; otherwise add them to this list.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 30000,
    exclude: ['dist', 'dist/**/*', 'node_modules/**'],
    setupFiles: ['./vitest.setup.ts'],
    env: {
      PLAYWRITER_NODE_ENV: 'development',
    },
    pool: 'forks',
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    include: [
      'src/create-logger.test.ts',
      'src/cdp-log.test.ts',
      'src/utils.test.ts',
      'src/relay-client.test.ts',
      'src/*.unit.test.ts',
      'src/channel-owner-inspect.test.ts',
      'src/chrome-discovery.test.ts',
      'src/diff-utils.test.ts',
      'src/htmlrewrite.test.ts',
      'src/kitty-graphics.test.ts',
      'src/relay-state.test.ts',
      'src/scoped-fs.test.ts',
      'src/*managed*.test.ts',
      'src/*worker*.test.ts',
      'src/*group*.test.ts',
    ],
  },
})
