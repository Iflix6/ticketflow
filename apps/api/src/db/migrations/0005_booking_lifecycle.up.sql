-- 0005 booking lifecycle: reservations, bookings, fake payment attempts.
--
-- Inventory counter changes are NOT stored here; they happen in `inventory` inside the same
-- transaction as these inserts/updates (docs/architecture/data-model.md).

CREATE TABLE reservations (
  id                     uuid PRIMARY KEY DEFAULT app.new_id(),
  user_id                uuid NOT NULL REFERENCES app_users (id) ON DELETE RESTRICT,
  tier_id                uuid NOT NULL REFERENCES ticket_tiers (id) ON DELETE RESTRICT,
  quantity               integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  status                 text NOT NULL DEFAULT 'PENDING'
                         CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELED', 'FAILED')),
  -- Deadline is fixed at creation and evaluated against the DATABASE clock only.
  expires_at             timestamptz NOT NULL,
  idempotency_record_id  uuid REFERENCES idempotency_records (id) ON DELETE SET NULL,
  -- Which allocation strategy produced this row (auditable comparison across experiments).
  strategy               text NOT NULL DEFAULT 'atomic_update'
                         CHECK (strategy IN ('atomic_update', 'pessimistic', 'optimistic', 'unsafe_lab')),
  failure_reason         text,
  confirmed_at           timestamptz,
  canceled_at            timestamptz,
  expired_at             timestamptz,
  created_at             timestamptz NOT NULL DEFAULT app.now(),
  updated_at             timestamptz NOT NULL DEFAULT app.now(),
  -- A terminal row must record when it became terminal.
  CONSTRAINT reservations_terminal_has_timestamp CHECK (
    (status = 'CONFIRMED' AND confirmed_at IS NOT NULL)
    OR (status = 'CANCELED' AND canceled_at IS NOT NULL)
    OR (status = 'EXPIRED' AND expired_at IS NOT NULL)
    OR (status IN ('PENDING', 'FAILED'))
  )
);

CREATE INDEX reservations_user_id_idx ON reservations (user_id);
CREATE INDEX reservations_tier_status_idx ON reservations (tier_id, status);
-- Sweeper query target: pending rows whose deadline has passed.
CREATE INDEX reservations_pending_expires_at_idx
  ON reservations (expires_at)
  WHERE status = 'PENDING';

-- Database-level backstop for the state machine, in addition to conditional UPDATE guards in SQL.
-- Legal: PENDING -> CONFIRMED | CANCELED | EXPIRED | FAILED. Anything else (including any change to
-- a terminal row) raises SQLSTATE TF001 and the surrounding transaction rolls back.
CREATE FUNCTION app.reservations_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PENDING'
     AND NEW.status IN ('CONFIRMED', 'CANCELED', 'EXPIRED', 'FAILED') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'illegal reservation transition from % to % for reservation %',
    OLD.status, NEW.status, OLD.id
    USING ERRCODE = 'TF001';
END
$body$;

CREATE TRIGGER reservations_enforce_transition
  BEFORE UPDATE OF status ON reservations
  FOR EACH ROW EXECUTE FUNCTION app.reservations_enforce_transition();

CREATE TRIGGER reservations_touch_updated_at
  BEFORE UPDATE ON reservations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- One booking per reservation, enforced by the unique constraint: a retried confirmation can never
-- create a second fulfilment.
CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT app.new_id(),
  reservation_id uuid NOT NULL UNIQUE REFERENCES reservations (id) ON DELETE RESTRICT,
  status         text NOT NULL DEFAULT 'PENDING_PAYMENT'
                 CHECK (status IN ('PENDING_PAYMENT', 'CONFIRMED', 'CANCELED', 'FAILED')),
  -- Copied from the tier at creation for display; never taken from the client.
  total_amount   numeric(12, 2) NOT NULL CHECK (total_amount >= 0),
  currency       char(3) NOT NULL DEFAULT 'USD',
  confirmed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT app.now(),
  updated_at     timestamptz NOT NULL DEFAULT app.now()
);

CREATE INDEX bookings_status_idx ON bookings (status);

CREATE TRIGGER bookings_touch_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Deterministic fake provider (spec: no real funds, no external gateway).
CREATE TABLE payment_attempts (
  id                 uuid PRIMARY KEY DEFAULT app.new_id(),
  booking_id         uuid NOT NULL REFERENCES bookings (id) ON DELETE CASCADE,
  provider_reference text NOT NULL UNIQUE,
  status             text NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'TIMEOUT',
                                        'SUCCEEDED_NOT_FULFILLED')),
  amount             numeric(12, 2) NOT NULL CHECK (amount >= 0),
  simulated_outcome  text NOT NULL CHECK (simulated_outcome IN ('success', 'failure', 'timeout')),
  requested_at       timestamptz NOT NULL DEFAULT app.now(),
  completed_at       timestamptz
);

CREATE INDEX payment_attempts_booking_id_idx ON payment_attempts (booking_id);
