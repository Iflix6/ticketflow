-- Rollback of 0008 destroys all lab experiment data.
DROP FUNCTION IF EXISTS lab.reset_fixture(integer, integer, integer);
DROP FUNCTION IF EXISTS lab.tier_id(integer, integer);
DROP TABLE IF EXISTS lab.fixture_meta;
DROP TABLE IF EXISTS lab.reservations;
DROP TABLE IF EXISTS lab.inventory;
DROP SCHEMA IF EXISTS lab CASCADE;
