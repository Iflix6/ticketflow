import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AppConfig } from '@ticketflow/config';
import type { Database } from '../../apps/api/src/db/pool.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../apps/api/src/observability/logger.js';
import { issueToken } from '../../apps/api/src/modules/auth/credentials.js';
import { testConfig } from '../helpers/config.js';
import {
  databaseAvailable,
  seedCatalog,
  seedUser,
  startTestDatabase,
  type TestDatabaseHandle,
} from '../helpers/integration-db.js';

// Honest skip: no real PostgreSQL means this suite reports skipped, never falsely green.
const suite = databaseAvailable() ? describe : describe.skip;

suite('Phase 3 — comparative strategies and the isolated lab', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let app: Express;
  let config: AppConfig;

  let tierId: string; // public capacity 12
  let customerToken: string;
  let adminToken: string;

  const publicViolations = async (): Promise<string[]> => {
    const { rows } = await db.query<{ invariant: string }>('SELECT invariant FROM app.invariant_violations');
    return rows.map((r) => r.invariant);
  };

  const labViolations = async (): Promise<number> => {
    const { rows } = await db.query<{ n: string }>('SELECT COUNT(*)::text AS n FROM lab.live_allocation_violations');
    return Number(rows[0]?.n ?? '0');
  };

  const labCounters = async (seed: number): Promise<{ available: number; reserved: number; sold: number; capacity: number }> => {
    const { rows } = await db.query<{ available: number; reserved: number; sold: number; capacity: number }>(
      `SELECT i.available, i.reserved, i.sold, i.capacity
         FROM lab.inventory i
        WHERE i.tier_id = lab.tier_id($1::int, 1)`,
      [seed],
    );
    return rows[0] ?? { available: -1, reserved: -1, sold: -1, capacity: -1 };
  };

  beforeAll(async () => {
    handle = await startTestDatabase('strategies');
    db = handle.db;
    config = testConfig({ LAB_ENABLED: 'true' });
    app = createApp({ config, db, logger: createLogger(config) });

    tierId = (await seedCatalog(db, 'strat-concert', 'Floor', 12)).tierId;
    const customerId = await seedUser(db, 'strat-customer@load.test');
    const adminId = await seedUser(db, 'strat-admin@load.test', 'LAB_ADMIN');
    customerToken = bearer(customerId, 'strat-customer@load.test');
    adminToken = bearer(adminId, 'strat-admin@load.test', 'LAB_ADMIN');
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  const reserve = (body: object, key: string) =>
    request(app).post('/api/v1/reservations').set('Authorization', customerToken).set('Idempotency-Key', key).send(body);

  const createRun = (body: object) =>
    request(app).post('/api/v1/lab/runs').set('Authorization', adminToken).send(body);

  describe('public reservation path honours Safe A/B/C and refuses unsafe', () => {
    it('Safe B (pessimistic) reserves atomically', async () => {
      const res = await reserve({ tierId, quantity: 2, strategy: 'pessimistic' }, 'pub-pessimistic-01');
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ quantity: 2, status: 'PENDING' });
      const { rows } = await db.query<{ reserved: number }>('SELECT reserved FROM inventory WHERE tier_id = $1', [tierId]);
      expect(rows[0]?.reserved).toBeGreaterThanOrEqual(2);
      expect(await publicViolations()).toEqual([]);
    });

    it('Safe C (optimistic) reserves atomically', async () => {
      const res = await reserve({ tierId, quantity: 1, strategy: 'optimistic' }, 'pub-optimistic-01');
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('PENDING');
      expect(await publicViolations()).toEqual([]);
    });

    it('refuses the unsafe baseline on public inventory with 422 strategy_unavailable', async () => {
      const res = await reserve({ tierId, quantity: 1, strategy: 'unsafe_lab' }, 'pub-unsafe-refused');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('strategy_unavailable');
      // No inventory moved by a rejected strategy.
      const before = await db.query<{ reserved: number }>('SELECT reserved FROM inventory WHERE tier_id = $1', [tierId]);
      expect(before.rows[0]?.reserved).toBeLessThanOrEqual(3);
    });

    it('refuses an unknown strategy id', async () => {
      const res = await reserve({ tierId, quantity: 1, strategy: 'quantum_tunneling' }, 'pub-bogus-000001');
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('strategy_unavailable');
    });
  });

  describe('controlled experiments: safe strategies never oversell', () => {
    it('Safe A sells exactly capacity and reports zero invariant violations', async () => {
      const res = await createRun({
        strategy: 'atomic_update',
        label: 'safe-a',
        configuration: { capacity: 10, concurrentUsers: 30, seed: 1001, dbPoolMax: 10 },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('COMPLETED');
      const outcomes = res.body.data.outcomes;
      expect(outcomes.succeeded).toBe(10); // min(capacity, users)
      expect(outcomes.soldOut).toBe(20);
      expect(outcomes.conflict).toBe(0);
      expect(outcomes.serverError).toBe(0);
      expect(outcomes.invariantViolations).toBe(0);
      expect(await labViolations()).toBe(0);

      // Counters stay exactly consistent: every sold-out seat is still available, reserved == successes.
      const c = await labCounters(1001);
      expect(c.available + c.reserved + c.sold).toBe(c.capacity);
      expect(c.reserved).toBe(10);
    });

    it('Safe B (pessimistic) preserves the invariant under contention', async () => {
      const res = await createRun({
        strategy: 'pessimistic',
        configuration: { capacity: 8, concurrentUsers: 24, seed: 2002, dbPoolMax: 10 },
      });
      expect(res.status).toBe(201);
      const outcomes = res.body.data.outcomes;
      expect(outcomes.succeeded).toBe(8);
      expect(outcomes.invariantViolations).toBe(0);
      expect(await labViolations()).toBe(0);
      const c = await labCounters(2002);
      expect(c.reserved).toBe(8);
    });

    it('Safe C (optimistic) never sells more than capacity; conflict is not conflated with sold out', async () => {
      const res = await createRun({
        strategy: 'optimistic',
        configuration: { capacity: 6, concurrentUsers: 18, seed: 3003, dbPoolMax: 10 },
      });
      expect(res.status).toBe(201);
      const outcomes = res.body.data.outcomes;
      // The hard claim: safe C never oversells.
      expect(outcomes.succeeded).toBeLessThanOrEqual(6);
      expect(outcomes.invariantViolations).toBe(0);
      expect(outcomes.serverError).toBe(0);
      // It distinguishes contention (conflict) from exhaustion (sold out) — they sum with succeeded.
      expect(outcomes.succeeded + outcomes.soldOut + outcomes.conflict).toBe(18);
      expect(await labViolations()).toBe(0);
    });
  });

  describe('the isolated unsafe baseline actually observes an anomaly', () => {
    it('unsafe_lab over-allocates and the independent view flags it (measured, not assumed)', async () => {
      const capacity = 5;
      const res = await createRun({
        strategy: 'unsafe_lab',
        configuration: { capacity, concurrentUsers: 15, artificialDelayMs: 40, seed: 4004, dbPoolMax: 15 },
      });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('COMPLETED');
      const outcomes = res.body.data.outcomes;

      // The lost update is visible in the counters: more "successful" reservations than seats exist.
      expect(outcomes.succeeded).toBeGreaterThan(capacity);
      // And the same over-allocation detector used for the safe path fires — that is the whole point.
      expect(outcomes.invariantViolations).toBeGreaterThanOrEqual(1);
      expect(await labViolations()).toBeGreaterThanOrEqual(1);

      // Per-request evidence: attempts that blind-wrote are classified, not reported as clean sales.
      const results = await request(app)
        .get(`/api/v1/lab/runs/${res.body.data.id}/results?limit=100`)
        .set('Authorization', adminToken);
      expect(results.status).toBe(200);
      const overAllocated = (results.body.data as { failureClass: string }[]).filter(
        (r) => r.failureClass === 'lost_update_overallocation',
      );
      expect(overAllocated.length).toBeGreaterThan(capacity);
    });
  });

  describe('run history, immutability, and fixture reset', () => {
    it('lists and reads runs, and a completed run rejects further writes (TF002)', async () => {
      const created = await createRun({
        strategy: 'atomic_update',
        configuration: { capacity: 4, concurrentUsers: 8, seed: 5005, dbPoolMax: 8 },
      });
      const runId = created.body.data.id as string;

      const list = await request(app).get('/api/v1/lab/runs').set('Authorization', adminToken);
      expect(list.status).toBe(200);
      expect((list.body.data as { id: string }[]).map((r) => r.id)).toContain(runId);

      const detail = await request(app).get(`/api/v1/lab/runs/${runId}`).set('Authorization', adminToken);
      expect(detail.status).toBe(200);
      expect(detail.body.data.strategy).toBe('atomic_update');
      expect(detail.body.data.finishedAt).toBeTypeOf('string');

      // Immutability trigger: any UPDATE to a completed run raises TF002 and the write is rejected.
      await expect(db.query('UPDATE experiment_runs SET label = $2 WHERE id = $1', [runId, 'tamper'])).rejects.toThrow(
        /immutable/,
      );
    });

    it('resets the fixture on demand', async () => {
      const res = await request(app)
        .post('/api/v1/lab/fixtures/reset')
        .set('Authorization', adminToken)
        .send({ capacity: 100, tiers: 1 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ capacity: 100, tiers: 1 });
      expect(res.body.data.invariantViolations).toBe(0);
    });

    it('denies the lab to a non-admin even with LAB_ENABLED on', async () => {
      // customerToken is a CUSTOMER, so the mount's requireRole('LAB_ADMIN') rejects before the handler.
      const forbidden = await request(app)
        .post('/api/v1/lab/runs')
        .set('Authorization', customerToken)
        .send({ strategy: 'atomic_update', configuration: { capacity: 1, concurrentUsers: 1 } });
      expect(forbidden.status).toBe(403);
    });
  });
});

function bearer(userId: string, email: string, role: 'CUSTOMER' | 'LAB_ADMIN' = 'CUSTOMER'): string {
  const token = issueToken({ id: userId, email, role }, testConfig().AUTH_SECRET, 3600);
  return `Bearer ${token}`;
}
