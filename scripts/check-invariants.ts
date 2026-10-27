import pg from 'pg';
import { bootstrapConfig } from '@ticketflow/config';

/**
 * Independent invariant verification (`npm run invariants`).
 *
 * Reads ONLY the views from migration 0009 — SQL that shares no code with the application paths
 * under test — and exits non-zero when any violation row appears. This is the same gate the
 * integration tests and CI use after concurrent runs: HTTP 200 counts prove nothing on their own.
 *
 * Note on I4 (counter drift): it is only meaningful at quiescence — while reservations are being
 * written concurrently a legitimate intermediate state can drift momentarily. The `--quiescent`
 * flag (default in CI) treats I4 as blocking; without it I4 findings are warnings.
 */

const VIEWS: ReadonlyArray<{ name: string; query: string; quiescentOnly: boolean }> = [
  {
    name: 'app.inventory_row_invariant_violations (I1/I2)',
    quiescentOnly: false,
    query: 'SELECT tier_id::text AS subject, to_jsonb(v) AS observed FROM app.inventory_row_invariant_violations v',
  },
  {
    name: 'app.live_allocation_violations (I3)',
    quiescentOnly: false,
    query: 'SELECT tier_id::text AS subject, to_jsonb(v) AS observed FROM app.live_allocation_violations v',
  },
  {
    name: 'app.counter_drift_violations (I4)',
    quiescentOnly: true,
    query: 'SELECT tier_id::text AS subject, to_jsonb(v) AS observed FROM app.counter_drift_violations v',
  },
  {
    name: 'app.duplicate_booking_violations (I5)',
    quiescentOnly: false,
    query: 'SELECT reservation_id::text AS subject, to_jsonb(v) AS observed FROM app.duplicate_booking_violations v',
  },
  {
    name: 'app.idempotency_violations (I6)',
    quiescentOnly: false,
    query: "SELECT (scope_user_id::text || '/' || scope_endpoint || '/' || key) AS subject, to_jsonb(v) AS observed FROM app.idempotency_violations v",
  },
  {
    name: 'lab.live_allocation_violations (L3)',
    quiescentOnly: false,
    query: 'SELECT tier_id::text AS subject, to_jsonb(v) AS observed FROM lab.live_allocation_violations v',
  },
];

async function main(): Promise<void> {
  const config = bootstrapConfig();
  const treatQuiescentAsBlocking = process.argv.includes('--quiescent');
  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });

  let failures = 0;
  try {
    for (const view of VIEWS) {
      const result = await pool.query<{ subject: string; observed: Record<string, unknown> }>(view.query);
      const label = view.quiescentOnly && !treatQuiescentAsBlocking ? 'warning' : 'fail';
      if (result.rowCount === null || result.rowCount === 0) {
        console.log(`PASS  ${view.name}`);
        continue;
      }
      failures += label === 'fail' ? 1 : 0;
      console.log(`${label === 'fail' ? 'FAIL' : 'WARN '}  ${view.name}: ${result.rowCount} violation row(s)`);
      for (const row of result.rows.slice(0, 5)) {
        console.log(`        subject=${row.subject} ${JSON.stringify(row.observed)}`);
      }
    }
  } finally {
    await pool.end();
  }

  if (failures > 0) {
    console.error(`invariant check FAILED (${failures} blocking view(s) with violations)`);
    process.exit(1);
  }
  console.log('all invariants hold');
}

main().catch((error: unknown) => {
  console.error('[invariants]', error instanceof Error ? error.message : error);
  process.exit(1);
});
