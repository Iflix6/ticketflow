import { defineConfig } from 'vitest/config';

/**
 * Unit tests: hermetic, no I/O. They must run on a fresh clone without Docker, because CI lint
 * of business logic should not depend on service containers being healthy.
 */
export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    pool: 'threads',
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
