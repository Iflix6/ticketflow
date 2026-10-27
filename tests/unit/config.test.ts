import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@ticketflow/config';
import { testConfig } from '../helpers/config.js';

/** The env schema is the first line of defence: a misconfigured lab must fail at startup, not serve traffic. */

// Deliberately free of the LOCAL_ONLY_SECRET_VALUES substrings (`secret`, `changeme`, …), so the
// production acceptance test below is rejected for the right reason (or not at all).
const requiredEnv = (): Record<string, string> => ({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a_fully_valid_test_phrase_for_hmac_32_chars',
});

describe('loadConfig', () => {
  it('applies documented defaults for unset optional variables', () => {
    const config = loadConfig(requiredEnv());
    expect(config.NODE_ENV).toBe('local');
    expect(config.PORT).toBe(4000);
    expect(config.RESERVATION_TTL_SECONDS).toBe(300);
    expect(config.LAB_ENABLED).toBe(false);
    expect(config.CORS_ORIGINS).toEqual(['http://localhost:3000']);
  });

  it('parses booleans from explicit strings, not truthiness ("false" must stay false)', () => {
    // z.coerce.boolean() would turn "false" into true; this guards the deliberate enum+transform.
    expect(loadConfig({ ...requiredEnv(), LAB_ENABLED: 'false' }).LAB_ENABLED).toBe(false);
    expect(loadConfig({ ...requiredEnv(), LAB_ENABLED: 'true' }).LAB_ENABLED).toBe(true);
    expect(loadConfig({ ...requiredEnv(), SECURE_COOKIES: '1' }).SECURE_COOKIES).toBe(true);
  });

  it('rejects non-postgres DATABASE_URL, short secrets and out-of-range numbers', () => {
    expect(() => loadConfig({ ...requiredEnv(), DATABASE_URL: 'mysql://localhost' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...requiredEnv(), AUTH_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...requiredEnv(), PORT: '70000' })).toThrow(ConfigError);
  });

  it('reports every issue at once so operators fix config in one pass', () => {
    let caught: ConfigError | undefined;
    try {
      loadConfig({ DATABASE_URL: 'nope', REDIS_URL: 'nope', AUTH_SECRET: 'x' });
    } catch (error) {
      caught = error instanceof ConfigError ? error : undefined;
    }
    expect(caught?.issues.length).toBeGreaterThanOrEqual(3);
  });

  it('refuses lab features and local-only default secrets in production', () => {
    expect(() =>
      loadConfig({ ...requiredEnv(), NODE_ENV: 'production', LAB_ENABLED: 'true' }),
    ).toThrow(/LAB_ENABLED/);
    expect(() =>
      loadConfig({ ...requiredEnv(), NODE_ENV: 'production', AUTH_SECRET: 'ticketflow_local_only_padding_padding' }),
    ).toThrow(/local-only default/);
  });

  it('accepts a production start with real-looking values and lab disabled', () => {
    const config = loadConfig({
      ...requiredEnv(),
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://svc:Tr0ub4dor3ProdP4ss@db.internal:5432/ticketflow',
    });
    expect(config.NODE_ENV).toBe('production');
  });

  it('parses byte-size body limits with an explicit grammar', () => {
    expect(loadConfig({ ...requiredEnv(), BODY_LIMIT: '512kb' }).BODY_LIMIT).toBe('512kb');
    expect(() => loadConfig({ ...requiredEnv(), BODY_LIMIT: '5000000' })).toThrow(ConfigError);
  });

  it('freezes the returned object so handlers cannot mutate global config', () => {
    const config = testConfig();
    expect(Object.isFrozen(config)).toBe(true);
  });
});
