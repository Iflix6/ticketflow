import type { Pool } from './db.js';
import { withTransaction } from './db.js';

/**
 * The expiry sweeper — the CORRECTNESS path for hold deadlines (ADR-0005). The BullMQ delayed job is
 * only a latency optimization; if it never fires (Redis down, worker crashed), this periodic sweep still
 * expires every overdue PENDING hold and returns its seats. Correctness therefore never depends on a
 * timer firing on time.
 *
 * The batch flip and the per-tier release happen in ONE transaction, so the counters can never be left
 * observing a reservation that expired without its inventory coming back. The set-based UPDATE reuses
 * the exact predicate and `FOR UPDATE SKIP LOCKED` the API sweeper documents — two workers sweeping the
 * same database contend without blocking or double-releasing.
 */
export async function sweepExpiries(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    const flipped = await client.query<{ id: string; tier_id: string; quantity: number }>(
      `UPDATE reservations
          SET status = 'EXPIRED', expired_at = app.now()
        WHERE id IN (
          SELECT id FROM reservations
           WHERE status = 'PENDING' AND expires_at <= app.now()
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id::text AS id, tier_id::text AS tier_id, quantity`,
    );

    for (const row of flipped.rows) {
      await client.query(
        `UPDATE inventory
            SET available = available + $2, reserved = reserved - $2, version = version + 1
          WHERE tier_id = $1::uuid AND reserved >= $2`,
        [row.tier_id, row.quantity],
      );
      await client.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
         VALUES ('reservation.expired', 'reservation', $1::uuid, $2::jsonb)`,
        [row.id, JSON.stringify({ tierId: row.tier_id, quantity: row.quantity, status: 'EXPIRED' })],
      );
    }

    return flipped.rows.length;
  });
}
