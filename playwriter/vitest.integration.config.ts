import { defineConfig } from 'vitest/config'

/**
 * Browser-free suites that spawn real child processes or kill processes by
 * port. Still part of CI; kept apart from the unit config and serialized so
 * these tests cannot race another file's listeners or fork pool.
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
      'src/runtime-cli.test.ts',
      'src/stream-relay.test.ts',
      'test/security.test.ts',
      'test/kill-port.test.ts',
      'src/*.integration.test.ts',
      'test/*.integration.test.ts',
    ],
  },
})
