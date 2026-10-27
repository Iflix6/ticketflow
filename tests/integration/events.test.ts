import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from '../../apps/api/src/db/pool.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../apps/api/src/observability/logger.js';
import { testConfig } from '../helpers/config.js';
import { databaseAvailable, seedCatalog, startTestDatabase, type TestDatabaseHandle } from '../helpers/integration-db.js';

const suite = databaseAvailable() ? describe : describe.skip;

suite('events API against real PostgreSQL', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let app: Express;
  let eventId: string;

  beforeAll(async () => {
    handle = await startTestDatabase('events');
    db = handle.db;
    app = createApp({ config: testConfig(), db, logger: createLogger(testConfig()) });
    const seeded = await seedCatalog(db, 'metered-synth-festival', 'GA', 100);
    eventId = seeded.eventId;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it('lists events with pagination metadata', async () => {
    const res = await request(app).get('/api/v1/events');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toMatchObject({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
    expect(res.body.data[0]).toMatchObject({ slug: 'metered-synth-festival', status: 'ON_SALE' });
    // Timestamps are ISO strings — UTC storage contract (ADR-0006).
    expect(res.body.data[0].startAt).toBeTypeOf('string');
  });

  it('filters by status via a bound parameter', async () => {
    const onSale = await request(app).get('/api/v1/events?status=ON_SALE');
    expect(onSale.body.data.length).toBe(1);
    const draft = await request(app).get('/api/v1/events?status=DRAFT');
    expect(draft.body.data.length).toBe(0);
  });

  it('rejects invalid pagination and unknown status with 400 before touching SQL', async () => {
    expect((await request(app).get('/api/v1/events?page=0')).status).toBe(400);
    expect((await request(app).get('/api/v1/events?pageSize=500')).status).toBe(400);
    expect((await request(app).get('/api/v1/events?status=NOT_A_STATUS')).status).toBe(400);
  });

  it('returns 400 for a non-UUID path parameter (validated at the boundary)', async () => {
    const res = await request(app).get('/api/v1/events/1%20OR%201%3D1--');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
  });

  it('returns 404 for a well-formed but unknown UUID', async () => {
    const res = await request(app).get('/api/v1/events/00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('serves tiers joined with authoritative inventory counters', async () => {
    const res = await request(app).get(`/api/v1/events/${eventId}/tiers`);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({
      tier: { name: 'GA', capacity: 100 },
      inventory: { available: 100, reserved: 0, sold: 0 },
    });
    // Money-shaped values are strings, not floats (pool type parser contract).
    expect(typeof res.body.data[0].tier.priceDisplayOnly).toBe('string');
  });

  it('SQL injection payloads in query values are inert data, never executed', async () => {
    const res = await request(app).get(`/api/v1/events?status=${encodeURIComponent("DRAFT'; DROP TABLE events; --")}`);
    expect(res.status).toBe(400); // enum validation rejects it at the boundary
    const stillThere = await db.query('SELECT COUNT(*)::int AS n FROM events');
    expect(stillThere.rows[0]?.n).toBe(1);
  });
});
