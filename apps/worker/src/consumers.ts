import type { Client, Pool } from './db.js';
import { withTransaction } from './db.js';
import type { OutboxJobData } from './outbox.js';

/**
 * Idempotent consumers (ADR-0005). At-least-once delivery from the queue becomes an exactly-once
 * EFFECT because the dedup marker (`consumed_events`) and the side effect are written in the SAME
 * transaction. If the handler throws after the marker, the transaction rolls the marker back too, so a
 * retry re-runs cleanly instead of skipping work it never finished — the classic outbox-consumer bug.
 */

export const NOTIFICATION_CONSUMER = 'notifications';

/** Claims this (consumer, outbox_id). `true` = first time (caller proceeds); `false` = redelivery (no-op). */
export async function claimConsumption(client: Client, consumer: string, outboxId: string): Promise<boolean> {
  const result = await client.query(
    'INSERT INTO consumed_events (consumer, outbox_id) VALUES ($1, $2::bigint) ON CONFLICT DO NOTHING',
    [consumer, outboxId],
  );
  return (result.rowCount ?? 0) > 0;
}

export type ProcessResult = { handled: boolean; duplicate: boolean };

/**
 * Handles one relayed outbox job: dedup + record the notification as an audit row in one transaction,
 * then (only on first handling) best-effort schedule the delayed expiry fast path for a new hold. The
 * scheduling is outside the transaction because it touches Redis; it is best-effort by design — if it
 * is lost the periodic sweeper still expires the hold, so correctness never rides on the queue.
 */
export async function processOutboxJob(
  pool: Pool,
  job: OutboxJobData,
  hooks: {
    fault?: () => void;
    onReservationCreated?: (reservationId: string) => Promise<void>;
  } = {},
): Promise<ProcessResult> {
  const firstTime = await withTransaction(pool, async (client) => {
    const claimed = await claimConsumption(client, NOTIFICATION_CONSUMER, job.outboxId);
    if (!claimed) return false;
    await client.query(
      `INSERT INTO audit_records (actor_kind, action, aggregate_type, aggregate_id, metadata)
       VALUES ('worker', 'notification.dispatched', $1, $2::uuid, $3::jsonb)`,
      [job.aggregateType, job.aggregateId, JSON.stringify({ eventType: job.eventType, outboxId: job.outboxId })],
    );
    // Fault AFTER the marker+effect are written but BEFORE commit: rollback must undo BOTH so a retry
    // re-applies exactly once. Proving this is the point of the recovery test.
    hooks.fault?.();
    return true;
  });

  if (firstTime && job.eventType === 'reservation.created') {
    await hooks.onReservationCreated?.(job.aggregateId).catch(() => undefined);
  }
  return { handled: firstTime, duplicate: !firstTime };
}

/**
 * Fast-path expiry of a single reservation (used by the delayed queue consumer). Mirrors the sweeper's
 * guard exactly — PENDING and past the DB-clock deadline — so a job that races the sweeper is a no-op.
 */
export async function expireOneReservation(pool: Pool, reservationId: string): Promise<boolean> {
  return withTransaction(pool, async (client) => {
    const locked = await client.query<{ status: string; tier_id: string; quantity: number; expires_at: Date }>(
      `SELECT status, tier_id::text AS tier_id, quantity, expires_at FROM reservations WHERE id = $1::uuid FOR UPDATE`,
      [reservationId],
    );
    const row = locked.rows[0];
    if (row === undefined || row.status !== 'PENDING') return false;
    const expired = await client.query(
      `UPDATE reservations SET status = 'EXPIRED', expired_at = app.now()
        WHERE id = $1::uuid AND status = 'PENDING' AND expires_at <= app.now()
        RETURNING id`,
      [reservationId],
    );
    if ((expired.rowCount ?? 0) === 0) return false;
    await client.query(
      `UPDATE inventory SET available = available + $2, reserved = reserved - $2, version = version + 1
        WHERE tier_id = $1::uuid AND reserved >= $2`,
      [row.tier_id, row.quantity],
    );
    await client.query(
      `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
       VALUES ('reservation.expired', 'reservation', $1::uuid, $2::jsonb)`,
      [reservationId, JSON.stringify({ tierId: row.tier_id, quantity: row.quantity, status: 'EXPIRED' })],
    );
    return true;
  });
}
