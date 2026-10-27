-- 0007 Engineering Lab: experiment runs, per-request results, reconciliation findings.
--
-- LOCAL/TEST ONLY tables (ADR-0009). They are still created in the shared database so a single
-- migration set describes the whole schema; access is gated in code, and the `lab` schema in the
-- next migration holds the data the unsafe baseline is allowed to touch.

CREATE TABLE experiment_runs (
  id            uuid PRIMARY KEY DEFAULT app.new_id(),
  strategy      text NOT NULL CHECK (strategy IN ('atomic_update', 'pessimistic', 'optimistic', 'unsafe_lab')),
  configuration jsonb NOT NULL,
  label         text,
  status        text NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ABORTED')),
  started_at    timestamptz NOT NULL DEFAULT app.now(),
  finished_at   timestamptz,
  git_sha       text,
  environment   text NOT NULL,
  -- Machine facts, captured by the runner so a report is interpretable without asking anyone.
  host_info     jsonb,
  outcomes      jsonb,
  report_paths  jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by    uuid REFERENCES app_users (id) ON DELETE SET NULL,
  -- `now()` at insert: expiry/latency arithmetic elsewhere uses DB time, this is bookkeeping.
  created_at    timestamptz NOT NULL DEFAULT app.now(),
  CONSTRAINT experiment_runs_finished_window CHECK (
    (finished_at IS NULL) OR (finished_at >= started_at)
  )
);

CREATE INDEX experiment_runs_strategy_started_idx ON experiment_runs (strategy, started_at);

-- Immutable summary once a run has completed: any later UPDATE/DELETE raises TF002.
CREATE FUNCTION app.experiment_runs_enforce_immutability() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  IF OLD.finished_at IS NOT NULL THEN
    RAISE EXCEPTION 'experiment run % is completed and its summary is immutable', OLD.id
      USING ERRCODE = 'TF002';
  END IF;
  RETURN NEW;
END
$body$;

CREATE TRIGGER experiment_runs_enforce_immutability
  BEFORE UPDATE OR DELETE ON experiment_runs
  FOR EACH ROW
  WHEN (OLD.finished_at IS NOT NULL)
  EXECUTE FUNCTION app.experiment_runs_enforce_immutability();

CREATE TABLE experiment_results (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id          uuid NOT NULL REFERENCES experiment_runs (id) ON DELETE CASCADE,
  request_index   integer NOT NULL CHECK (request_index >= 0),
  -- Synthetic actor label (e.g. "buyer-0431"); never a real customer identifier.
  actor_label     text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('SUCCEEDED', 'SOLD_OUT', 'CONFLICT', 'DUPLICATE',
                                                   'VALIDATION_ERROR', 'SERVER_ERROR', 'TIMEOUT')),
  http_status     integer,
  latency_micros  bigint NOT NULL CHECK (latency_micros >= 0),
  failure_class   text NOT NULL DEFAULT 'none'
                  CHECK (failure_class IN ('none', 'lost_update_overallocation',
                                           'invariant_violation_failed_insert', 'negative_available',
                                           'duplicate_booking', 'idempotency_violation', 'deadlock',
                                           'timeout', 'unknown')),
  correlation_id  text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT app.now(),
  CONSTRAINT experiment_results_run_request_unique UNIQUE (run_id, request_index)
);

CREATE INDEX experiment_results_run_outcome_idx ON experiment_results (run_id, outcome);

-- Recorded discrepancies that must be reconciled by hand or by a documented policy (spec: a payment
-- that succeeds after expiry is stored here instead of resurrecting inventory).
CREATE TABLE reconciliation_findings (
  id             uuid PRIMARY KEY DEFAULT app.new_id(),
  kind           text NOT NULL CHECK (kind IN ('payment_after_expiry', 'duplicate_callback',
                                                'counter_mismatch', 'reservation_counter_drift',
                                                'outbox_stuck')),
  tier_id        uuid REFERENCES ticket_tiers (id) ON DELETE CASCADE,
  reservation_id uuid REFERENCES reservations (id) ON DELETE CASCADE,
  run_id         uuid REFERENCES experiment_runs (id) ON DELETE SET NULL,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT app.now(),
  resolved_at    timestamptz
);

CREATE INDEX reconciliation_findings_unresolved_idx
  ON reconciliation_findings (created_at)
  WHERE resolved_at IS NULL;
