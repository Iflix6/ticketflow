import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from '../../apps/api/src/db/pool.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../apps/api/src/observability/logger.js';
import { issueToken } from '../../apps/api/src/modules/auth/credentials.js';
import { testConfig } from '../helpers/config.js';
import { databaseAvailable, seedCatalog, startTestDatabase, type TestDatabaseHandle } from '../helpers/integration-db.js';

// Honest skip: without a real PostgreSQL this suite reports as skipped, never as passed.
const suite = databaseAvailable() ? describe : describe.skip;

suite('api boot & middleware pipeline', () => {

  let handle: TestDatabaseHandle;
  let db: Database;
  let app: Express;
  let labApp: Express;

  beforeAll(async () => {
    handle = await startTestDatabase('api');
    db = handle.db;
    app = createApp({ config: testConfig(), db, logger: createLogger(testConfig()) });
    // Second instance with the lab ON: proves mounting is config-driven, not runtime-flipable.
    labApp = createApp({
      config: testConfig({ LAB_ENABLED: 'true' }),
      db,
      logger: createLogger(testConfig({ LAB_ENABLED: 'true' })),
    });
    await seedCatalog(db, 'integration-boot-event', 'General', 10);
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  describe('health', () => {
    it('/health/live answers 200 without dependency checks', async () => {
      const res = await request(app).get('/health/live');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('/health/ready answers 200 against the live database', async () => {
      const res = await request(app).get('/health/ready');
      expect(res.status).toBe(200);
      expect(res.body.detail).toContain('database');
    });

    it('/health/ready answers 503 (dependency_unavailable) when the database is gone', async () => {
      const brokenDb = {
        ...db,
        query: async () => {
          throw new Error('connection refused');
        },
      } as unknown as Database;
      const brokenApp = createApp({ config: testConfig(), db: brokenDb, logger: createLogger(testConfig()) });
      const res = await request(brokenApp).get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('dependency_unavailable');
    });
  });

  describe('envelope & correlation', () => {
    it('every response carries x-request-id; a valid inbound id is honoured', async () => {
      const generated = await request(app).get('/health/live');
      expect(generated.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);

      const inbound = 'operator-trace-id-000123';
      const res = await request(app).get('/health/live').set('x-request-id', inbound);
      expect(res.headers['x-request-id']).toBe(inbound);
    });

    it('a hostile inbound request id is replaced, not reflected', async () => {
      const res = await request(app).get('/health/live').set('x-request-id', '"><script>alert(1)</script>');
      expect(res.headers['x-request-id']).not.toContain('script');
    });

    it('unknown routes return the JSON error envelope, not Express HTML', async () => {
      const res = await request(app).get('/api/v1/nope');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('not_found');
      expect(res.body.error.requestId).toBeTypeOf('string');
    });

    it('malformed JSON bodies become 400 validation_failed, not 500', async () => {
      const res = await request(app)
        .post('/api/v1/events')
        .set('content-type', 'application/json')
        .send('{ oops this is not json');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
    });
  });

  describe('security headers', () => {
    it('sends hardening headers and no framework fingerprint', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-origin');
    });

    it('does not set HSTS in non-production (documented as production-only)', async () => {
      const res = await request(app).get('/health/live');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });
  });

  describe('metrics', () => {
    it('/metrics exposes Prometheus text with bounded route labels', async () => {
      await request(app).get('/health/live');
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.text).toContain('ticketflow_http_requests_total');
      // Route template, not concrete path: 404 floods must not create unbounded series.
      expect(res.text).not.toContain('/api/v1/nope');
    });
  });

  describe('lab isolation (ADR-0009)', () => {
    it('lab endpoints do not exist when LAB_ENABLED=false', async () => {
      const res = await request(app).get('/api/v1/lab/strategies');
      expect(res.status).toBe(404);
    });

    it('lab endpoints require authentication and LAB_ADMIN when enabled', async () => {
      const anonymous = await request(labApp).get('/api/v1/lab/strategies');
      expect(anonymous.status).toBe(401);

      const asCustomer = await request(labApp)
        .get('/api/v1/lab/strategies')
        .set('Authorization', demoToken('CUSTOMER'));
      expect(asCustomer.status).toBe(403);

      const asAdmin = await request(labApp)
        .get('/api/v1/lab/strategies')
        .set('Authorization', demoToken('LAB_ADMIN'));
      expect(asAdmin.status).toBe(200);
      expect(asAdmin.body.data.length).toBe(4); // includes the unsafe descriptor locally
    });

    it('public strategy listing never appears on a lab-disabled app even with an admin token', async () => {
      const res = await request(app)
        .get('/api/v1/lab/strategies')
        .set('Authorization', demoToken('LAB_ADMIN'));
      expect(res.status).toBe(404);
    });
  });

  describe('rate limiting', () => {
    it('returns 429 with retry-after once the window budget is exhausted', async () => {
      const tight = testConfig({ RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' });
      const tightApp = createApp({ config: tight, db, logger: createLogger(tight) });

      await request(tightApp).get('/api/v1/events');
      await request(tightApp).get('/api/v1/events');
      const limited = await request(tightApp).get('/api/v1/events');
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('rate_limited');
      expect(limited.headers['retry-after']).toBeTypeOf('string');
    });

    it('does not throttle /health or /metrics (scrapers must not cause false outages)', async () => {
      const tight = testConfig({ RATE_LIMIT_MAX: '1', RATE_LIMIT_WINDOW_MS: '60000' });
      const tightApp = createApp({ config: tight, db, logger: createLogger(tight) });
      await request(tightApp).get('/api/v1/events');
      const health = await request(tightApp).get('/health/live');
      expect(health.status).toBe(200);
      const metrics = await request(tightApp).get('/metrics');
      expect(metrics.status).toBe(200);
    });
  });
});

/** Local demo token for tests only; mirrors what `POST /api/v1/auth/token` would return. */
function demoToken(role: 'CUSTOMER' | 'LAB_ADMIN'): string {
  // Same secret the tested app validates against (testConfig's base value).
  return issueToken(
    { id: '00000000-0000-4000-8000-000000000001', email: `${role.toLowerCase()}@local.test`, role },
    testConfig().AUTH_SECRET,
    600,
  );
}
