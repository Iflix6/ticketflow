/**
 * SINGLE IN-CODE SOURCE OF TRUTH for the lifecycle state machines.
 *
 * Every status enum exchanged over the wire is DERIVED from a tuple here (see `domain.ts` and `lab.ts`),
 * and the two machines that constrain not just *states* but *transitions* — reservations and experiment
 * runs — carry their edge tables in this one file too. This is the file you edit to change a lifecycle.
 *
 * What this is NOT: it is not the *enforcement* authority. PostgreSQL stays that (ADR-0002): the
 * `CHECK (status IN (...))` constraints and the `reservations_enforce_transition` /
 * `experiment_runs_enforce_immutability` triggers are what a raw SQL write — the separate worker
 * process, a `psql` session, a migration backfill, a future second service — can never bypass. A TS
 * constant can only guard the code paths that import it.
 *
 * So why centralize in TS at all? Because the enum VALUES and the transition RULES otherwise exist as
 * hand-copied literals in three places (SQL `CHECK`, zod schema, service guard) that merely *happen* to
 * agree. `tests/integration/state-machine-parity.test.ts` closes that gap for real: it reads the live
 * `status IN (...)` CHECK definition from `pg_constraint` and fails the build if it ever differs from the
 * tuples below. That is the difference between "several copies in sync by luck" and "one definition plus a
 * test that proves the schema matches it."
 */

export const RESERVATION_STATES = ['PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELED', 'FAILED'] as const;
export type ReservationState = (typeof RESERVATION_STATES)[number];

/**
 * PENDING fans out to every terminal state; terminal states are sinks. Mirrors
 * `app.reservations_enforce_transition` (migration 0005): the only legal edge out of PENDING is to a
 * terminal state, and any change to a terminal row raises SQLSTATE TF001.
 */
export const RESERVATION_TRANSITIONS: Readonly<Record<ReservationState, readonly ReservationState[]>> = {
  PENDING: ['CONFIRMED', 'CANCELED', 'EXPIRED', 'FAILED'],
  CONFIRMED: [],
  CANCELED: [],
  EXPIRED: [],
  FAILED: [],
};
export const RESERVATION_TERMINAL: readonly ReservationState[] = ['CONFIRMED', 'CANCELED', 'EXPIRED', 'FAILED'];

/** Booking is enum-only in the schema (no transition trigger); the one-booking-per-reservation UNIQUE is the real guard. */
export const BOOKING_STATES = ['PENDING_PAYMENT', 'CONFIRMED', 'CANCELED', 'FAILED'] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

/**
 * Payment attempt is enum-only. `SUCCEEDED_NOT_FULFILLED` is the deliberately honest state for "the fake
 * provider approved the charge but we did not complete fulfilment" — it must never be collapsed into
 * SUCCEEDED, because that would hide a real inconsistency from the reconciliation report.
 */
export const PAYMENT_ATTEMPT_STATES = ['PENDING', 'SUCCEEDED', 'FAILED', 'TIMEOUT', 'SUCCEEDED_NOT_FULFILLED'] as const;
export type PaymentAttemptState = (typeof PAYMENT_ATTEMPT_STATES)[number];

export const LAB_RUN_STATES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED'] as const;
export type LabRunState = (typeof LAB_RUN_STATES)[number];

/**
 * Forward-only ladder for an experiment run. There is no DB transition trigger here (unlike reservations):
 * the ordering is a service-layer convention (`markRunRunning` then `finalizeRun`), and the schema's only
 * hard rule is immutability once `finished_at` is set (SQLSTATE TF002). A run can still fail *before* it
 * starts — the asynchronous path resets the fixture while the row is PENDING — so `PENDING -> FAILED` is a
 * legitimate edge; `PENDING -> ABORTED` covers an operator cancel.
 */
export const LAB_RUN_TRANSITIONS: Readonly<Record<LabRunState, readonly LabRunState[]>> = {
  PENDING: ['RUNNING', 'FAILED', 'ABORTED'],
  RUNNING: ['COMPLETED', 'FAILED', 'ABORTED'],
  COMPLETED: [],
  FAILED: [],
  ABORTED: [],
};
export const LAB_RUN_TERMINAL: readonly LabRunState[] = ['COMPLETED', 'FAILED', 'ABORTED'];

/**
 * Generic edge test shared by every machine: re-setting a status to itself is a no-op, not a transition
 * (so idempotent guards keep passing); otherwise the target must appear in the source's allowed list.
 */
export function isLegalEdge<S extends string>(
  transitions: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return from === to || (transitions[from]?.includes(to) ?? false);
}
