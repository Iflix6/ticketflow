-- 0006 transactional outbox, audit trail, and consumer deduplication bookkeeping.

CREATE TABLE outbox_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type    text NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 120),
  aggregate_type text NOT NULL CHECK (aggregate_type IN ('reservation', 'booking', 'inventory', 'experiment_run')),
  aggregate_id  uuid NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT app.now(),
  -- NULL means "not yet published"; the relay never deletes rows, only marks them.
  published_at  timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error    text
);

-- Relay poll target: oldest unpublished first. Partial index keeps it small as history grows.
CREATE INDEX outbox_events_unpublished_idx
  ON outbox_events (id)
  WHERE published_at IS NULL;

CREATE INDEX outbox_events_aggregate_idx ON outbox_events (aggregate_type, aggregate_id);

-- Audit records: actor/action/aggregate + safe metadata only (no secrets, no PII).
CREATE TABLE audit_records (
  id             uuid PRIMARY KEY DEFAULT app.new_id(),
  actor_user_id  uuid REFERENCES app_users (id) ON DELETE SET NULL,
  -- 'user' | 'system' | 'worker' | 'lab' — distinguishes automated transitions from human ones.
  actor_kind     text NOT NULL CHECK (actor_kind IN ('user', 'system', 'worker', 'lab', 'anonymous')),
  action         text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  aggregate_type text NOT NULL,
  aggregate_id   uuid,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT app.now(),
  request_id     text
);

CREATE INDEX audit_records_aggregate_idx ON audit_records (aggregate_type, aggregate_id, occurred_at);
CREATE INDEX audit_records_occurred_at_idx ON audit_records (occurred_at);

-- Consumers of outbox events record what they already handled, so at-least-once delivery becomes
-- an idempotent no-op on redelivery (spec: "consumers must deduplicate").
CREATE TABLE consumed_events (
  consumer    text NOT NULL,
  outbox_id   bigint NOT NULL REFERENCES outbox_events (id) ON DELETE CASCADE,
  consumed_at timestamptz NOT NULL DEFAULT app.now(),
  PRIMARY KEY (consumer, outbox_id)
);
