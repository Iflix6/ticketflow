-- Rollback of 0002 (reverse dependency order).
DROP TRIGGER IF EXISTS ticket_tiers_touch_updated_at ON ticket_tiers;
DROP TRIGGER IF EXISTS events_touch_updated_at ON events;
DROP TRIGGER IF EXISTS inventory_touch_updated_at ON inventory;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS ticket_tiers;
DROP TABLE IF EXISTS events;
DROP FUNCTION IF EXISTS app.touch_updated_at();
