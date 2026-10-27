import { loadConfig, type AppConfig } from '@ticketflow/config';

/**
 * Builds a REAL validated AppConfig for tests through `loadConfig` — the same code path the
 * production process runs. Overriding raw values rather than casting a literal keeps the schema
 * itself under test: if a required variable stops validating, tests fail, not silently boot.
 */
const BASE_TEST_ENV: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: '0',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/invalid',
  REDIS_URL: 'redis://127.0.0.1:6379',
  AUTH_SECRET: 'unit_test_phrase_for_hmac_at_least_32_chars',
  LAB_ENABLED: 'false',
  METRICS_ENABLED: 'true',
  RATE_LIMIT_MAX: '100000',
  RATE_LIMIT_WINDOW_MS: '1000',
  BODY_LIMIT: '100kb',
  GIT_SHA: undefined,
  OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
};

export function testConfig(overrides: Record<string, string | undefined> = {}): AppConfig {
  return loadConfig({ ...BASE_TEST_ENV, ...overrides });
}
