'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { browserApi, browserApiRaw, isApiCallError } from '../lib/api';
import type { BookingDto, ReservationDto, TierWithInventory } from '../lib/types';
import { buttonClass, Badge, Meter, StatusBadge } from './ui';

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
 * The availability meter draws the server's own `available`/`capacity` integers (it never recomputes
 * them), and the status region reveals with a short GSAP motion on every phase change — reduced-motion
 * safe, and purely presentational.
 */

function priceInCents(priceDisplayOnly: string): number {
  const [whole, frac = '0'] = priceDisplayOnly.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0').slice(0, 2));
}

const centsToString = (cents: number): string => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

type Phase = 'idle' | 'holding' | 'held' | 'paying' | 'done' | 'dead';

const field =
  'rounded-lg border border-edge bg-app px-2.5 py-1.5 text-sm text-ink outline-none transition-colors focus:border-brand focus:bg-panel';

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
  const statusRef = useRef<HTMLDivElement>(null);

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

  // The status region reveals on each phase transition so the state change is felt, not just read.
  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || statusRef.current === null) return;
    const ctx = gsap.context(() => {
      gsap.from(statusRef.current, { autoAlpha: 0, y: 8, duration: 0.3, ease: 'power2.out' });
    }, statusRef);
    return () => ctx.revert();
  }, [phase]);

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
      // Every documented route replies with the `{data: ...}` envelope — the same way
      // `holdSeats`/`refreshReservation` unwrap it; reading the raw body as the DTO would
      // silently yield undefined fields.
      const res = await browserApiRaw<{ data: BookingDto }>(
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
      const booking = res.json.data;
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
  const soldOut = inventory.available <= 0;
  const tone = soldOut ? 'danger' : inventory.available <= inventory.capacity * 0.15 ? 'warn' : 'brand';

  return (
    <article className="rounded-xl2 border border-edge bg-panel p-5 shadow-1 transition-shadow hover:shadow-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="font-semibold text-ink">{t.name}</h3>
          <p className="text-sm text-muted">
            <span className="font-medium text-ink tabular-nums">
              {t.currency} {t.priceDisplayOnly}
            </span>{' '}
            each
          </p>
        </div>
        {soldOut ? <Badge tone="danger">Sold out</Badge> : <Badge tone="ok">{inventory.available} available</Badge>}
      </header>

      <div className="mt-3">
        <Meter
          value={inventory.available}
          max={inventory.capacity}
          tone={tone}
          label={
            <span className="tabular-nums">
              {inventory.available} of {inventory.capacity} available
            </span>
          }
        />
      </div>

      {phase === 'idle' && (
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void holdSeats();
          }}
        >
          <div>
            <label htmlFor={`qty-${t.id}`} className="block text-xs font-medium text-muted">
              Quantity (1–10, per reservation)
            </label>
            <input
              id={`qty-${t.id}`}
              type="number"
              min={1}
              max={10}
              value={quantity}
              onChange={(e) => setQuantity(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              className={`mt-1 w-20 ${field}`}
            />
          </div>
          <button
            type="submit"
            disabled={soldOut}
            className={`${buttonClass('primary', 'sm')} mt-1`}
          >
            Hold {quantity} seat{quantity === 1 ? '' : 's'} — est. {t.currency} {centsToString(estimatedCents)}
          </button>
        </form>
      )}

      {phase === 'holding' && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Holding seats…
        </p>
      )}

      {phase === 'held' && reservation !== undefined && (
        <div className="mt-4 space-y-3">
          <p role="status" aria-live="polite" className="text-sm">
            Hold <span className="font-mono text-xs text-brand">{reservation.id.slice(0, 8)}</span> (
            {reservation.quantity} × {t.name}) — <strong className="tabular-nums text-ink">{secondsLeft}s</strong> left to confirm.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor={`outcome-${t.id}`} className="block text-xs font-medium text-muted">
                Fake payment outcome (deterministic knob, never real money)
              </label>
              <select
                id={`outcome-${t.id}`}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value as typeof outcome)}
                className={`mt-1 ${field}`}
              >
                <option value="success">success</option>
                <option value="failure">failure</option>
                <option value="timeout">timeout</option>
              </select>
            </div>
            {/* No disabled flag needed: starting checkout/cancel flips the phase, which unmounts these buttons. */}
            <button type="button" onClick={() => void checkout()} className={`${buttonClass('success', 'sm')} mt-1`}>
              Pay now
            </button>
            <button type="button" onClick={() => void cancel()} className={`${buttonClass('outline', 'sm')} mt-1`}>
              Cancel hold
            </button>
          </div>
        </div>
      )}

      {phase === 'paying' && (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted">
          <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
          Contacting fake provider…
        </p>
      )}

      <div ref={statusRef}>
        {phase === 'done' && (
          <div className="mt-4 space-y-2 rounded-xl border border-ok/25 bg-ok/10 p-3">
            {/* Both conditions are state, not a narrowing dance: a server re-render of this panel can
                legitimately see done-without-booking (refresh between phases), and must degrade, not crash. */}
            {booking !== undefined && (
              <p role="status" className="flex flex-wrap items-center gap-2 text-sm font-medium text-ok">
                <StatusBadge value={booking.status} />
                Booking <span className="font-mono text-xs">{booking.id.slice(0, 8)}</span>, server total{' '}
                <span className="tabular-nums">
                  {booking.currency} {booking.totalAmount}
                </span>
                .
              </p>
            )}
            {booking === undefined && (
              <p role="status" className="text-sm font-medium text-ok">This hold is {status ?? 'confirmed on the server'}.</p>
            )}
            <p className="text-xs text-muted">Signed in as {userName}; visible under My bookings.</p>
          </div>
        )}

        {phase === 'dead' && (
          <p role="status" className="mt-4 text-sm text-muted">
            This hold ended ({status}).{' '}
            <button
              type="button"
              onClick={() => {
                setPhase('idle');
                setReservation(undefined);
                setBooking(undefined);
              }}
              className="font-medium text-brand underline underline-offset-2"
            >
              Start a new hold
            </button>
          </p>
        )}

        {notice !== undefined && (
          <p role="status" className="mt-3 rounded-lg bg-info/10 p-2.5 text-xs text-info">
            {notice}
          </p>
        )}
        {error !== undefined && (
          <p role="alert" className="mt-3 rounded-lg bg-danger/10 p-2.5 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </article>
  );
}
