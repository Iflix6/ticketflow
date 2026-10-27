-- Rollback of 0003.
DROP TRIGGER IF EXISTS app_users_touch_updated_at ON app_users;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS app_users;
