import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Mirrors tsconfig.json's "@/*": ["./src/*"] — Next's bundler resolves this on its own, but
  // vitest needs it spelled out.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // tsconfig.json sets jsx: "preserve" for Next's own transform, which vitest's esbuild does not
  // apply; the automatic runtime lets .tsx tests use JSX without importing React per-file.
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    // proxy.test.ts (raw Request/Response, no DOM) stays on node by default; component tests
    // (.test.tsx) opt into jsdom with a `// @vitest-environment jsdom` docblock at their top,
    // rather than slowing every node-only test down with a DOM it doesn't need.
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['./test/setup.ts'],
    passWithNoTests: true,
  },
})
