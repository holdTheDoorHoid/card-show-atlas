import { defineConfig } from 'vitest/config';

// The season planner benchmark, alone and in one thread, so it measures the planner and not
// other test files competing for the CPU.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.bench.test.ts'],
    fileParallelism: false,
    testTimeout: 120000,
  },
});
