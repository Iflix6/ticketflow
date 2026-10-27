import type { Queryable } from '../../db/pool.js';

/**
 * Reconciliation findings written inside the business transaction (spec §58: "a successful payment
 * after expiry must not resurrect inventory; record and reconcile the discrepancy").
 *
 * Phase 2 only *records* the discrepancy — the money is fake, so the "refund" is a documented,
 * inspectable row rather than an automated payout. The full reconciliation loop (auto-resolve,
 * duplicate/out-of-order callbacks, alerting) is Phase 4; what must not wait is the write itself,
 * because a finding created outside the reservation transaction could be lost on rollback and leave
 * the two systems silently disagreeing.
 */

export type ReconciliationKind =
  | 'payment_after_expiry'
  | 'duplicate_callback'
  | 'counter_mismatch'
  | 'reservation_counter_drift'
  | 'outbox_stuck';

export interface ReconciliationFinding {
  readonly kind: ReconciliationKind;
  readonly tierId: string | null;
  readonly reservationId: string | null;
  readonly detail: Record<string, unknown>;
}

export async function recordReconciliationFinding(
  client: Queryable,
  finding: ReconciliationFinding,
): Promise<void> {
  await client.query(
    `INSERT INTO reconciliation_findings (kind, tier_id, reservation_id, detail)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [finding.kind, finding.tierId, finding.reservationId, JSON.stringify(finding.detail)],
  );
}
