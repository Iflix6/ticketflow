import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Database } from '../../apps/api/src/db/pool.js';
import type { Dispatcher, OutboxJobData } from '../../apps/worker/src/outbox.js';
import { outboxBacklog, relayOnce } from '../../apps/worker/src/outbox.js';
import { expireOneReservation, processOutboxJob } from '../../apps/worker/src/consumers.js';
import { reconcile, resolveStaleFindings } from '../../apps/worker/src/reconciliation.js';
import type { Pool } from '../../apps/worker/src/db.js';
import {
  databaseAvailable,
  seedCatalog,
  seedUser,
  startTestDatabase,
  type TestDatabaseHandle,
} from '../helpers/integration-db.js';

// Honest skip: no real PostgreSQL means this suite reports skipped, never falsely green.
const suite = databaseAvailable() ? describe : describe.skip;

/**
 * In-memory transport double with the SAME contract BullMQ enforces: a deterministic job id derived
 * from the outbox id means a still-pending job is never duplicated. With this seam the relay's
 * restart-safety and duplicate-safety proofs are Postgres-only and deterministic — the real BullMQ
 * round trip, including where its dedup window ENDS, is covered in `worker-recovery.test.ts`.
 */
class SpyDispatcher implements Dispatcher {
  readonly jobs: OutboxJobData[] = [];
  failNext = false;

  async dispatch(job: OutboxJobData): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('simulated transport failure');
    }
    if (this.jobs.some((existing) => existing.outboxId === job.outboxId)) return; // deduped: no new work
    this.jobs.push(job);
  }
}

suite('Phase 4 — outbox relay and idempotent consumers (fault injection)', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let pool: Pool;
  let dispatcher: SpyDispatcher;
  let tierId: string;
  let userId: string;

  /** Inserts a genuine outbox row (same shape the reservation service writes) and returns its id. */
  const emitOutbox = async (reservationId: string): Promise<string> => {
    const result = await db.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('reservation.created', 'reservation', $1::uuid, $2::jsonb)
       RETURNING id::text AS id`,
      [reservationId, JSON.stringify({ tierId, quantity: 1 })],
    );
    const id = result.rows[0]?.id;
    if (id === undefined) throw new Error('outbox insert returned no row');
    return id;
  };

  /** A PENDING hold with a not-yet-due deadline, counters moved consistently. */
  const holdSeat = async (): Promise<string> => {
    const reservationId = (await db.query<{ id: string }>('SELECT app.new_id()::text AS id')).rows[0]?.id;
    if (reservationId === undefined) throw new Error('no id');
    await db.query(
      `INSERT INTO reservations (id, user_id, tier_id, quantity, status, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'PENDING', app.now() + interval '1 hour')`,
      [reservationId, userId, tierId],
    );
    await db.query(
      `UPDATE inventory SET available = available - 1, reserved = reserved + 1, version = version + 1
        WHERE tier_id = $1::uuid AND available >= 1`,
      [tierId],
    );
    return reservationId;
  };

  const isPublished = async (outboxId: string): Promise<boolean> => {
    const { rows } = await db.query<{ published: boolean }>(
      'SELECT published_at IS NOT NULL AS published FROM outbox_events WHERE id::text = $1',
      [outboxId],
    );
    return rows[0]?.published === true;
  };

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

  const toJob = async (outboxId: string): Promise<OutboxJobData> => {
    const { rows } = await db.query<{ event_type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> }>(
      `SELECT event_type, aggregate_type, aggregate_id::text AS aggregate_id, payload
         FROM outbox_events WHERE id::text = $1`,
      [outboxId],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`outbox row ${outboxId} vanished`);
    return { outboxId, eventType: row.event_type, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, payload: row.payload };
  };

  const violations = async (): Promise<string[]> => {
    const { rows } = await db.query<{ invariant: string }>('SELECT invariant FROM app.invariant_violations');
    return rows.map((r) => r.invariant);
  };

  beforeAll(async () => {
    handle = await startTestDatabase('outbox_relay');
    db = handle.db;
    // Second pool: how the worker PROCESS would connect — same database, its own clients.
    const admin = new URL(handle.adminUrl);
    admin.pathname = `/${handle.databaseName}`;
    pool = new pg.Pool({ connectionString: admin.toString(), max: 5 });
    dispatcher = new SpyDispatcher();
    tierId = (await seedCatalog(db, 'relay-concert', 'Balcony', 50)).tierId;
    userId = await seedUser(db, 'relay-customer@load.test');
  });

  afterAll(async () => {
    await pool.end();
    await handle.cleanup();
  });

  it('relay claims a batch, dispatches each job once, and marks rows published', async () => {
    const ids = [await holdSeat(), await holdSeat(), await holdSeat()];
    const outboxIds = await Promise.all(ids.map((reservationId) => emitOutbox(reservationId)));

    const summary = await relayOnce(pool, dispatcher, { batchSize: 20 });
    expect(summary).toEqual({ claimed: 3, published: 3, failed: 0 });
    for (const outboxId of outboxIds) {
      expect(await isPublished(outboxId)).toBe(true);
    }
    expect(dispatcher.jobs.map((job) => job.outboxId).sort()).toEqual([...outboxIds].sort());
    expect((await outboxBacklog(pool)).unpublished).toBe(0);
  });

  it('batchSize caps a tick and the backlog drains across ticks (oldest first)', async () => {
    const older = await emitOutbox(await holdSeat());
    const newer = await emitOutbox(await holdSeat());

    const first = await relayOnce(pool, dispatcher, { batchSize: 1 });
    expect(first.claimed).toBe(1); // the tick never runs ahead of its configured batch
    const backlog = await outboxBacklog(pool);
    expect(backlog.unpublished).toBe(1);
    expect(backlog.oldestAgeSeconds).not.toBeNull();
    expect(await isPublished(older)).toBe(true); // ORDER BY id: the identity makes "oldest" deterministic
    expect(await isPublished(newer)).toBe(false);

    const second = await relayOnce(pool, dispatcher, { batchSize: 1 });
    expect(second.claimed).toBe(1);
    expect(await isPublished(newer)).toBe(true);
    expect((await outboxBacklog(pool)).unpublished).toBe(0);
  });

  it('re-running the relay over published rows is a no-op — nothing re-dispatched, nothing lost', async () => {
    const before = dispatcher.jobs.length;
    const summary = await relayOnce(pool, dispatcher, { batchSize: 20 });
    expect(summary.claimed).toBe(0);
    expect(dispatcher.jobs.length).toBe(before);
  });

  it('RESTART SAFETY: crash after dispatch but before mark redelivers the SAME job and loses nothing', async () => {
    const reservationId = await holdSeat();
    const outboxId = await emitOutbox(reservationId);
    const before = dispatcher.jobs.length;

    // Simulate the worker being killed at the worst possible instant: the transport HAS the job,
    // but the relay dies before marking — so the transaction rolls back and the row stays unpublished.
    let crashed = false;
    await expect(
      relayOnce(pool, dispatcher, {
        batchSize: 20,
        fault: { beforeMark: () => { crashed = true; throw new Error('simulated crash after dispatch, before mark'); } },
      }),
    ).rejects.toThrow('simulated crash');
    expect(crashed).toBe(true);
    expect(await isPublished(outboxId)).toBe(false);
    expect(dispatcher.jobs.length).toBe(before + 1); // the job DID reach the transport

    // "Restart": the next tick re-claims the still-unpublished row and re-dispatches with the SAME
    // job id — the transport refuses to duplicate it, so no second job ever enters the world.
    const retry = await relayOnce(pool, dispatcher, { batchSize: 20 });
    expect(retry.claimed).toBe(1);
    expect(retry.published).toBe(1);
    expect(dispatcher.jobs.length).toBe(before + 1); // still exactly one job for this event
    expect(await isPublished(outboxId)).toBe(true);
  });

  it('transient dispatch failure keeps the event unpublished and recovers on the next tick', async () => {
    const reservationId = await holdSeat();
    const outboxId = await emitOutbox(reservationId);

    dispatcher.failNext = true;
    const failed = await relayOnce(pool, dispatcher, { batchSize: 20 });
    expect(failed.failed).toBe(1);
    expect(await isPublished(outboxId)).toBe(false);

    const recovered = await relayOnce(pool, dispatcher, { batchSize: 20 });
    expect(recovered.published).toBe(1);
    expect(await isPublished(outboxId)).toBe(true);
    const { rows } = await db.query<{ published: string | null }>(
      'SELECT published_at::text AS published FROM outbox_events WHERE id::text = $1',
      [outboxId],
    );
    expect(rows[0]?.published).not.toBeNull();
  });

  it('duplicate delivery to the consumer is an idempotent no-op (exactly-once effect)', async () => {
    const reservationId = await holdSeat();
    const outboxId = await emitOutbox(reservationId);
    const job = await toJob(outboxId);

    const first = await processOutboxJob(pool, job);
    expect(first).toEqual({ handled: true, duplicate: false });
    const second = await processOutboxJob(pool, job);
    expect(second).toEqual({ handled: false, duplicate: true });

    expect(await auditCount(outboxId)).toBe(1);
    expect(await consumedCount(outboxId)).toBe(1);
  });

  it('consumer fault AFTER marker+effect but BEFORE commit rolls back both — retry applies exactly once', async () => {
    const reservationId = await holdSeat();
    const outboxId = await emitOutbox(reservationId);
    const job = await toJob(outboxId);

    // The classic consumer bug: if the marker committed but the effect rolled back (or vice versa),
    // the retry would skip work it never finished. Same-transaction writes make that impossible.
    await expect(
      processOutboxJob(pool, job, { fault: () => { throw new Error('simulated crash before commit'); } }),
    ).rejects.toThrow('simulated crash');
    expect(await consumedCount(outboxId)).toBe(0);
    expect(await auditCount(outboxId)).toBe(0);

    const retry = await processOutboxJob(pool, job);
    expect(retry.handled).toBe(true);
    expect(await auditCount(outboxId)).toBe(1);
    expect(await consumedCount(outboxId)).toBe(1);
  });

  it('expiry fast path fires once per new hold and never on redelivery', async () => {
    const reservationId = await holdSeat();
    const outboxId = await emitOutbox(reservationId);
    const job = await toJob(outboxId);
    const scheduled: string[] = [];

    await processOutboxJob(pool, job, { onReservationCreated: async (id) => { scheduled.push(id); } });
    await processOutboxJob(pool, job, { onReservationCreated: async (id) => { scheduled.push(id); } });
    expect(scheduled).toEqual([reservationId]);
  });

  it('expireOneReservation only expires PENDING holds that are actually due', async () => {
    const notDue = await holdSeat();
    expect(await expireOneReservation(pool, notDue)).toBe(false);

    const { rows } = await db.query<{ n: string }>(
      `UPDATE reservations SET expires_at = app.now() - interval '1 second'
        WHERE id = $1::uuid AND status = 'PENDING' RETURNING 1 AS n`,
      [notDue],
    );
    expect(rows.length).toBe(1);

    expect(await expireOneReservation(pool, notDue)).toBe(true);
    expect(await expireOneReservation(pool, notDue)).toBe(false); // already terminal — no-op
    expect(await violations()).toEqual([]);
  });

  it('reconciliation flags a stale unpublished event, and self-resolves once the relay publishes it', async () => {
    const reservationId = await holdSeat();
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, created_at)
       VALUES ('reservation.created', 'reservation', $1::uuid, app.now() - interval '2 hours')
       RETURNING id::text AS id`,
      [reservationId],
    );
    const staleId = rows[0]?.id;
    if (staleId === undefined) throw new Error('stale outbox insert returned no row');

    const findings = await reconcile(pool, { stuckThresholdSeconds: 60 });
    expect(findings.outboxStuck).toBe(1);
    // Idempotent: a second pass must not spam a duplicate unresolved finding for the same subject.
    expect((await reconcile(pool, { stuckThresholdSeconds: 60 })).outboxStuck).toBe(0);

    await relayOnce(pool, dispatcher, { batchSize: 20 });
    expect(await isPublished(staleId)).toBe(true);
    expect(await resolveStaleFindings(pool)).toBe(1);

    const { rows: open } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM reconciliation_findings
        WHERE kind = 'outbox_stuck' AND resolved_at IS NULL AND detail->>'outboxId' = $1`,
      [staleId],
    );
    expect(Number(open[0]?.n ?? '1')).toBe(0);
  });

  it('invariant views stay clean through the whole relay/consumer exercise', async () => {
    expect(await violations()).toEqual([]);
    const { rows } = await db.query<{ available: number; reserved: number; sold: number; capacity: number }>(
      'SELECT available, reserved, sold, capacity FROM inventory WHERE tier_id = $1',
      [tierId],
    );
    const inventory = rows[0];
    expect(inventory).toBeDefined();
    expect((inventory?.available ?? 0) + (inventory?.reserved ?? 0) + (inventory?.sold ?? 0)).toBe(inventory?.capacity);
  });
});
