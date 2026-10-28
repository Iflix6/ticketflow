import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Queue } from 'bullmq';
import pg from 'pg';
import type { Database } from '../../apps/api/src/db/pool.js';
import { BullMQDispatcher, createQueues, dispatchJobId, redisOptionsFromUrl, startWorkers } from '../../apps/worker/src/queues.js';
import type { OutboxJobData } from '../../apps/worker/src/outbox.js';
import { relayOnce } from '../../apps/worker/src/outbox.js';
import type { Pool } from '../../apps/worker/src/db.js';
import {
  databaseAvailable,
  seedCatalog,
  seedUser,
  startTestDatabase,
  type TestDatabaseHandle,
} from '../helpers/integration-db.js';
import { redisAvailable, redisUrl } from '../helpers/integration-redis.js';

/**
 * The genuine article: the REAL BullMQ dispatcher and workers against a REAL Redis and a REAL
 * PostgreSQL. Gated on both — when Redis is missing every test SKIPS itself at runtime (honest skip,
 * never a vacuous pass). Each run uses a unique key prefix and obliterates it on teardown, so
 * concurrent developers and CI shards never share queue state.
 *
 * This is the Phase 4 gate proved end to end: restart-safe delivery, duplicate delivery as a no-op,
 * retry-then-success, and dead-lettering of an unresolvable job.
 */
const suite = databaseAvailable() ? describe : describe.skip;
const redisState: { ok: boolean } = { ok: false };
const MAX_ATTEMPTS = 3;

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let done = false;
  while (!done && Date.now() < deadline) {
    done = await predicate();
    if (!done) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!done) throw new Error('condition not met within the timeout');
}

suite('Phase 4 — worker recovery with real Redis + BullMQ', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let pool: Pool;
  let queues: ReturnType<typeof createQueues>;
  let dispatcher: BullMQDispatcher;
  let workers: ReturnType<typeof startWorkers>;
  let userId: string;
  const prefix = `tf4-${process.pid}-${Math.floor(Math.random() * 1_000_000)}`;

  /** Notification audit rows for one outbox event — the exactly-once-effect witness. */
  const auditCount = async (outboxId: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_records
        WHERE action = 'notification.dispatched' AND metadata->>'outboxId' = $1`,
      [outboxId],
    );
    return Number(rows[0]?.n ?? '0');
  };

  const consumedCount = async (outboxId: string): Promise<number> => {
    const { rows } = await db.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM consumed_events WHERE outbox_id::text = $1',
      [outboxId],
    );
    return Number(rows[0]?.n ?? '0');
  };

  // 'booking.confirmed' deliberately avoids the reservation.created fast path, so each assertion
  // describes THIS event only and nothing the expiry worker might also do.
  const jobData = (outboxId: string): OutboxJobData => ({
    outboxId,
    eventType: 'booking.confirmed',
    aggregateType: 'booking',
    aggregateId: userId,
    payload: { seeded: true },
  });

  const insertOutboxRow = async (): Promise<string> => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('booking.confirmed', 'booking', $1::uuid, '{}'::jsonb)
       RETURNING id::text AS id`,
      [userId],
    );
    const id = rows[0]?.id;
    if (id === undefined) throw new Error('outbox insert returned no row');
    return id;
  };

  const counters = async (tierId: string): Promise<{ available: number; reserved: number; sold: number }> => {
    const { rows } = await db.query<{ available: number; reserved: number; sold: number }>(
      'SELECT available, reserved, sold FROM inventory WHERE tier_id = $1',
      [tierId],
    );
    return rows[0] ?? { available: -1, reserved: -1, sold: -1 };
  };

  beforeAll(async () => {
    handle = await startTestDatabase('worker_recovery');
    db = handle.db;
    const admin = new URL(handle.adminUrl);
    admin.pathname = `/${handle.databaseName}`;
    pool = new pg.Pool({ connectionString: admin.toString(), max: 10 });
    userId = await seedUser(db, 'recovery-customer@load.test');

    redisState.ok = await redisAvailable();
    if (!redisState.ok) return;

    const connection = redisOptionsFromUrl(redisUrl());
    queues = createQueues(connection, MAX_ATTEMPTS, prefix);
    dispatcher = new BullMQDispatcher(queues.dispatch);
    workers = startWorkers(queues, connection, pool, {
      concurrency: 2,
      maxAttempts: MAX_ATTEMPTS,
      log: () => undefined,
      prefix,
    });
    await workers.dispatch.waitUntilReady();
    await workers.expiry.waitUntilReady();
  });

  afterAll(async () => {
    if (redisState.ok) {
      await workers.close().catch(() => undefined);
      // Leave no trace in the shared Redis: obliterate removes every key under this run's prefix.
      await Promise.all(
        [queues.dispatch, queues.expiry, queues.dispatchDead, queues.expiryDead].map((q) =>
          q.obliterate({ force: true }).catch(() => undefined),
        ),
      );
      await queues.close();
    }
    await pool.end();
    await handle.cleanup();
  });

  it('real relay + BullMQ delivery: the worker handles the event exactly once', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    const outboxId = await insertOutboxRow();

    const summary = await relayOnce(pool, dispatcher, { batchSize: 50 });
    expect(summary.published).toBeGreaterThanOrEqual(1);

    await waitUntil(async () => (await consumedCount(outboxId)) === 1);
    await new Promise((resolve) => setTimeout(resolve, 500)); // settle window for a stray redelivery
    expect(await auditCount(outboxId)).toBe(1);
  });

  it('dispatcher job-id dedup: a pending job is never queued twice by the relay', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    // A queue that NO worker drains, to isolate the transport's own dedup window — which is exactly
    // the window the relay's crash-between-dispatch-and-mark retries live in.
    const probe = new Queue<OutboxJobData>('relay-dedup-probe', { connection: redisOptionsFromUrl(redisUrl()), prefix });
    const probeDispatcher = new BullMQDispatcher(probe);
    try {
      await probeDispatcher.dispatch(jobData('555001'));
      await probeDispatcher.dispatch(jobData('555001'));
      expect(await probe.getJobCountByTypes('waiting')).toBe(1); // two dispatches, one unit of work
    } finally {
      await probe.obliterate({ force: true }).catch(() => undefined);
      await probe.close();
    }
  });

  it('duplicate DELIVERY (new jobId, same event) is a consumer no-op', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    const outboxId = await insertOutboxRow();
    await relayOnce(pool, dispatcher, { batchSize: 50 });
    await waitUntil(async () => (await auditCount(outboxId)) === 1);

    // Force a second real delivery the way at-least-once semantics would: a DISTINCT jobId makes
    // BullMQ run it again, and only the consumed_events marker can stop the effect from repeating.
    await queues.dispatch.add('outbox', jobData(outboxId), { jobId: `dup-${prefix}-${outboxId}` });
    await waitUntil(async () => (await consumedCount(outboxId)) === 1);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await auditCount(outboxId)).toBe(1);
    expect(await consumedCount(outboxId)).toBe(1);
  });

  it('relay re-dispatch with the SAME job id creates no second run while the record is retained', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    // The exact crash window: dispatch succeeded, the mark rolled back, and the relay retries AFTER the
    // consumer already finished. Measured behavior (BullMQ 6.5): as long as the job record still exists
    // — bounded by jobDefaults retention — re-adding the same id creates no second run at all. This is
    // what keeps a retry storm from multiplying work; the consumer marker is the backstop beyond it.
    const outboxId = await insertOutboxRow();
    await relayOnce(pool, dispatcher, { batchSize: 50 });
    await waitUntil(async () => (await auditCount(outboxId)) === 1);

    const jobId = dispatchJobId(outboxId);
    const first = await queues.dispatch.getJob(jobId);
    const completedBefore = await queues.dispatch.getJobCountByTypes('completed');

    await dispatcher.dispatch(jobData(outboxId)); // the relay's second tick for the same row
    await new Promise((resolve) => setTimeout(resolve, 800));

    const again = await queues.dispatch.getJob(jobId);
    expect(await queues.dispatch.getJobCountByTypes('completed')).toBe(completedBefore); // no new job
    expect(again?.processedOn).toBe(first?.processedOn); // and the same single run, not a re-run
    expect(await queues.dispatch.getJobCountByTypes('waiting', 'delayed', 'active')).toBe(0);
    expect(await auditCount(outboxId)).toBe(1);
    expect(await consumedCount(outboxId)).toBe(1);
  });

  it('retry-then-success: a transient failure is retried and the effect lands exactly once', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    // The job points at an outbox id that does not exist YET, so the consumed_events foreign key
    // rejects attempt 1. The row appears as soon as that attempt is recorded as failed, so the next
    // attempt succeeds — a real transient fault resolved by the retry budget, with no manual replay.
    // (Waiting on `attemptsMade` rather than sleeping keeps this honest under backoff jitter.)
    const outboxId = '999999';
    const jobId = `retry-${prefix}-${outboxId}`;
    await queues.dispatch.add('outbox', jobData(outboxId), { jobId });
    await waitUntil(async () => {
      const job = await queues.dispatch.getJob(jobId);
      return (job?.attemptsMade ?? 0) >= 1;
    });
    await db.query(
      `INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, payload)
       OVERRIDING SYSTEM VALUE
       VALUES (999999, 'booking.confirmed', 'booking', $1::uuid, '{}'::jsonb)`,
      [userId],
    );

    await waitUntil(async () => (await auditCount(outboxId)) === 1);
    expect(await consumedCount(outboxId)).toBe(1);
    const recovered = await queues.dispatch.getJob(jobId);
    expect(recovered?.attemptsMade).toBeGreaterThanOrEqual(1); // one failure recorded, then completed
    expect(await recovered?.getState()).toBe('completed');
    expect(await queues.dispatch.getJobCountByTypes('failed')).toBe(0); // and recovered, never parked
  });

  it('dead-letter: an unresolvable job exhausts retries and parks in the dead queue', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    // 123456 is never created, so EVERY attempt fails on the foreign key: the poison message must be
    // parked for inspection instead of burning CPU forever.
    const jobId = `dead-${prefix}-123456`;
    await queues.dispatch.add('outbox', jobData('123456'), { jobId });

    await waitUntil(async () => (await queues.dispatchDead.getJobCountByTypes('waiting')) >= 1);
    const stored = await queues.dispatch.getJob(jobId);
    expect(stored?.attemptsMade).toBe(MAX_ATTEMPTS);
    expect(stored?.data.outboxId).toBe('123456');

    // Failed forever means NO effect ever landed — the transaction rolled back, no partial write.
    expect(await auditCount('123456')).toBe(0);
    expect(await consumedCount('123456')).toBe(0);
  });

  it('restart safety: a job queued while the worker is down is processed after restart', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    await workers.close(); // the worker process dies; Redis keeps the job durably

    const outboxId = await insertOutboxRow();
    await queues.dispatch.add('outbox', jobData(outboxId), { jobId: `restart-${prefix}-${outboxId}` });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await auditCount(outboxId)).toBe(0); // nothing was processed while down

    workers = startWorkers(queues, redisOptionsFromUrl(redisUrl()), pool, {
      concurrency: 2,
      maxAttempts: MAX_ATTEMPTS,
      log: () => undefined,
      prefix,
    });
    await waitUntil(async () => (await auditCount(outboxId)) === 1);
    expect(await consumedCount(outboxId)).toBe(1);
  });

  it('expiry fast path: a queue job expires its hold and releases the seat exactly once', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    const { tierId } = await seedCatalog(db, `recover-${prefix}`, 'Pit', 5);
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO reservations (user_id, tier_id, quantity, status, expires_at)
       VALUES ($1::uuid, $2::uuid, 1, 'PENDING', app.now() - interval '1 minute')
       RETURNING id::text AS id`,
      [userId, tierId],
    );
    const reservationId = rows[0]?.id;
    if (reservationId === undefined) throw new Error('reservation insert returned no row');
    await db.query(
      `UPDATE inventory SET available = available - 1, reserved = reserved + 1, version = version + 1
        WHERE tier_id = $1::uuid AND available >= 1`,
      [tierId],
    );
    expect(await counters(tierId)).toMatchObject({ available: 4, reserved: 1 });

    await queues.expiry.add('expire', { reservationId }, { jobId: `exp-${prefix}-${reservationId}` });
    await waitUntil(async () => {
      const { rows: status } = await db.query<{ status: string }>(
        'SELECT status FROM reservations WHERE id = $1',
        [reservationId],
      );
      return status[0]?.status === 'EXPIRED';
    });
    expect(await counters(tierId)).toMatchObject({ available: 5, reserved: 0 });

    // A second delivery of the same expiry job must not release the seat twice.
    await queues.expiry.add('expire', { reservationId }, { jobId: `exp2-${prefix}-${reservationId}` });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await counters(tierId)).toMatchObject({ available: 5, reserved: 0 });
  });

  it('invariant views stay clean after the whole recovery exercise', async (ctx) => {
    if (!redisState.ok) return ctx.skip();
    const { rows } = await db.query<{ invariant: string }>('SELECT invariant FROM app.invariant_violations');
    expect(rows.map((r) => r.invariant)).toEqual([]);
  });
});
