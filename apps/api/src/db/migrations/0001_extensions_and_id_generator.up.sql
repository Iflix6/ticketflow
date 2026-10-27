-- 0001 extensions + identifier generator capability probe.
-- Records which UUID generator this server actually provides instead of assuming uuid7() exists.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE IF NOT EXISTS app.environment_capabilities (
  key         text PRIMARY KEY,
  value       text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now()
);

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'pg_catalog' AND p.proname = 'uuid7'
  ) THEN
    -- PostgreSQL >= 18: time-ordered UUIDs, better B-tree locality for hot insert paths.
    EXECUTE $fn$
      CREATE FUNCTION app.new_id() RETURNS uuid
      LANGUAGE sql VOLATILE
      AS $body$ SELECT uuid7() $body$
    $fn$;
    INSERT INTO app.environment_capabilities (key, value)
      VALUES ('id_generator', 'uuid7')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, detected_at = now();
  ELSE
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    EXECUTE $fn$
      CREATE FUNCTION app.new_id() RETURNS uuid
      LANGUAGE sql VOLATILE
      AS $body$ SELECT gen_random_uuid() $body$
    $fn$;
    INSERT INTO app.environment_capabilities (key, value)
      VALUES ('id_generator', 'gen_random_uuid')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, detected_at = now();
  END IF;
END
$do$;

-- Single place that decides "now" for deadline arithmetic (database clock, never app clock).
CREATE FUNCTION app.now() RETURNS timestamptz
LANGUAGE sql STABLE
AS $body$ SELECT now() $body$;
