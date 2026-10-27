-- Rollback of 0009 (views only; no data is touched).
DROP VIEW IF EXISTS lab.live_allocation_violations;
DROP VIEW IF EXISTS app.invariant_violations;
DROP VIEW IF EXISTS app.idempotency_violations;
DROP VIEW IF EXISTS app.duplicate_booking_violations;
DROP VIEW IF EXISTS app.counter_drift_violations;
DROP VIEW IF EXISTS app.live_allocation_violations;
DROP VIEW IF EXISTS app.inventory_row_invariant_violations;
DROP VIEW IF EXISTS app.inventory_snapshot;
