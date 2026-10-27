-- 0002 core catalog: events, ticket tiers, and the authoritative inventory counters.
--
-- `inventory` is the single row whose per-tier counters decide whether a sale is allowed.
-- The CHECK constraints below are the database's own statement of invariant I1/I2 and are
-- deliberately NOT weakened anywhere, including for the unsafe lab experiment (ADR-0009).

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $body$
BEGIN
  NEW.updated_at := app.now();
  RETURN NEW;
END
$body$;

CREATE TABLE events (
  id          uuid PRIMARY KEY DEFAULT app.new_id(),
  slug        text NOT NULL UNIQUE,
  title       text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description text NOT NULL DEFAULT '',
  start_at    timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'DRAFT'
              CHECK (status IN ('DRAFT', 'ON_SALE', 'SOLD_OUT', 'CANCELED', 'FINISHED')),
  created_at  timestamptz NOT NULL DEFAULT app.now(),
  updated_at  timestamptz NOT NULL DEFAULT app.now()
);

CREATE INDEX events_status_start_at_idx ON events (status, start_at);

CREATE TABLE ticket_tiers (
  id                  uuid PRIMARY KEY DEFAULT app.new_id(),
  event_id            uuid NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  -- Display only. Allocation and charging never read this value from a client.
  price_display_only  numeric(12, 2) NOT NULL CHECK (price_display_only >= 0),
  currency            char(3) NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  capacity            integer NOT NULL CHECK (capacity >= 0),
  created_at          timestamptz NOT NULL DEFAULT app.now(),
  updated_at          timestamptz NOT NULL DEFAULT app.now(),
  CONSTRAINT ticket_tiers_event_name_unique UNIQUE (event_id, name),
  -- Required by inventory's composite FK: an inventory row may only ever mirror its tier's
  -- declared capacity, so capacity cannot be mutated underneath live counters.
  CONSTRAINT ticket_tiers_id_capacity_unique UNIQUE (id, capacity)
);

CREATE INDEX ticket_tiers_event_id_idx ON ticket_tiers (event_id);

CREATE TABLE inventory (
  tier_id    uuid PRIMARY KEY REFERENCES ticket_tiers (id) ON DELETE CASCADE,
  capacity   integer NOT NULL CHECK (capacity >= 0),
  available  integer NOT NULL CHECK (available >= 0),
  reserved   integer NOT NULL CHECK (reserved >= 0),
  sold       integer NOT NULL CHECK (sold >= 0),
  version    integer NOT NULL CHECK (version >= 0) DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT app.now(),
  -- I1: the three counters always partition capacity exactly.
  CONSTRAINT inventory_counters_partition_capacity
    CHECK (available + reserved + sold = capacity),
  -- Capacity of the counter row must match the tier's declared capacity.
  CONSTRAINT inventory_capacity_matches_tier FOREIGN KEY (tier_id, capacity)
    REFERENCES ticket_tiers (id, capacity)
);

CREATE TRIGGER inventory_touch_updated_at
  BEFORE UPDATE ON inventory
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER events_touch_updated_at
  BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TRIGGER ticket_tiers_touch_updated_at
  BEFORE UPDATE ON ticket_tiers
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
