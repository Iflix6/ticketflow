import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real PostgreSQL (spec: "not only mocks"). Files skip themselves
 * with an explicit message when `TF_TEST_DATABASE_URL` is unset, so `npm run test:integration`
 * never *fakes* a pass on a machine without the database — the skip is the reported outcome.
 *
 * Database-per-worker isolation: each Vitest worker file creates `ticketflow_test_<suite>`,
 * runs the real migration files against it, and drops it on teardown. Serial file execution keeps
 * container memory bounded and makes lock-contention behaviour observable.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    poolOptions: { forks: { singleFork: false } },
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
