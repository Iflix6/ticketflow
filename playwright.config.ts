import { defineConfig } from '@playwright/test';

/**
 * Phase-5 E2E + accessibility smoke. Like the integration suite, this needs live infrastructure
 * (PostgreSQL, dev:api on :4000, dev:web on :3000) and is deliberately NOT part of
 * `npm run verify`'s in-process scope — it is run explicitly with `npm run test:e2e`.
 *
 * `channel: 'msedge'` uses the Edge already installed on the host instead of downloading a second
 * browser: fewer moving parts locally, and the CI matrix that installs Chromium explicitly is
 * Phase-7 territory. Traces/screenshots only on failure, into gitignored `test-results/`.
 */
export default defineConfig({
  testDir: './tests-e2e',
  timeout: 60_000,
  workers: 1, // shared local database fixture: runs must not interleave state
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_BASE_URL ?? 'http://localhost:3000',
    channel: 'msedge',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
