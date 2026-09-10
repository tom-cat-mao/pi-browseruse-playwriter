import { defineConfig } from 'vitest/config'

/**
 * Browser-free suites for CI. Chrome-dependent tests stay in the default
 * config and run only in the user-authorized browser phase.
 *
 * New non-browser suites are picked up automatically when named
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
    include: [
      'src/create-logger.test.ts',
      'src/cdp-log.test.ts',
      'src/utils.test.ts',
      'src/relay-client.test.ts',
      'src/runtime-cli.test.ts',
      'src/*.unit.test.ts',
      'src/channel-owner-inspect.test.ts',
      'src/chrome-discovery.test.ts',
      'src/diff-utils.test.ts',
      'src/htmlrewrite.test.ts',
      'src/kitty-graphics.test.ts',
      'src/locator-selector.test.ts',
      'src/relay-state.test.ts',
      'src/scoped-fs.test.ts',
      'src/stream-relay.test.ts',
      'src/*managed*.test.ts',
      'src/*worker*.test.ts',
      'src/*group*.test.ts',
      'test/kill-port.test.ts',
      'test/security.test.ts',
    ],
  },
})
