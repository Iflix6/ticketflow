-- Rollback of 0001. Destructive by design: later migrations depend on app.new_id().
DROP FUNCTION IF EXISTS app.now();
DROP FUNCTION IF EXISTS app.new_id();
DROP TABLE IF EXISTS app.environment_capabilities;
DROP SCHEMA IF EXISTS app;
