import { defineConfig } from 'vitest/config'

/**
 * Vitest config for @hushvault/api.
 *
 * Tests target pure, WebCrypto-based units (envelope encryption, JWT/password
 * helpers, validation schemas). Node 20+ exposes the WebCrypto API on the global
 * `crypto` object, matching the Cloudflare Workers runtime these modules run in,
 * so the default Node environment is sufficient.
 *
 * Route handlers that require live D1/KV bindings are NOT covered here; testing
 * those needs `@cloudflare/vitest-pool-workers` (not currently a dependency).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
