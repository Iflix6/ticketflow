'use client';

import { useEffect, useState } from 'react';
import { browserApi, browserApiRaw, isApiCallError } from '../lib/api';
import type { BookingDto, ReservationDto, TierWithInventory } from '../lib/types';

/**
 * Reserve → countdown → fake checkout, per tier. Rules this component lives by (all from the
 * pack and the documented contract):
 * - No optimistic success. A hold exists only after the 201; a booking exists only after the
 *   checkout response. Everything on screen came from the server.
 * - Every mutation carries a fresh Idempotency-Key (`crypto.randomUUID()`), so a lost response is
 *   safe to retry against the SAME key; a new hold is a new intent and therefore a new key.
 * - The countdown uses the server's `secondsRemaining` (database clock); the local tick only
 *   renders, and at zero the component re-reads the reservation instead of declaring expiry.
 * - Displayed money is the server's decimal string; the estimated total is computed in integer
 *   cents, never floats. The authoritative amount is only ever the checkout response's totalAmount.
 */

function priceInCents(priceDisplayOnly: string): number {
  const [whole, frac = '0'] = priceDisplayOnly.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

const centsToString = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

type Phase = 'idle' | 'holding' | 'held' | 'paying' | 'done' | 'dead';

export function BookingPanel({ tier, userName }: { tier: TierWithInventory; userName: string }) {
  const { tier: t, inventory } = tier;
  const [quantity, setQuantity] = useState(1);
  const [phase, setPhase] = useState<Phase>('idle');
  const [reservation, setReservation] = useState<ReservationDto | undefined>();
  const [booking, setBooking] = useState<BookingDto | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [outcome, setOutcome] = useState<'success' | 'failure' | 'timeout'>('success');

  // One shared countdown tick for every panel on the page.
  useEffect(() => {
    if (phase !== 'held' || reservation === undefined) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [phase, reservation]);

  // Reaching zero on a rendered clock is a hint to re-read the server, not a verdict.
  useEffect(() => {
    if (phase === 'held' && secondsLeft === 0 && reservation !== undefined) {
      void refreshReservation(reservation.id);
    }
  }, [secondsLeft]);

  async function holdSeats() {
    setPhase('holding');
    setError(undefined);
    setNotice(undefined);
    const key = `ui-hold-${crypto.randomUUID()}`;
    try {
      const res = await browserApi<{ data: ReservationDto }>('/api/v1/reservations', {
        method: 'POST',
        headers: { 'idempotency-key': key },
        body: { tierId: t.id, quantity },
      });
      setReservation(res.data);
      setSecondsLeft(res.data.secondsRemaining);
      setPhase('held');
    } catch (err) {
      setError(
        isApiCallError(err)
          ? `${err.code}: ${err.message}`
          : 'Could not reach the API.',
      );
      setPhase('idle');
    }
  }

  async function refreshReservation(id: string) {
    try {
      const res = await browserApi<{ data: ReservationDto }>(`/api/v1/reservations/${id}`);
      setReservation(res.data);
      if (res.data.status !== 'PENDING') {
        setSecondsLeft(0);
        setPhase(res.data.status === 'CONFIRMED' ? 'done' : 'dead');
        setNotice(`Server says this hold is now ${res.data.status}.`);
      } else {
        setSecondsLeft(res.data.secondsRemaining);
      }
    } catch {
      setPhase('dead');
      setError('The hold could not be re-read; check My bookings.');
    }
  }

  async function checkout() {
    if (reservation === undefined) return;
    setPhase('paying');
    setError(undefined);
    setNotice(undefined);
    try {
      const res = await browserApiRaw<BookingDto | ReservationDto>(
        `/api/v1/reservations/${reservation.id}/checkout`,
        {
          method: 'POST',
          headers: { 'idempotency-key': `ui-checkout-${crypto.randomUUID()}` },
          body: { simulatedOutcome: outcome },
        },
      );
      // The contract branches on the STATUS the server chose, not on a guessed body shape:
      // 201 booking CONFIRMED · 200 booking FAILED (seats released) · 202 reservation still PENDING.
      if (res.status === 202) {
        setNotice(
          'The fake provider timed out: your hold is still PENDING and nothing was charged. This is "unknown", not "failed".',
        );
        setPhase('held');
        await refreshReservation(reservation.id);
        return;
      }
      const booking = res.json as BookingDto;
      setBooking(booking);
      if (booking.status === 'CONFIRMED') {
        setPhase('done');
      } else {
        setPhase('dead');
        setNotice(`The fake payment ${booking.status.toLowerCase()}; the seats were released back to available.`);
        await refreshReservation(reservation.id);
      }
    } catch (err) {
      setPhase('held');
      setError(isApiCallError(err) ? `${err.code}: ${err.message}` : 'Checkout failed to respond.');
      if (reservation !== undefined) await refreshReservation(reservation.id);
    }
  }

  async function cancel() {
    if (reservation === undefined) return;
    setError(undefined);
    try {
      await browserApi(`/api/v1/reservations/${reservation.id}/cancel`, {
        method: 'POST',
        headers: { 'idempotency-key': `ui-cancel-${crypto.randomUUID()}` },
      });
      await refreshReservation(reservation.id);
      setPhase('dead');
      setNotice('Hold canceled; the seats are back in `available`.');
    } catch (err) {
      setError(isApiCallError(err) ? `${err.code}: ${err.message}` : 'Cancel failed to respond.');
    }
  }

  const estimatedCents = priceInCents(t.priceDisplayOnly) * quantity;
  const status = reservation?.status ?? booking?.status;

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="font-semibold">{t.name}</h3>
      <p className="text-sm text-slate-600">
        {t.currency} {t.priceDisplayOnly} each · {inventory.available} of {inventory.capacity} available
      </p>

      {phase === 'idle' && (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void holdSeats();
          }}
        >
          <div>
            <label htmlFor={`qty-${t.id}`} className="block text-xs font-medium">
              Quantity (1–10, per reservation)
            </label>
            <input
              id={`qty-${t.id}`}
              type="number"
              min={1}
              max={10}
              value={quantity}
              onChange={(e) => setQuantity(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1 w-20 rounded border border-slate-300 px-2 py-1"
            />
          </div>
          <button type="submit" className="rounded bg-blue-700 px-3 py-1.5 text-sm text-white hover:bg-blue-800 disabled:opacity-50">
            Hold {quantity} seat{quantity === 1 ? '' : 's'} — est. {t.currency} {centsToString(estimatedCents)}
          </button>
        </form>
      )}

      {phase === 'holding' && <p className="mt-3 text-sm text-slate-600">Holding seats…</p>}

      {phase === 'held' && reservation !== undefined && (
        <div className="mt-3 space-y-3">
          <p role="status" aria-live="polite" className="text-sm">
            Hold <span className="font-mono text-xs">{reservation.id.slice(0, 8)}</span> (
            {reservation.quantity} × {t.name}) — <strong>{secondsLeft}s</strong> left to confirm.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor={`outcome-${t.id}`} className="block text-xs font-medium">
                Fake payment outcome (deterministic knob, never real money)
              </label>
              <select
                id={`outcome-${t.id}`}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as typeof outcome)}
                className="mt-1 rounded border border-slate-300 px-2 py-1"
              >
                <option value="success">success</option>
                <option value="failure">failure</option>
                <option value="timeout">timeout</option>
              </select>
            </div>
            <button type="button" onClick={() => void checkout()} className="rounded bg-green-700 px-3 py-1.5 text-sm text-white hover:bg-green-800 disabled:opacity-50" disabled={phase === 'paying'}>
              Pay now
            </button>
            <button type="button" onClick={() => void cancel()} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100">
              Cancel hold
            </button>
          </div>
        </div>
      )}

      {phase === 'paying' && <p className="mt-3 text-sm text-slate-600">Contacting fake provider…</p>}

      {phase === 'done' && (
        <div className="mt-3 space-y-2">
          <p role="status" className="text-sm font-medium text-green-800">
            {booking !== undefined
              ? `Booking ${booking.id.slice(0, 8)} — ${booking.status}, server total ${booking.currency} ${booking.totalAmount}.`
              : `Hold is ${status}.`}
          </p>
          <p className="text-xs text-slate-500">Signed in as {userName}; visible under My bookings.</p>
        </div>
      )}

      {phase === 'dead' && (
        <p role="status" className="mt-3 text-sm text-slate-700">
          This hold ended ({status}).{' '}
          <button type="button" onClick={() => { setPhase('idle'); setReservation(undefined); setBooking(undefined); }}>
            Start a new hold
          </button>
        </p>
      )}

      {notice !== undefined && (
        <p role="status" className="mt-2 rounded bg-sky-50 p-2 text-xs text-sky-900">
          {notice}
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-xs text-red-800">
          {error}
        </p>
      )}
    </article>
  );
}
