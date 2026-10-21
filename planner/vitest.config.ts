import { defineConfig } from 'vitest/config';

// Unit and property tests run in parallel. The benchmark has its own config so it runs alone.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.bench.test.ts', 'node_modules/**'],
    testTimeout: 120000,
  },
});
