-- Runs once, on first container start only (docker-entrypoint-initdb.d).
-- A dedicated database for integration tests keeps test traffic out of the development database;
-- test suites CREATE/DROP their own numbered shards from this template's owner.
CREATE DATABASE ticketflow_test OWNER ticketflow;

-- Instrumentation for lock-contention reporting used by the experiments methodology.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
