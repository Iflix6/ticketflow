import { describe, expect, it } from 'vitest';
import {
  assertTransition,
  isConfirmable,
  isLegalTransition,
  isTerminal,
  secondsUntil,
} from '../../apps/api/src/modules/reservations/state-machine.js';
import { AppError } from '../../apps/api/src/shared/errors.js';

/**
 * The reservation state machine is the service-side mirror of the `reservations_enforce_transition`
 * DB trigger. These tests pin every edge, including the ones the trigger's RAISE makes expensive to
 * probe from SQL: the whole matrix of 5 x 5 status pairs is a millisecond here.
 */

const ALL_STATUSES = ['PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELED', 'FAILED'] as const;

describe('reservation state machine', () => {
  it('allows exactly the four documented transitions out of PENDING', () => {
    expect(isLegalTransition('PENDING', 'CONFIRMED')).toBe(true);
    expect(isLegalTransition('PENDING', 'CANCELED')).toBe(true);
    expect(isLegalTransition('PENDING', 'EXPIRED')).toBe(true);
    expect(isLegalTransition('PENDING', 'FAILED')).toBe(true);
  });

  it('permits no transition out of a terminal state, but treats self-assignment as a legal no-op', () => {
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        const legal = isLegalTransition(from, to);
        if (from === to) {
          expect(legal, `${from} -> ${to}`).toBe(true);
        } else if (from === 'PENDING') {
          expect(legal, `${from} -> ${to}`).toBe(true);
        } else {
          expect(legal, `${from} -> ${to}`).toBe(false);
        }
      }
    }
  });

  it('classifies terminality so callers can branch on "nothing else can happen to this row"', () => {
    expect(isTerminal('PENDING')).toBe(false);
    for (const status of ['CONFIRMED', 'EXPIRED', 'CANCELED', 'FAILED'] as const) {
      expect(isTerminal(status)).toBe(true);
    }
  });

  it('throws a typed invalid_transition (mapped to 409) carrying the from/to pair', () => {
    expect(() => assertTransition('EXPIRED', 'CONFIRMED')).toThrowError(AppError);
    try {
      assertTransition('EXPIRED', 'CONFIRMED');
      expect.unreachable('expected assertTransition to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const appError = error as AppError;
      expect(appError.code).toBe('invalid_transition');
      expect(appError.status).toBe(409);
      expect(appError.details).toEqual({ from: 'EXPIRED', to: 'CONFIRMED' });
    }
    expect(() => assertTransition('PENDING', 'CONFIRMED')).not.toThrow();
  });

  it('confirmability is strict: the deadline instant itself is already too late', () => {
    const deadline = new Date('2026-10-27T12:00:00.000Z');
    expect(isConfirmable('PENDING', deadline, new Date('2026-10-27T11:59:59.999Z'))).toBe(true);
    expect(isConfirmable('PENDING', deadline, deadline)).toBe(false);
    expect(isConfirmable('PENDING', deadline, new Date('2026-10-27T12:00:00.001Z'))).toBe(false);
    // A terminal row is never confirmable regardless of the clock.
    expect(isConfirmable('EXPIRED', new Date('2999-01-01T00:00:00.000Z'), new Date())).toBe(false);
  });

  it('reports whole seconds remaining, clamped at zero', () => {
    const now = new Date('2026-10-27T12:00:00.000Z');
    expect(secondsUntil(new Date('2026-10-27T12:00:09.999Z'), now)).toBe(9);
    expect(secondsUntil(now, now)).toBe(0);
    expect(secondsUntil(new Date('2026-10-27T11:59:00.000Z'), now)).toBe(0);
  });
});
