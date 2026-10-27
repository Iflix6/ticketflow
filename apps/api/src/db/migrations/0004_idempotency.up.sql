-- 0004 idempotency records (ADR-0004).
--
-- The key row is inserted *inside* the business transaction, so a rollback removes it and a retry is
-- safe. `response_*` columns hold the committed outcome for byte-stable replays.

CREATE TABLE idempotency_records (
  id             uuid PRIMARY KEY DEFAULT app.new_id(),
  scope_user_id  uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  -- Endpoint template (not the concrete path), e.g. "POST /api/v1/reservations".
  scope_endpoint text NOT NULL,
  key            text NOT NULL CHECK (char_length(key) BETWEEN 8 AND 128),
  -- SHA-256 hex of the canonicalized request body. Same key + different hash is a client bug.
  request_hash   text NOT NULL,
  state          text NOT NULL DEFAULT 'IN_PROGRESS'
                 CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  response_status integer,
  response_body   jsonb,
  resource_type   text,
  resource_id     uuid,
  created_at      timestamptz NOT NULL DEFAULT app.now(),
  updated_at      timestamptz NOT NULL DEFAULT app.now(),
  expires_at      timestamptz NOT NULL,
  -- A COMPLETED row must carry the outcome it replays.
  CONSTRAINT idempotency_completed_has_response
    CHECK (state <> 'COMPLETED' OR (response_status IS NOT NULL AND response_body IS NOT NULL)),
  CONSTRAINT idempotency_records_scope_unique UNIQUE (scope_user_id, scope_endpoint, key)
);

-- Keys are swept after expiry; the partial index keeps that scan cheap.
CREATE INDEX idempotency_records_expires_at_idx ON idempotency_records (expires_at);

CREATE TRIGGER idempotency_records_touch_updated_at
  BEFORE UPDATE ON idempotency_records
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
