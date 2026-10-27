import type { PaymentAttemptDto } from '@ticketflow/contracts';
import { sha256Hex } from '../../shared/crypto.js';

/**
 * Fake payment provider (spec: "deterministic fake payment provider", "no real funds, no gateway").
 *
 * It is a pure function of its inputs. That determinism is the point: an experiment must be
 * reproducible, and a `provider_reference` derived (not random) means a replayed checkout produces
 * the SAME reference, so `payment_attempts.provider_reference UNIQUE` turns an accidental double
 * submit into an idempotent no-op instead of two rows.
 *
 * Nothing here talks to the network, reads configuration, or uses `Math.random()`. Real gateways are
 * explicitly out of scope for this lab.
 */

export type SimulatedOutcome = 'success' | 'failure' | 'timeout';
export type PaymentStatus = 'SUCCEEDED' | 'FAILED' | 'TIMEOUT';

export interface ChargeRequest {
  /** The reservation being paid for; part of the deterministic reference so it is scoped per order. */
  readonly reservationId: string;
  readonly outcome: SimulatedOutcome;
}

export interface ChargeResult {
  readonly status: PaymentStatus;
  readonly providerReference: string;
  readonly amount: string;
}

export function statusForOutcome(outcome: SimulatedOutcome): PaymentStatus {
  switch (outcome) {
    case 'success':
      return 'SUCCEEDED';
    case 'failure':
      return 'FAILED';
    case 'timeout':
      return 'TIMEOUT';
  }
}

/** Stable, non-secret, non-guessable-looking reference: `fake_<sha256(reservation|outcome)>`. */
export function providerReferenceFor(request: ChargeRequest): string {
  return `fake_${sha256Hex(`${request.reservationId}|${request.outcome}`).slice(0, 40)}`;
}

export function charge(request: ChargeRequest, amount: string): ChargeResult {
  return {
    status: statusForOutcome(request.outcome),
    providerReference: providerReferenceFor(request),
    amount,
  };
}

/** Shapes a stored row into the client-facing attempt DTO (completed_at is null until finalized). */
export function toAttemptDto(row: {
  id: string;
  booking_id: string;
  provider_reference: string;
  status: PaymentStatus;
  requested_at: Date;
  completed_at: Date | null;
}): PaymentAttemptDto {
  return {
    id: row.id,
    bookingId: row.booking_id,
    providerReference: row.provider_reference,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at === null ? null : row.completed_at.toISOString(),
  };
}
