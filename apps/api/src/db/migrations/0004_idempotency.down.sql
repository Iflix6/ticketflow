-- Rollback of 0004.
DROP TRIGGER IF EXISTS idempotency_records_touch_updated_at ON idempotency_records;
DROP TABLE IF EXISTS idempotency_records;
