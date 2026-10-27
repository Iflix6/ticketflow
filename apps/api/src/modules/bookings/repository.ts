import type { BookingStatus } from '@ticketflow/contracts';
import type { Queryable } from '../../db/pool.js';

/**
 * Booking + payment-attempt SQL.
 *
 * Two constraints from the schema do the heavy lifting and are relied on rather than re-checked here:
 * - `bookings.reservation_id UNIQUE` — a retried confirmation can never produce a second fulfilment
 *   (invariant I5). The checkout path therefore inserts and never upserts.
 * - `payment_attempts.provider_reference UNIQUE` — combined with the deterministic fake provider, a
 *   replay of the same (reservation, outcome) collapses onto one attempt row instead of charging twice.
 *
 * Money is never client-supplied: `total_amount` is computed from the tier price the reservation was
 * allocated against, so a request body cannot influence what a booking claims to owe.
 */

export type BookingRow = {
  id: string;
  reservation_id: string;
  status: BookingStatus;
  total_amount: string;
  currency: string;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type PaymentAttemptRow = {
  id: string;
  booking_id: string;
  provider_reference: string;
  status: 'PENDING' | 'SUCCEEDED' | 'FAILED' | 'TIMEOUT' | 'SUCCEEDED_NOT_FULFILLED';
  requested_at: Date;
  completed_at: Date | null;
};

const BOOKING_COLUMNS = 'id, reservation_id, status, total_amount, currency, confirmed_at, created_at, updated_at';

const PAYMENT_COLUMNS = 'id, booking_id, provider_reference, status, requested_at, completed_at';

export async function insertBooking(
  client: Queryable,
  params: {
    reservationId: string;
    status: BookingStatus;
    totalAmount: string;
    currency: string;
    /** CONFIRMED bookings stamp their confirmation time; declined/failure bookings leave it NULL. */
    confirmNow?: boolean;
  },
): Promise<BookingRow> {
  const result = await client.query<BookingRow>(
    `INSERT INTO bookings (reservation_id, status, total_amount, currency, confirmed_at)
     VALUES ($1, $2, $3::numeric, $4, ${params.confirmNow === true ? 'app.now()' : 'NULL'})
     RETURNING ${BOOKING_COLUMNS}`,
    [params.reservationId, params.status, params.totalAmount, params.currency],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('booking insert returned no row');
  return row;
}

/**
 * Inserts an attempt unless the deterministic reference already exists. `ON CONFLICT DO NOTHING`
 * plus a follow-up read makes a replay of the same outcome a no-op read instead of a unique
 * violation, so the caller never has to distinguish "I just wrote it" from "it was already there".
 */
export async function insertPaymentAttempt(
  client: Queryable,
  params: {
    bookingId: string;
    providerReference: string;
    status: 'SUCCEEDED' | 'FAILED';
    amount: string;
    simulatedOutcome: 'success' | 'failure' | 'timeout';
    /** Set only for a terminal, finalized attempt. */
    completedAtNow?: boolean;
  },
): Promise<PaymentAttemptRow> {
  const columns =
    params.completedAtNow === true
      ? `${PAYMENT_COLUMNS}, completed_at`
      : PAYMENT_COLUMNS;
  const result = await client.query<PaymentAttemptRow & { completed_at: Date | null }>(
    `INSERT INTO payment_attempts (booking_id, provider_reference, status, amount, simulated_outcome, completed_at)
     VALUES ($1, $2, $3, $4::numeric, $5, ${params.completedAtNow === true ? 'app.now()' : 'NULL'})
     ON CONFLICT (provider_reference) DO NOTHING
     RETURNING ${columns}`,
    [params.bookingId, params.providerReference, params.status, params.amount, params.simulatedOutcome],
  );
  const inserted = result.rows[0];
  if (inserted !== undefined) return inserted;

  const existing = await client.query<PaymentAttemptRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payment_attempts WHERE provider_reference = $1`,
    [params.providerReference],
  );
  const row = existing.rows[0];
  if (row === undefined) throw new Error('payment attempt disappeared between insert and read');
  return row;
}

export async function findPaymentAttemptByReference(
  client: Queryable,
  providerReference: string,
): Promise<PaymentAttemptRow | undefined> {
  const result = await client.query<PaymentAttemptRow>(
    `SELECT ${PAYMENT_COLUMNS} FROM payment_attempts WHERE provider_reference = $1`,
    [providerReference],
  );
  return result.rows[0];
}

export async function findBooking(client: Queryable, id: string): Promise<BookingRow | undefined> {
  const result = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

/** Booking joined to its reservation owner, so a read can enforce access without a second query. */
export async function findBookingWithOwner(
  client: Queryable,
  id: string,
): Promise<(BookingRow & { owner_user_id: string }) | undefined> {
  const result = await client.query<BookingRow & { owner_user_id: string }>(
    `SELECT b.id, b.reservation_id, b.status, b.total_amount, b.currency, b.confirmed_at,
            b.created_at, b.updated_at, r.user_id AS owner_user_id
       FROM bookings b
       JOIN reservations r ON r.id = b.reservation_id
      WHERE b.id = $1`,
    [id],
  );
  return result.rows[0];
}

export async function findBookingByReservation(
  client: Queryable,
  reservationId: string,
): Promise<BookingRow | undefined> {
  const result = await client.query<BookingRow>(
    `SELECT ${BOOKING_COLUMNS} FROM bookings WHERE reservation_id = $1`,
    [reservationId],
  );
  return result.rows[0];
}

/** Reservation ids owned by one user; used to scope booking reads without a second query per row. */
export async function findBookingsForUser(
  client: Queryable,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ rows: BookingRow[]; total: number }> {
  const rowsResult = await client.query<BookingRow>(
    `SELECT b.id, b.reservation_id, b.status, b.total_amount, b.currency, b.confirmed_at, b.created_at, b.updated_at
       FROM bookings b
       JOIN reservations r ON r.id = b.reservation_id
      WHERE r.user_id = $1
      ORDER BY b.created_at DESC, b.id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const countResult = await client.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total
       FROM bookings b
       JOIN reservations r ON r.id = b.reservation_id
      WHERE r.user_id = $1`,
    [userId],
  );
  return { rows: rowsResult.rows, total: Number(countResult.rows[0]?.total ?? '0') };
}

/** Booking id lookup for the reservation-scoped read (`checkout` response replay). */
export async function findBookingIdForReservation(
  client: Queryable,
  reservationId: string,
): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    'SELECT id FROM bookings WHERE reservation_id = $1',
    [reservationId],
  );
  return result.rows[0]?.id;
}
