import type { Database, Queryable } from '../../db/pool.js';
import { appMetrics } from '../../observability/metrics.js';

/**
 * Independent invariant verification (spec: "Assert database invariants via independent SQL queries").
 *
 * The queries here read the *views created by migration 0009*, which are pure SQL and share no code
 * with the reservation path. That is what makes them admissible evidence: an application bug cannot
 * hide itself behind its own bookkeeping.
 */

export type InvariantViolationRow = {
  invariant: string;
  subject_id: string | null;
  observed: Record<string, unknown>;
};

export type InventorySnapshotRow = {
  tier_id: string;
  capacity: number;
  available: number;
  reserved: number;
  sold: number;
  version: number;
  pending_qty: string;
  confirmed_qty: string;
  live_qty: string;
  updated_at: Date;
};

export class InventoryInvariantQueries {
  constructor(private readonly db: Database) {}

  async violations(executor: Queryable = this.db): Promise<InvariantViolationRow[]> {
    const result = await executor.query<InvariantViolationRow>(
      `SELECT invariant, subject_id, observed FROM app.invariant_violations ORDER BY invariant, subject_id`,
    );
    return result.rows;
  }

  async snapshot(executor: Queryable = this.db): Promise<InventorySnapshotRow[]> {
    const result = await executor.query<InventorySnapshotRow>(
      `SELECT tier_id, capacity, available, reserved, sold, version,
              pending_qty, confirmed_qty, live_qty, updated_at
         FROM app.inventory_snapshot ORDER BY tier_id`,
    );
    return result.rows;
  }

  /** Lab fixture uses the same detector, so the unsafe baseline is judged by the same rule. */
  async labViolations(executor: Queryable = this.db): Promise<InvariantViolationRow[]> {
    const result = await executor.query<InvariantViolationRow>(
      `SELECT invariant, tier_id::text AS subject_id, to_jsonb(v) AS observed
         FROM lab.live_allocation_violations v ORDER BY tier_id`,
    );
    return result.rows;
  }

  /**
   * Returns a stable failure description for tests and `npm run verify`.
   * Throws instead of returning false: a silent boolean is how invariant checks get ignored.
   */
  async assertClean(scope: 'public' | 'lab' = 'public'): Promise<void> {
    const rows = scope === 'public' ? await this.violations() : await this.labViolations();
    if (rows.length > 0) {
      const summary = rows
        .slice(0, 5)
        .map((row) => `${row.invariant} on ${row.subject_id ?? '(unknown)'}: ${JSON.stringify(row.observed)}`)
        .join('; ');
      throw new Error(
        `Inventory invariants violated in ${scope} scope (${rows.length} row(s)): ${summary}`,
      );
    }
  }

  /** Publishes violation counts per invariant so a dashboard can alert on non-zero. */
  async recordMetrics(): Promise<void> {
    const rows = await this.violations();
    const byInvariant = new Map<string, number>();
    for (const row of rows) {
      byInvariant.set(row.invariant, (byInvariant.get(row.invariant) ?? 0) + 1);
    }
    for (const [invariant, count] of byInvariant) {
      appMetrics.invariantViolations.set({ invariant }, count);
    }
    // Ensure a clean run also reports zero rather than a stale value.
    for (const invariant of [
      'I1_I2_counter_row',
      'I3_over_allocation',
      'I4_counter_drift',
      'I5_duplicate_booking',
      'I6_idempotency_duplicate',
    ]) {
      if (!byInvariant.has(invariant)) appMetrics.invariantViolations.set({ invariant }, 0);
    }
  }
}
