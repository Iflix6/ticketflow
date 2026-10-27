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

suite('Safe core: reservations, idempotency, checkout, cancel, expiry', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let app: Express;
  let config: AppConfig;

  let tierId: string; // capacity 10, price 10.00
  let soldOutTierId: string; // capacity 2
  let concurrentTierId: string; // capacity 3
  let customerToken: string;
  let otherToken: string;
  let customerId: string;

  const counters = async (tier: string) => {
    const { rows } = await db.query<{ available: number; reserved: number; sold: number; capacity: number }>(
      'SELECT capacity, available, reserved, sold FROM inventory WHERE tier_id = $1',
      [tier],
    );
    return rows[0] ?? { capacity: -1, available: -1, reserved: -1, sold: -1 };
  };

  /** The independent invariant views are the acceptance oracle — they share no code with the app. */
  const invariantViolations = async () => {
    const { rows } = await db.query<{ invariant: string }>('SELECT invariant FROM app.invariant_violations');
    return rows.map((r) => r.invariant);
  };

  const countOf = async (sql: string, params: readonly unknown[] = []): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(sql, params);
    return Number(rows[0]?.n ?? '0');
  };

  beforeAll(async () => {
    handle = await startTestDatabase('reservations');
    db = handle.db;
    config = testConfig();
    app = createApp({ config, db, logger: createLogger(config) });

    tierId = (await seedCatalog(db, 'core-concert', 'General', 10)).tierId;
    soldOutTierId = (await seedCatalog(db, 'tiny-venue', 'Balcony', 2)).tierId;
    concurrentTierId = (await seedCatalog(db, 'race-venue', 'Floor', 3)).tierId;

    customerId = await seedUser(db, 'core-customer@load.test');
    const otherId = await seedUser(db, 'other-customer@load.test');
    customerToken = bearer(customerId, 'core-customer@load.test');
    otherToken = bearer(otherId, 'other-customer@load.test');
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  const reserve = (body: object, key: string, token = customerToken) =>
    request(app).post('/api/v1/reservations').set('Authorization', token).set('Idempotency-Key', key).send(body);

  describe('creating a reservation (Safe A)', () => {
    it('atomically decrements available, increments reserved and returns a PENDING reservation', async () => {
      const res = await reserve({ tierId, quantity: 2 }, 'reserve-basic-0001');
      expect(res.status).toBe(201);
      expect(res.headers['x-request-id']).toBeTypeOf('string');
      expect(res.body.data).toMatchObject({ quantity: 2, status: 'PENDING', tierId });
      expect(res.body.data.secondsRemaining).toBeGreaterThan(0);

      const c = await counters(tierId);
      expect(c).toMatchObject({ available: 8, reserved: 2, sold: 0 });
      expect(await invariantViolations()).toEqual([]);

      // Outbox + audit were written in the same transaction as the reservation.
      expect(await countOf(`SELECT COUNT(*)::text AS n FROM outbox_events WHERE event_type = 'reservation.created'`)).toBeGreaterThanOrEqual(1);
      expect(await countOf(`SELECT COUNT(*)::text AS n FROM audit_records WHERE action = 'reservation.create'`)).toBeGreaterThanOrEqual(1);
    });

    it('rejects a mutation with no Idempotency-Key header', async () => {
      const res = await request(app)
        .post('/api/v1/reservations')
        .set('Authorization', customerToken)
        .send({ tierId, quantity: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('idempotency_key_missing');
    });

    it('rejects an unauthenticated reservation attempt with 401', async () => {
      const res = await request(app)
        .post('/api/v1/reservations')
        .set('Idempotency-Key', 'reserve-noauth-0001')
        .send({ tierId, quantity: 1 });
      expect(res.status).toBe(401);
    });

    it('enforces MAX_QUANTITY_PER_RESERVATION before touching inventory', async () => {
      const before = await counters(tierId);
      const res = await reserve({ tierId, quantity: config.MAX_QUANTITY_PER_RESERVATION + 1 }, 'reserve-toomany-01');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('validation_failed');
      expect(await counters(tierId)).toEqual(before); // no inventory moved
    });

    it('refuses a reservation for another user\'s row on read (403) but lets the owner read it (200)', async () => {
      const created = await reserve({ tierId, quantity: 1 }, 'reserve-owner-read');
      const id = created.body.data.id as string;
      const mine = await request(app).get(`/api/v1/reservations/${id}`).set('Authorization', customerToken);
      expect(mine.status).toBe(200);
      const theirs = await request(app).get(`/api/v1/reservations/${id}`).set('Authorization', otherToken);
      expect(theirs.status).toBe(403);
    });
  });

  describe('sold out', () => {
    it('returns 409 sold_out and frees the key so a later attempt is not pinned to the failure', async () => {
      await reserve({ tierId: soldOutTierId, quantity: 2 }, 'soldout-fill-0001');
      const res = await reserve({ tierId: soldOutTierId, quantity: 1 }, 'soldout-over-0001');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('sold_out');

      const c = await counters(soldOutTierId);
      expect(c).toMatchObject({ available: 0, reserved: 2 });

      // The rolled-back attempt left no completed idempotency record for its key.
      expect(
        await countOf(
          `SELECT COUNT(*)::text AS n FROM idempotency_records WHERE key = 'soldout-over-0001' AND state = 'COMPLETED'`,
        ),
      ).toBe(0);
      expect(await invariantViolations()).toEqual([]);
    });
  });

  describe('idempotency semantics', () => {
    it('replays the identical response for the same key + body without double-decrementing inventory', async () => {
      const startReserved = (await counters(concurrentTierId)).reserved;
      const first = await reserve({ tierId: concurrentTierId, quantity: 1 }, 'replay-key-000001');
      expect(first.status).toBe(201);
      const reservedAfterFirst = (await counters(concurrentTierId)).reserved;

      const replay = await reserve({ tierId: concurrentTierId, quantity: 1 }, 'replay-key-000001');
      expect(replay.status).toBe(201);
      expect(replay.headers['idempotent-replay']).toBe('true');
      expect(replay.body.data.id).toBe(first.body.data.id); // the very same reservation
      expect((await counters(concurrentTierId)).reserved).toBe(reservedAfterFirst); // not decremented again
      expect((await counters(concurrentTierId)).reserved).toBe(startReserved + 1);
      expect(await invariantViolations()).toEqual([]);
    });

    it('rejects the same key with a different body as idempotency_key_reuse (409)', async () => {
      await reserve({ tierId, quantity: 1 }, 'reuse-key-0000001');
      const res = await reserve({ tierId, quantity: 2 }, 'reuse-key-0000001');
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('idempotency_key_reuse');
    });

    it('two concurrent same-key requests produce exactly one reservation', async () => {
      const key = 'concurrent-same-key-1';
      const tier = concurrentTierId;
      const before = await countOf(
        `SELECT COUNT(*)::text AS n FROM reservations WHERE tier_id = $1 AND user_id = $2`,
        [tier, customerId],
      );

      const [a, b] = await Promise.all([
        reserve({ tierId: tier, quantity: 1 }, key),
        reserve({ tierId: tier, quantity: 1 }, key),
      ]);

      // Both succeed with the same reservation: one executed (201), the other replayed it (201).
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.data.id).toBe(b.body.data.id);

      const after = await countOf(
        `SELECT COUNT(*)::text AS n FROM reservations WHERE tier_id = $1 AND user_id = $2`,
        [tier, customerId],
      );
      expect(after - before).toBe(1); // exactly one new reservation, never two
      expect(await invariantViolations()).toEqual([]);
    });
  });

  describe('cancellation returns inventory', () => {
    it('cancels a PENDING reservation, releases its seats, and is idempotent by resource', async () => {
      const created = await reserve({ tierId, quantity: 3 }, 'cancel-flow-000001');
      const id = created.body.data.id as string;
      expect((await counters(tierId)).reserved).toBeGreaterThanOrEqual(3);

      const canceled = await request(app)
        .post(`/api/v1/reservations/${id}/cancel`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'cancel-flow-000002')
        .send();
      expect(canceled.status).toBe(200);
      expect(canceled.body.data.status).toBe('CANCELED');

      // Canceling again (new key) is a no-op success, not an invalid transition.
      const recancel = await request(app)
        .post(`/api/v1/reservations/${id}/cancel`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'cancel-flow-000003')
        .send();
      expect(recancel.status).toBe(200);
      expect(recancel.body.data.status).toBe('CANCELED');

      expect(await invariantViolations()).toEqual([]);
    });
  });

  describe('checkout (fake payment)', () => {
    it('success confirms: reserved -> sold, booking CONFIRMED, one payment attempt, invariants hold', async () => {
      const created = await reserve({ tierId, quantity: 2 }, 'checkout-success-res');
      const reservationId = created.body.data.id as string;

      const res = await request(app)
        .post(`/api/v1/reservations/${reservationId}/checkout`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'checkout-success-key')
        .send({ simulatedOutcome: 'success' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('CONFIRMED');
      expect(res.body.data.totalAmount).toBe('20.00'); // 2 x 10.00, computed server-side

      expect(
        await countOf(`SELECT COUNT(*)::text AS n FROM reservations WHERE id = $1 AND status = 'CONFIRMED'`, [reservationId]),
      ).toBe(1);
      expect(await countOf(`SELECT COUNT(*)::text AS n FROM payment_attempts WHERE status = 'SUCCEEDED'`)).toBeGreaterThanOrEqual(1);
      expect(await invariantViolations()).toEqual([]);
    });

    it('a declined payment fails the reservation and returns its seats to available', async () => {
      const created = await reserve({ tierId, quantity: 1 }, 'checkout-decline-res');
      const reservationId = created.body.data.id as string;
      const before = await counters(tierId);

      const res = await request(app)
        .post(`/api/v1/reservations/${reservationId}/checkout`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'checkout-decline-key')
        .send({ simulatedOutcome: 'failure' });
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('FAILED');

      const after = await counters(tierId);
      expect(after.available).toBe(before.available + 1);
      expect(after.reserved).toBe(before.reserved - 1);
      expect(await invariantViolations()).toEqual([]);
    });

    it('a timeout leaves the hold PENDING and answers 202 (no money marked settled)', async () => {
      const created = await reserve({ tierId, quantity: 1 }, 'checkout-timeout-res');
      const reservationId = created.body.data.id as string;

      const res = await request(app)
        .post(`/api/v1/reservations/${reservationId}/checkout`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'checkout-timeout-key')
        .send({ simulatedOutcome: 'timeout' });
      expect(res.status).toBe(202);
      expect(res.body.data.status).toBe('PENDING');

      // No booking for a timed-out checkout.
      expect(
        await countOf(`SELECT COUNT(*)::text AS n FROM bookings WHERE reservation_id = $1`, [reservationId]),
      ).toBe(0);
      expect(await invariantViolations()).toEqual([]);
    });

    it('a successful payment that arrives after expiry never resurrects inventory — it is reconciled', async () => {
      const created = await reserve({ tierId, quantity: 1 }, 'expire-checkout-res', customerToken);
      const reservationId = created.body.data.id as string;
      // Force the deadline into the past deterministically (the app compares against DB time).
      await db.query(`UPDATE reservations SET expires_at = app.now() - interval '1 second' WHERE id = $1`, [reservationId]);
      const before = await counters(tierId);

      const res = await request(app)
        .post(`/api/v1/reservations/${reservationId}/checkout`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'expire-checkout-key')
        .send({ simulatedOutcome: 'success' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('reservation_not_confirmable');

      // The reservation was expired and its seats returned; no booking was created.
      expect(
        await countOf(`SELECT COUNT(*)::text AS n FROM reservations WHERE id = $1 AND status = 'EXPIRED'`, [reservationId]),
      ).toBe(1);
      expect(await countOf(`SELECT COUNT(*)::text AS n FROM bookings WHERE reservation_id = $1`, [reservationId])).toBe(0);

      // A reconciliation finding records the discrepancy for manual resolution.
      expect(
        await countOf(
          `SELECT COUNT(*)::text AS n FROM reconciliation_findings WHERE kind = 'payment_after_expiry' AND reservation_id = $1`,
          [reservationId],
        ),
      ).toBe(1);

      const after = await counters(tierId);
      expect(after.available).toBe(before.available + 1);
      expect(after.reserved).toBe(before.reserved - 1);
      expect(await invariantViolations()).toEqual([]);
    });
  });

  describe('booking reads', () => {
    it('exposes a confirmed booking to its owner via /me/bookings and /bookings/:id, and to no one else', async () => {
      const created = await reserve({ tierId, quantity: 1 }, 'booking-read-res');
      const reservationId = created.body.data.id as string;
      const checkout = await request(app)
        .post(`/api/v1/reservations/${reservationId}/checkout`)
        .set('Authorization', customerToken)
        .set('Idempotency-Key', 'booking-read-check')
        .send({ simulatedOutcome: 'success' });
      const bookingId = checkout.body.data.id as string;

      const list = await request(app).get('/api/v1/me/bookings').set('Authorization', customerToken);
      expect(list.status).toBe(200);
      expect((list.body.data as { id: string }[]).map((b) => b.id)).toContain(bookingId);

      const single = await request(app).get(`/api/v1/bookings/${bookingId}`).set('Authorization', customerToken);
      expect(single.status).toBe(200);
      expect(single.body.data.reservationId).toBe(reservationId);

      const forbidden = await request(app).get(`/api/v1/bookings/${bookingId}`).set('Authorization', otherToken);
      expect(forbidden.status).toBe(403);
    });
  });
});

/** Ready-to-use `Authorization` header for a real (seeded) user id, so reservation FKs hold. */
function bearer(userId: string, email: string): string {
  const token = issueToken({ id: userId, email, role: 'CUSTOMER' }, testConfig().AUTH_SECRET, 3600);
  return `Bearer ${token}`;
}
