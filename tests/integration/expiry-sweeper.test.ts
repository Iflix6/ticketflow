import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Database } from '../../apps/api/src/db/pool.js';
import { sweepExpiries } from '../../apps/worker/src/expiry.js';
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
 * The expiry sweeper is the CORRECTNESS path for hold deadlines (ADR-0005) — the delayed queue jobs
 * are only a latency optimization. These tests prove the sweeper alone restores seats exactly once,
 * even when two sweeps race for the same rows (SKIP LOCKED), and that counters/invariants stay clean
 * with no queue involved at all.
 */
suite('Phase 4 — expiry sweeper (the truth path for deadlines)', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let pool: Pool;
  let tierId: string;
  let userId: string;

  /** Holds a seat (counter move + PENDING reservation) with a chosen deadline. */
  const holdSeat = async (dueIn: string): Promise<string> => {
    const reservationId = (await db.query<{ id: string }>('SELECT app.new_id()::text AS id')).rows[0]?.id;
    if (reservationId === undefined) throw new Error('no id');
    await db.query(
      `INSERT INTO reservations (id, user_id, tier_id, quantity, status, expires_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 1, 'PENDING', app.now() + interval ${dueIn})`,
      [reservationId, userId, tierId],
    );
    await db.query(
      `UPDATE inventory SET available = available - 1, reserved = reserved + 1, version = version + 1
        WHERE tier_id = $1::uuid AND available >= 1`,
      [tierId],
    );
    return reservationId;
  };

  const counters = async (): Promise<{ available: number; reserved: number; sold: number; capacity: number }> => {
    const { rows } = await db.query<{ available: number; reserved: number; sold: number; capacity: number }>(
      'SELECT available, reserved, sold, capacity FROM inventory WHERE tier_id = $1',
      [tierId],
    );
    return rows[0] ?? { available: -1, reserved: -1, sold: -1, capacity: -1 };
  };

  const statusOf = async (reservationId: string): Promise<string | undefined> => {
    const { rows } = await db.query<{ status: string }>('SELECT status FROM reservations WHERE id = $1', [reservationId]);
    return rows[0]?.status;
  };

  const violations = async (): Promise<string[]> => {
    const { rows } = await db.query<{ invariant: string }>('SELECT invariant FROM app.invariant_violations');
    return rows.map((r) => r.invariant);
  };

  beforeAll(async () => {
    handle = await startTestDatabase('expiry_sweeper');
    db = handle.db;
    const admin = new URL(handle.adminUrl);
    admin.pathname = `/${handle.databaseName}`;
    pool = new pg.Pool({ connectionString: admin.toString(), max: 5 });
    tierId = (await seedCatalog(db, 'sweep-concert', 'Stalls', 20)).tierId;
    userId = await seedUser(db, 'sweep-customer@load.test');
  });

  afterAll(async () => {
    await pool.end();
    await handle.cleanup();
  });

  it('expires an overdue hold, returns its seat, and writes the expired event — atomically', async () => {
    const before = await counters();
    const reservationId = await holdSeat("'-1 hour'"); // already overdue
    expect(await counters()).toMatchObject({ available: before.available - 1, reserved: before.reserved + 1 });

    const expired = await sweepExpiries(pool);
    expect(expired).toBe(1);
    expect(await statusOf(reservationId)).toBe('EXPIRED');
    const after = await counters();
    expect(after.available).toBe(before.available);
    expect(after.reserved).toBe(before.reserved);

    const { rows } = await db.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM outbox_events
        WHERE event_type = 'reservation.expired' AND aggregate_id = $1::uuid`,
      [reservationId],
    );
    expect(Number(rows[0]?.n ?? '0')).toBe(1);
    expect(await violations()).toEqual([]);
  });

  it('a second sweep is a no-op — no double release', async () => {
    const at = await counters();
    expect(await sweepExpiries(pool)).toBe(0);
    expect(await counters()).toMatchObject({ available: at.available, reserved: at.reserved });
  });

  it('two concurrent sweeps over 3 overdue holds release every seat exactly once', async () => {
    const before = await counters();
    const ids = await Promise.all([
      holdSeat("'3 days'"), // NOT due — must survive both sweeps
      holdSeat("'-1 hour'"),
      holdSeat("'-1 hour'"),
      holdSeat("'-2 hour'"),
    ]);
    const dueCount = 3;
    // All four holds take a seat; only the three overdue ones are eligible to expire.
    const mid = await counters();
    expect(mid).toMatchObject({ available: before.available - 4, reserved: before.reserved + 4 });

    // Genuine contention: two sweeps on the same database at the same instant — SKIP LOCKED must
    // split the rows between them, not double-process them.
    const [a, b] = await Promise.all([sweepExpiries(pool), sweepExpiries(pool)]);
    expect(a + b).toBe(dueCount);

    expect(await statusOf(ids[0] ?? '')).toBe('PENDING');
    for (const id of ids.slice(1)) {
      expect(await statusOf(id)).toBe('EXPIRED');
    }
    const after = await counters();
    expect(after.available).toBe(before.available - 1); // only the not-due hold still sits on a seat
    expect(after.reserved).toBe(before.reserved + 1);
    expect(await violations()).toEqual([]);
  });

  it('sweep ignores holds that are not due and reservations already terminal', async () => {
    const before = await counters();
    const canceled = await holdSeat("'1 day'");
    await db.query(
      `UPDATE reservations SET status = 'CANCELED', canceled_at = app.now(), expired_at = NULL
        WHERE id = $1::uuid`,
      [canceled],
    );
    // A canceled hold must give its seat back manually (the reservation service does this on cancel);
    // mirror that here so counters stay truthful before asserting the sweep touches nothing else.
    await db.query(
      `UPDATE inventory SET available = available + 1, reserved = reserved - 1, version = version + 1
        WHERE tier_id = $1::uuid`,
      [tierId],
    );

    expect(await sweepExpiries(pool)).toBe(0);
    const after = await counters();
    expect(after.available).toBe(before.available);
    expect(after.reserved).toBe(before.reserved);
    expect(await violations()).toEqual([]);
  });

  it('released seats are immediately re-holdable without breaking invariants', async () => {
    const before = await counters();
    await holdSeat("'-1 hour'");
    expect(await sweepExpiries(pool)).toBe(1);

    const reservationId = await holdSeat("'1 day'"); // re-take the released seat
    expect(reservationId).toHaveLength(36);
    const after = await counters();
    expect(after.available).toBe(before.available - 1);
    expect(after.reserved).toBe(before.reserved + 1);
    expect(await violations()).toEqual([]);
  });
});
