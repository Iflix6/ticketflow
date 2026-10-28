import type { Pool } from './db.js';
import { withTransaction } from './db.js';

/**
 * Reconciliation sweeper. Its job is to make disagreement between the queue world and the database
 * TRUTH observable — it never silently "fixes" inventory, because a reconciler that mutates counters
 * is exactly how a lost-update bug gets laundered into looking consistent. It records findings into
 * `reconciliation_findings` (already modelled in Phase 2) and lets humans/Phase-6 alerting act.
 *
 * Two findings it can raise:
 *  - `outbox_stuck`: an event has sat unpublished past a threshold — the relay is not keeping up or
 *    Redis is down (per the ADR degradation matrix, booking still works, but delivery is lagging).
 *  - `counter_mismatch`: the independent `app.counter_drift_violations` view (I4) reports reserved/sold
 *    counters that do not agree with the reservation rows — a genuine consistency break.
 *
 * Idempotent by `NOT EXISTS` on an unresolved finding of the same subject, so repeated sweeps do not
 * spam the table with duplicates.
 */
export type ReconcileResult = { outboxStuck: number; counterMismatch: number };

export async function reconcile(
  pool: Pool,
  options: { stuckThresholdSeconds: number },
): Promise<ReconcileResult> {
  return withTransaction(pool, async (client) => {
    const stuck = await client.query(
      `INSERT INTO reconciliation_findings (kind, detail)
       SELECT 'outbox_stuck', jsonb_build_object('outboxId', e.id::text, 'ageSeconds', age)
         FROM (
           SELECT id, FLOOR(EXTRACT(EPOCH FROM (app.now() - created_at)))::int AS age
             FROM outbox_events
            WHERE published_at IS NULL
              AND created_at <= app.now() - make_interval(secs => $1::int)
         ) e
        WHERE NOT EXISTS (
          SELECT 1 FROM reconciliation_findings f
           WHERE f.kind = 'outbox_stuck' AND f.resolved_at IS NULL AND f.detail->>'outboxId' = e.id::text
        )`,
      [options.stuckThresholdSeconds],
    );

    const drift = await client.query(
      `INSERT INTO reconciliation_findings (kind, tier_id, detail)
       SELECT 'counter_mismatch', v.tier_id, jsonb_build_object('reserved', v.reserved, 'pendingQty', v.pending_qty, 'sold', v.sold, 'confirmedQty', v.confirmed_qty)
         FROM app.counter_drift_violations v
        WHERE NOT EXISTS (
          SELECT 1 FROM reconciliation_findings f
           WHERE f.kind = 'counter_mismatch' AND f.resolved_at IS NULL AND f.tier_id = v.tier_id
        )`,
    );

    return { outboxStuck: stuck.rowCount ?? 0, counterMismatch: drift.rowCount ?? 0 };
  });
}

/** Marks a kind of finding resolved once its underlying condition clears, so the table reflects live state. */
export async function resolveStaleFindings(pool: Pool): Promise<number> {
  return withTransaction(pool, async (client) => {
    // outbox_stuck findings self-resolve the moment their event is published.
    const result = await client.query(
      `UPDATE reconciliation_findings f
          SET resolved_at = app.now()
        WHERE f.resolved_at IS NULL
          AND f.kind = 'outbox_stuck'
          AND EXISTS (
            SELECT 1 FROM outbox_events e
             WHERE e.id::text = f.detail->>'outboxId' AND e.published_at IS NOT NULL
          )`,
    );
    return result.rowCount ?? 0;
  });
}
