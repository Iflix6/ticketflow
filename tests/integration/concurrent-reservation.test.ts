import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../apps/api/src/db/pool.js';
import {
  databaseAvailable,
  seedCatalog,
  seedUser,
  startTestDatabase,
  type TestDatabaseHandle,
} from '../helpers/integration-db.js';

const suite = databaseAvailable() ? describe : describe.skip;

/**
 * The flagship correctness preview: 100 capacity, N concurrent guarded allocations, executed as
 * plain parameterized SQL (the exact Safe-A statement from the strategy descriptor). Phase 2 wraps
 * this in the reservation service; the database-level guarantee is already provable here, and this
 * test is the regression gate that protects it.
 *
 * Assertions are made with independent SQL (the invariant views), not HTTP statuses.
 */
suite('atomic conditional UPDATE preserves inventory under real concurrency', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let tierId: string;

  beforeAll(async () => {
    handle = await startTestDatabase('concurrent_reservation');
    db = handle.db;
    const seeded = await seedCatalog(db, 'race-night', 'Single Seat', 100);
    tierId = seeded.tierId;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it('120 concurrent single-seat allocations on 100 capacity: exactly 100 win, inventory stays consistent', async () => {
    const attempts = 120;
    const actors: string[] = [];
    for (let i = 0; i < attempts; i += 1) {
      actors.push(await seedUser(db, `racer-${i}@load.test`));
    }

    // Every actor races its own transaction: guard + mutate + insert, atomically, same statement style
    // as `modules/experiments/strategies.ts` (Safe A). Work is distributed over a fixed number of
    // pool workers (one client per transaction, released in finally) so the test stresses PostgreSQL's
    // row-locking rather than self-deadlocking on pool acquisition.
    const queue = [...actors];
    const workerCount = 10; // matches the harness pool size: genuine parallel transactions, no pool deadlock
    const results = await Promise.all(
      Array.from({ length: workerCount }, async () => {
        const local: Array<{ won: boolean; soldOut: boolean }> = [];
        for (let userId = queue.shift(); userId !== undefined; userId = queue.shift()) {
          const client = await db.connect();
          try {
            await client.query('BEGIN');
            const updated = await client.query(
              `UPDATE inventory
                  SET available = available - 1, reserved = reserved + 1, version = version + 1
                WHERE tier_id = $1 AND available >= 1`,
              [tierId],
            );
            if ((updated.rowCount ?? 0) === 0) {
              await client.query('ROLLBACK');
              local.push({ won: false, soldOut: true });
              continue;
            }
            await client.query(
              `INSERT INTO reservations (user_id, tier_id, quantity, status, expires_at, strategy)
               VALUES ($1, $2, 1, 'PENDING', app.now() + interval '5 minutes', 'atomic_update')`,
              [userId, tierId],
            );
            await client.query('COMMIT');
            local.push({ won: true, soldOut: false });
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        }
        return local;
      }),
    ).then((perWorker) => perWorker.flat());

    const winners = results.filter((r) => r.won).length;
    const soldOut = results.filter((r) => r.soldOut).length;

    // The headline claim, asserted at the database: never more than capacity.
    expect(winners).toBe(100);
    expect(soldOut).toBe(attempts - 100);

    const counters = await db.query<{ available: number; reserved: number; sold: number; capacity: number }>(
      'SELECT capacity, available, reserved, sold FROM inventory WHERE tier_id = $1',
      [tierId],
    );
    expect(counters.rows[0]).toMatchObject({ capacity: 100, available: 0, reserved: 100, sold: 0 });

    // Independent invariant views: no row-level violation, no over-allocation, counters agree.
    const violations = await db.query('SELECT * FROM app.invariant_violations');
    expect(violations.rowCount).toBe(0);

    // No negative inventory is even representable: the CHECK rejects it at the protocol level.
    await expect(
      db.query('UPDATE inventory SET available = -1 WHERE tier_id = $1', [tierId]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('a blind read-modify-write WITHOUT the guard loses an update that CHECK alone cannot catch', async () => {
    // The point of the unsafe baseline, honestly: two clients read the same snapshot, both compute
    // from it, and both write the SAME legal value (9,1) — so the partition CHECK passes, yet one
    // unit of work vanishes. Only reconciliation against the reservation ledger (I4) detects it.
    // This runs against a SEPARATE tier so it cannot contaminate the safe fixture above.
    const labTier = await seedCatalog(db, 'lost-update-demo', 'Demo Seat', 10);
    const userA = await seedUser(db, 'lost-a@load.test');
    const userB = await seedUser(db, 'lost-b@load.test');
    const a = await db.connect();
    const b = await db.connect();
    try {
      const read = async (client: typeof a): Promise<{ available: number; reserved: number }> => {
        const { rows } = await client.query<{ available: number; reserved: number }>(
          'SELECT available, reserved FROM inventory WHERE tier_id = $1',
          [labTier.tierId],
        );
        return rows[0] ?? { available: -1, reserved: -1 };
      };
      const first = await read(a);
      const second = await read(b);
      expect(first).toEqual(second); // same snapshot: the entire bug in one line

      // Each "booking" commits its own reservation row, then blindly overwrites the counter with
      // values computed from the stale read (no guard, no re-read, no relative expression).
      for (const [client, userId] of [[a, userA], [b, userB]] as const) {
        await client.query(
          `INSERT INTO reservations (user_id, tier_id, quantity, status, expires_at, strategy)
           VALUES ($1, $2, 1, 'PENDING', app.now() + interval '5 minutes', 'unsafe_lab')`,
          [userId, labTier.tierId],
        );
        await client.query(
          'UPDATE inventory SET available = $2, reserved = $3 WHERE tier_id = $1',
          [labTier.tierId, first.available - 1, first.reserved + 1],
        );
      }

      const after = await read(a);
      // Two tickets were taken but only one decrement survived: the lost update is observable.
      expect(after).toEqual({ available: 9, reserved: 1 }); // not (8, 2)

      // The CHECK is silent here (9 + 1 = 10 partitions perfectly). The independent ledger
      // reconciliation view is what actually catches the drift — that is why both exist.
      const drift = await db.query<{ invariant: string }>(
        'SELECT invariant FROM app.counter_drift_violations WHERE tier_id = $1',
        [labTier.tierId],
      );
      expect(drift.rows[0]?.invariant).toBe('I4_counter_drift');
    } finally {
      a.release();
      b.release();
    }
  });
});
