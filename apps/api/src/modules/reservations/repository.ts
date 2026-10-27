import type { ReservationStatus } from '@ticketflow/contracts';
import type { Queryable } from '../../db/pool.js';

/**
 * Reservation + inventory SQL (Safe strategy A only — see modules/experiments/strategies.ts).
 *
 * Design rules, all load-bearing for the correctness claims:
 * - Every inventory mutation is a single conditional `UPDATE` whose `WHERE` is the guard. The row
 *   lock PostgreSQL takes for that UPDATE is the linearization point; there is no read-then-write
 *   window to lose an update in. `RETURNING` reads the post-write counters in the same statement.
 * - Every reservation transition is a conditional `UPDATE ... WHERE status = 'PENDING' [AND clock
 *   guard]`. Zero rows means "someone else already moved this row / the deadline passed" — the
 *   service treats it as a conflict, never as success. This is how exactly-one of confirm-vs-expire
 *   wins without an advisory lock.
 * - Timestamps and deadline comparisons use `app.now()` (the database clock), never `Date.now()` in
 *   the application, so TTL races are decided against one authoritative time (ADR-0006).
 * - `SELECT FOR UPDATE` is used only on the reservation row in the checkout path, to serialize the
 *   check-payment-confirm window against a concurrent cancel/expire of the same reservation.
 */

export type ReservationRow = {
  id: string;
  user_id: string;
  tier_id: string;
  quantity: number;
  status: ReservationStatus;
  strategy: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
  seconds_remaining: number;
};

export type InventoryCounters = {
  available: number;
  reserved: number;
  sold: number;
  version: number;
};

/**
 * Tier + event guard read. `FOR UPDATE` is intentional even though Safe A does not need the lock for
 * its own correctness (the conditional allocation UPDATE serializes by itself): it also freezes the
 * tier/event row against a concurrent price or status change during the reserve transaction, so the
 * price copied onto a booking is the price that was in effect when the allocation succeeded.
 */
export type TierGuardRow = {
  tier_id: string;
  event_id: string;
  tier_name: string;
  price_display_only: string;
  currency: string;
  event_status: string;
  available: number;
};

export async function findTierForUpdate(client: Queryable, tierId: string): Promise<TierGuardRow | undefined> {
  const result = await client.query<TierGuardRow>(
    `SELECT t.id AS tier_id,
            t.event_id,
            t.name AS tier_name,
            t.price_display_only,
            t.currency,
            e.status AS event_status,
            i.available
       FROM ticket_tiers t
       JOIN events e ON e.id = t.event_id
       JOIN inventory i ON i.tier_id = t.id
      WHERE t.id = $1
      FOR UPDATE OF t, i`,
    [tierId],
  );
  return result.rows[0];
}

const RESERVATION_COLUMNS = `
  id, user_id, tier_id, quantity, status, strategy, expires_at, created_at, updated_at,
  GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (expires_at - app.now())))::int) AS seconds_remaining`;

/** Safe A allocation: test-and-mutate in one statement. `null` means the guard failed (sold out). */
export async function tryAllocate(
  client: Queryable,
  tierId: string,
  quantity: number,
): Promise<InventoryCounters | null> {
  const result = await client.query<InventoryCounters>(
    `UPDATE inventory
        SET available = available - $2,
            reserved  = reserved + $2,
            version   = version + 1
      WHERE tier_id = $1 AND available >= $2
      RETURNING available, reserved, sold, version`,
    [tierId, quantity],
  );
  return result.rows[0] ?? null;
}

export async function insertReservation(
  client: Queryable,
  params: {
    userId: string;
    tierId: string;
    quantity: number;
    strategy: string;
    ttlSeconds: number;
    idempotencyRecordId: string | null;
  },
): Promise<ReservationRow> {
  const result = await client.query<ReservationRow>(
    `INSERT INTO reservations (user_id, tier_id, quantity, status, expires_at, strategy, idempotency_record_id)
     VALUES ($1, $2, $3, 'PENDING', app.now() + make_interval(secs => $4::int), $5, $6)
     RETURNING ${RESERVATION_COLUMNS}`,
    [
      params.userId,
      params.tierId,
      params.quantity,
      params.ttlSeconds,
      params.strategy,
      params.idempotencyRecordId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('reservation insert returned no row');
  return row;
}

export async function findReservation(client: Queryable, id: string): Promise<ReservationRow | undefined> {
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

/** Checkout locks the reservation row so its status cannot change under the payment decision. */
export async function findReservationForUpdate(
  client: Queryable,
  id: string,
): Promise<ReservationRow | undefined> {
  const result = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM reservations WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0];
}

/** PENDING -> CONFIRMED, only if still before the DB-clock deadline. `null` = not confirmable. */
export async function confirmReservation(client: Queryable, id: string): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'CONFIRMED', confirmed_at = app.now()
      WHERE id = $1 AND status = 'PENDING' AND expires_at > app.now()
      RETURNING ${RESERVATION_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** PENDING -> CANCELED. Guarded so a concurrent confirm/expire wins and this becomes a no-op. */
export async function cancelReservation(client: Queryable, id: string): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'CANCELED', canceled_at = app.now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${RESERVATION_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** PENDING -> EXPIRED, only once the DB clock has passed the deadline. */
export async function expireReservation(client: Queryable, id: string): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'EXPIRED', expired_at = app.now()
      WHERE id = $1 AND status = 'PENDING' AND expires_at <= app.now()
      RETURNING ${RESERVATION_COLUMNS}`,
    [id],
  );
  return result.rows[0] ?? null;
}

/** PENDING -> FAILED (declined payment). `failure_reason` is a bounded, non-PII label. */
export async function failReservation(
  client: Queryable,
  id: string,
  reason: string,
): Promise<ReservationRow | null> {
  const result = await client.query<ReservationRow>(
    `UPDATE reservations
        SET status = 'FAILED', failure_reason = $2
      WHERE id = $1 AND status = 'PENDING'
      RETURNING ${RESERVATION_COLUMNS}`,
    [id, reason],
  );
  return result.rows[0] ?? null;
}

/** Reserved units return to available (cancel/expire). Guarded so `reserved` cannot go negative. */
export async function releaseReserved(
  client: Queryable,
  tierId: string,
  quantity: number,
): Promise<InventoryCounters> {
  const result = await client.query<InventoryCounters>(
    `UPDATE inventory
        SET available = available + $2,
            reserved  = reserved - $2,
            version   = version + 1
      WHERE tier_id = $1 AND reserved >= $2
      RETURNING available, reserved, sold, version`,
    [tierId, quantity],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`releaseReserved guard failed for tier ${tierId}`);
  return row;
}

/** Reserved units become sold (confirm). Guarded so `reserved` cannot go negative. */
export async function commitReservedToSold(
  client: Queryable,
  tierId: string,
  quantity: number,
): Promise<InventoryCounters> {
  const result = await client.query<InventoryCounters>(
    `UPDATE inventory
        SET sold      = sold + $2,
            reserved  = reserved - $2,
            version   = version + 1
      WHERE tier_id = $1 AND reserved >= $2
      RETURNING available, reserved, sold, version`,
    [tierId, quantity],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error(`commitReservedToSold guard failed for tier ${tierId}`);
  return row;
}

/**
 * Set-based expiry of everything past its deadline (the sweeper's correctness core, exposed here so
 * integration tests can exercise the exact SQL the Phase-4 worker will run). Returns how many rows
 * flipped and their tier/quantity so the caller can return inventory in the same transaction.
 */
export async function expireDueReservations(
  client: Queryable,
): Promise<Array<{ id: string; tier_id: string; quantity: number }>> {
  const result = await client.query<{ id: string; tier_id: string; quantity: number }>(
    `UPDATE reservations
        SET status = 'EXPIRED', expired_at = app.now()
      WHERE id IN (
        SELECT id FROM reservations
         WHERE status = 'PENDING' AND expires_at <= app.now()
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, tier_id, quantity`,
  );
  return result.rows;
}

/** Owner-scoped page of reservations, newest first. `total` is the un-paginated count for the envelope. */
export async function listReservationsForUser(
  client: Queryable,
  userId: string,
  limit: number,
  offset: number,
): Promise<{ rows: ReservationRow[]; total: number }> {
  const rowsResult = await client.query<ReservationRow>(
    `SELECT ${RESERVATION_COLUMNS} FROM reservations
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3`,
    [userId, limit, offset],
  );
  const countResult = await client.query<{ total: string }>(
    'SELECT COUNT(*)::text AS total FROM reservations WHERE user_id = $1',
    [userId],
  );
  return { rows: rowsResult.rows, total: Number(countResult.rows[0]?.total ?? '0') };
}
