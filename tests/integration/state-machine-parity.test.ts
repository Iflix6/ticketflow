import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../apps/api/src/db/pool.js';
import {
  BOOKING_STATES,
  LAB_RUN_STATES,
  PAYMENT_ATTEMPT_STATES,
  RESERVATION_STATES,
  bookingStatusSchema,
  labRunStatusSchema,
  paymentAttemptStatusSchema,
  reservationStatusSchema,
} from '@ticketflow/contracts';
import { databaseAvailable, startTestDatabase, type TestDatabaseHandle } from '../helpers/integration-db.js';

/**
 * The loop that turns "several copies in sync by luck" into "one definition plus a proof."
 *
 * `packages/contracts/src/state-machines.ts` is the single in-code source of truth for the lifecycle
 * states; the zod wire enums are *derived* from its tuples; and PostgreSQL's `CHECK (status IN (...))`
 * constraints are the enforcement authority (ADR-0002). Nothing statically tied the last two together —
 * this test does. For every machine it asserts, against a database built by the REAL migration files:
 *  1. the wire schema accepts exactly the tuple's states and nothing else (proves derivation, not drift);
 *  2. the live `status IN (...)` CHECK set equals the tuple (proves the schema and the code agree).
 * If a migration adds/renames a status without touching `state-machines.ts`, or the reverse, this fails.
 */

const suite = databaseAvailable() ? describe : describe.skip;

/** A zod enum exposes `safeParse`; typed minimally so this file needs no direct zod dependency. */
type StatusSchema = { safeParse: (data: unknown) => { success: boolean } };

type Machine = {
  /** Unqualified table name, resolved as a `regclass` in the migrated schema. */
  table: string;
  states: readonly string[];
  schema: StatusSchema;
};

const MACHINES: Machine[] = [
  { table: 'reservations', states: RESERVATION_STATES, schema: reservationStatusSchema },
  { table: 'bookings', states: BOOKING_STATES, schema: bookingStatusSchema },
  { table: 'payment_attempts', states: PAYMENT_ATTEMPT_STATES, schema: paymentAttemptStatusSchema },
  { table: 'experiment_runs', states: LAB_RUN_STATES, schema: labRunStatusSchema },
];

suite('state enums are one source of truth that matches the database CHECK constraints', () => {
  let handle: TestDatabaseHandle;
  let db: Database;

  beforeAll(async () => {
    handle = await startTestDatabase('state_machine_parity');
    db = handle.db;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it('derives every wire status enum from the shared tuple (accepts its states, rejects a bogus one)', () => {
    for (const machine of MACHINES) {
      for (const state of machine.states) {
        expect(machine.schema.safeParse(state).success, `${machine.table}: ${state} should validate`).toBe(true);
      }
      expect(machine.schema.safeParse('__not_a_real_state__').success, `${machine.table}: bogus state accepted`).toBe(false);
    }
  });

  it('matches the live PostgreSQL `status IN (...)` CHECK set exactly', async () => {
    const findings: string[] = [];
    for (const machine of MACHINES) {
      // PostgreSQL auto-names an inline column CHECK `<table>_<column>_check`; that exact name is the
      // single status enum constraint. (Pattern-matching the definition text is not enough: e.g.
      // `reservations_terminal_has_timestamp` also contains a `status = ANY (ARRAY[...])` sub-clause.)
      const result = await db.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def
           FROM pg_constraint
          WHERE contype = 'c'
            AND conrelid = $1::regclass
            AND conname = $2`,
        [machine.table, `${machine.table}_status_check`],
      );

      if (result.rows.length !== 1) {
        findings.push(`${machine.table}: expected exactly one ${machine.table}_status_check, found ${result.rows.length}`);
        continue;
      }

      const dbStates = extractEnumLiterals(result.rows[0]?.def ?? '').sort();
      const tsStates = [...machine.states].sort();
      const differ = dbStates.join(',') !== tsStates.join(',');
      if (differ) {
        findings.push(`${machine.table}: DB CHECK [${dbStates.join(', ')}] != state-machine tuple [${tsStates.join(', ')}]`);
      }
    }
    // Fail once with every mismatch, so one schema edit surfaces all the drift it caused.
    expect(findings).toEqual([]);
  });
});

/** Pulls the quoted enum members out of a `status = ANY (ARRAY['X'::text, ...])` constraint definition. */
function extractEnumLiterals(def: string): string[] {
  const arrayBody = /status = ANY \(ARRAY\[(.*?)\]\)/.exec(def)?.[1];
  if (arrayBody === undefined) return [];
  return [...arrayBody.matchAll(/'([^']+)'::text/g)].map((match) => match[1] as string);
}
