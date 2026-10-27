-- 0008 lab schema: the ONLY place the intentionally unsafe baseline may write (ADR-0009).
--
-- The CHECK constraints here are byte-for-byte the same invariants as public.inventory. The unsafe
-- experiment is unsafe because of its *code path* (unlocked read → delay → blind write), not because
-- the schema was weakened. That distinction is the teaching point of the whole module.

CREATE SCHEMA lab;

CREATE TABLE lab.inventory (
  tier_id    uuid PRIMARY KEY,
  capacity   integer NOT NULL CHECK (capacity >= 0),
  available  integer NOT NULL CHECK (available >= 0),
  reserved   integer NOT NULL CHECK (reserved >= 0),
  sold       integer NOT NULL CHECK (sold >= 0),
  version    integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at timestamptz NOT NULL DEFAULT app.now(),
  CONSTRAINT lab_inventory_counters_partition_capacity
    CHECK (available + reserved + sold = capacity)
);

CREATE TABLE lab.reservations (
  id         uuid PRIMARY KEY,
  tier_id    uuid NOT NULL REFERENCES lab.inventory (tier_id) ON DELETE CASCADE,
  -- Synthetic buyer label; no real customer data exists in this lab.
  actor_label text NOT NULL,
  quantity   integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  status     text NOT NULL DEFAULT 'PENDING'
             CHECK (status IN ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELED', 'FAILED')),
  strategy   text NOT NULL DEFAULT 'unsafe_lab'
             CHECK (strategy IN ('atomic_update', 'pessimistic', 'optimistic', 'unsafe_lab')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT app.now()
);

CREATE INDEX lab_reservations_tier_status_idx ON lab.reservations (tier_id, status);

CREATE TABLE lab.fixture_meta (
  id          uuid PRIMARY KEY DEFAULT app.new_id(),
  seed        integer NOT NULL,
  capacity    integer NOT NULL,
  tier_count  integer NOT NULL,
  reset_at    timestamptz NOT NULL DEFAULT app.now(),
  reset_by    text NOT NULL DEFAULT 'system'
);

-- Deterministic tier identifiers derived from the run seed, so "same seed" really means "same rows"
-- across strategies and across machines.
CREATE FUNCTION lab.tier_id(p_seed integer, p_index integer) RETURNS uuid
LANGUAGE sql IMMUTABLE
AS $body$ SELECT md5('lab-tier-' || p_seed::text || '-' || p_index::text)::uuid $body$;

-- Resetting a fixture is a single SQL call so tests and the lab endpoint behave identically and
-- cannot leave a half-reset state.
CREATE FUNCTION lab.reset_fixture(p_seed integer, p_capacity integer, p_tier_count integer)
RETURNS void
LANGUAGE plpgsql AS $body$
BEGIN
  IF p_capacity IS NULL OR p_capacity < 1 OR p_tier_count IS NULL OR p_tier_count < 1 THEN
    RAISE EXCEPTION 'lab.reset_fixture requires positive capacity and tier count';
  END IF;

  DELETE FROM lab.reservations;
  DELETE FROM lab.inventory;
  DELETE FROM lab.fixture_meta WHERE seed = p_seed;

  INSERT INTO lab.inventory (tier_id, capacity, available, reserved, sold, version)
  SELECT lab.tier_id(p_seed, g), p_capacity, p_capacity, 0, 0, 0
  FROM generate_series(1, p_tier_count) AS g;

  INSERT INTO lab.fixture_meta (seed, capacity, tier_count)
  VALUES (p_seed, p_capacity, p_tier_count);
END
$body$;
