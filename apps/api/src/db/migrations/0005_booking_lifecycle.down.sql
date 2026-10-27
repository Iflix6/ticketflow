-- Rollback of 0005.
DROP TABLE IF EXISTS payment_attempts;
DROP TRIGGER IF EXISTS bookings_touch_updated_at ON bookings;
DROP TABLE IF EXISTS bookings;
DROP TRIGGER IF EXISTS reservations_touch_updated_at ON reservations;
DROP TRIGGER IF EXISTS reservations_enforce_transition ON reservations;
DROP FUNCTION IF EXISTS app.reservations_enforce_transition();
DROP TABLE IF EXISTS reservations;
