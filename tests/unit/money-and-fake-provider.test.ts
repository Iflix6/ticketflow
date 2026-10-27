import { describe, expect, it } from 'vitest';
import { fromCents, multiplyMoneyByInt, toCents } from '../../apps/api/src/shared/money.js';
import {
  charge,
  providerReferenceFor,
  statusForOutcome,
} from '../../apps/api/src/modules/payments/fake-provider.js';

/**
 * Money and the fake provider are both pure and deterministic. Reproducibility is the point: an
 * experiment that replays a checkout must produce the same provider reference (so the unique index
 * collapses it) and the exact same money total (no float drift).
 */

describe('money', () => {
  it('round-trips cents through the 2-decimal string form', () => {
    expect(toCents('10.00')).toBe(1000);
    expect(toCents('0.99')).toBe(99);
    expect(toCents('7')).toBe(700); // no fractional part is still valid money
    expect(fromCents(1000)).toBe('10.00');
    expect(fromCents(5)).toBe('0.05');
  });

  it('multiplies exactly where binary floating point would drift', () => {
    // 0.1 + 0.2 style trap: a naive float `0.10 * 3` prints `0.30000000000000004`.
    expect(multiplyMoneyByInt('0.10', 3)).toBe('0.30');
    expect(multiplyMoneyByInt('19.99', 7)).toBe('139.93');
    expect(multiplyMoneyByInt('10.00', 0)).toBe('0.00');
  });

  it('refuses malformed prices and non-integer quantities instead of guessing', () => {
    expect(() => toCents('1.234')).toThrow();
    expect(() => toCents('-5')).toThrow();
    expect(() => multiplyMoneyByInt('10.00', 1.5)).toThrow();
    expect(() => multiplyMoneyByInt('10.00', -1)).toThrow();
  });
});

describe('fake payment provider', () => {
  it('maps each simulated outcome onto exactly one payment status', () => {
    expect(statusForOutcome('success')).toBe('SUCCEEDED');
    expect(statusForOutcome('failure')).toBe('FAILED');
    expect(statusForOutcome('timeout')).toBe('TIMEOUT');
  });

  it('is deterministic: the same (reservation, outcome) always yields the same reference', () => {
    const a = providerReferenceFor({ reservationId: 'res-1', outcome: 'success' });
    const b = providerReferenceFor({ reservationId: 'res-1', outcome: 'success' });
    expect(a).toBe(b);
    expect(a).toMatch(/^fake_[0-9a-f]{40}$/);
  });

  it('scopes the reference by reservation and by outcome so distinct charges never collide', () => {
    const success = providerReferenceFor({ reservationId: 'res-1', outcome: 'success' });
    const failure = providerReferenceFor({ reservationId: 'res-1', outcome: 'failure' });
    const otherReservation = providerReferenceFor({ reservationId: 'res-2', outcome: 'success' });
    expect(new Set([success, failure, otherReservation]).size).toBe(3);
  });

  it('charge carries through the amount it was handed (never invents a price)', () => {
    const result = charge({ reservationId: 'res-9', outcome: 'success' }, '139.93');
    expect(result).toEqual({
      status: 'SUCCEEDED',
      providerReference: providerReferenceFor({ reservationId: 'res-9', outcome: 'success' }),
      amount: '139.93',
    });
  });
});
