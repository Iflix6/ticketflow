import type { ReservationStatus } from '@ticketflow/contracts';
import { AppError } from '../../shared/errors.js';

/**
 * Reservation state machine (docs/architecture/data-model.md §4).
 *
 * These are the SAME rules the `reservations_enforce_transition` trigger enforces in PostgreSQL
 * (migration 0005). Duplicating the rule set in the service is deliberate, not redundant:
 * - the DB trigger is the un-bypassable backstop (a raw SQL mistake cannot create an illegal row);
 * - the service check gives a precise, typed `invalid_transition` error *before* a transaction is
 *   opened, and makes every legal/illegal edge a fast unit test rather than a database round trip.
 * When the two ever disagree, the database wins and the transition fails — which is the safe
 * direction for a disagreement.
 */

const LEGAL_TRANSITIONS: Readonly<Record<ReservationStatus, readonly ReservationStatus[]>> = {
  PENDING: ['CONFIRMED', 'CANCELED', 'EXPIRED', 'FAILED'],
  CONFIRMED: [],
  CANCELED: [],
  EXPIRED: [],
  FAILED: [],
};

const TERMINAL: ReadonlySet<ReservationStatus> = new Set(['CONFIRMED', 'CANCELED', 'EXPIRED', 'FAILED']);

export function isTerminal(status: ReservationStatus): boolean {
  return TERMINAL.has(status);
}

/** Re-setting a status to itself is a no-op, not a transition; treat it as legal so idempotent guards pass. */
export function isLegalTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return from === to || LEGAL_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ReservationStatus, to: ReservationStatus): void {
  if (!isLegalTransition(from, to)) {
    throw new AppError('invalid_transition', `Reservation transition ${from} -> ${to} is not allowed`, {
      from,
      to,
    });
  }
}

/**
 * Whether a PENDING reservation may still be confirmed, given the DATABASE clock. Confirmation is
 * legal only strictly before the deadline (`expires_at > now`); at or after it, only expiry holds.
 * Kept as a pure predicate so the boundary is unit-tested; the enforceable guard is the conditional
 * UPDATE's WHERE clause (the two must agree, and the integration race test proves they do).
 */
export function isConfirmable(status: ReservationStatus, expiresAt: Date, now: Date): boolean {
  return status === 'PENDING' && expiresAt.getTime() > now.getTime();
}

/** Whole seconds remaining until expiry, clamped at zero (never negative in a response). */
export function secondsUntil(expiresAt: Date, now: Date): number {
  return Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
}
