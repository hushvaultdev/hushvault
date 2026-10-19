import { defineConfig } from 'vitest/config'

// E2E lane: hits the live dev Worker at HUSHVAULT_E2E_BASE_URL. Isolated from the
// in-process unit suite in vitest.config.ts; nothing here touches FakeD1/FakeKV or
// Hono-in-process routing. Run via `pnpm --filter @hushvault/api test:e2e`.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/e2e/**/*.e2e.test.ts'],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Sequential: live rate limits, shared sink Worker, cleaner logs.
    fileParallelism: false,
    pool: 'forks',
    // Vitest 4 moved pool options to the top level.
    forks: { singleFork: true },
    setupFiles: ['test/e2e/setup.ts'],
    // The e2e tests make live HTTPS calls and print their own context; leave stdout free.
    silent: false,
  },
})
