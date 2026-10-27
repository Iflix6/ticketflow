-- 0009 independent invariant views (docs/architecture/data-model.md §3).
--
-- These views exist so that correctness is asserted by SQL that does NOT share code with the
-- application paths being tested. `npm run invariants` and every integration test query them.

CREATE VIEW app.inventory_snapshot AS
SELECT
  i.tier_id,
  i.capacity,
  i.available,
  i.reserved,
  i.sold,
  i.version,
  i.updated_at,
  COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'PENDING'), 0)::bigint            AS pending_qty,
  COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'CONFIRMED'), 0)::bigint           AS confirmed_qty,
  COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ('PENDING', 'CONFIRMED')), 0)::bigint AS live_qty
FROM inventory i
LEFT JOIN reservations r ON r.tier_id = i.tier_id
GROUP BY i.tier_id, i.capacity, i.available, i.reserved, i.sold, i.version, i.updated_at;

-- I1/I2: counter row self-consistency (normally impossible to violate thanks to CHECK constraints;
-- the view exists so a violation is *detectable* rather than merely theoretically excluded).
CREATE VIEW app.inventory_row_invariant_violations AS
SELECT
  tier_id,
  capacity,
  available,
  reserved,
  sold,
  'I1_I2_counter_row'::text AS invariant
FROM inventory
WHERE available < 0 OR reserved < 0 OR sold < 0 OR capacity < 0
   OR available + reserved + sold <> capacity;

-- I3: over-allocation — live reservations plus sold units exceed capacity. This is the invariant the
-- unsafe baseline breaks (lost update), and it is NOT expressible as a single-row CHECK.
CREATE VIEW app.live_allocation_violations AS
SELECT
  s.tier_id,
  s.capacity,
  s.sold,
  s.live_qty,
  'I3_over_allocation'::text AS invariant
FROM app.inventory_snapshot s
WHERE s.live_qty > s.capacity;

-- I4: counters must agree with reservation rows, checked only at quiescence.
CREATE VIEW app.counter_drift_violations AS
SELECT
  s.tier_id,
  s.reserved,
  s.pending_qty,
  s.sold,
  s.confirmed_qty,
  'I4_counter_drift'::text AS invariant
FROM app.inventory_snapshot s
WHERE s.reserved::bigint <> s.pending_qty
   OR s.sold::bigint <> s.confirmed_qty;

-- I5: exactly one fulfilment per reservation.
CREATE VIEW app.duplicate_booking_violations AS
SELECT
  reservation_id,
  COUNT(*)::int AS booking_count,
  'I5_duplicate_booking'::text AS invariant
FROM bookings
GROUP BY reservation_id
HAVING COUNT(*) > 1;

-- I6: one committed idempotency record per (user, endpoint, key) — belt for the unique index.
CREATE VIEW app.idempotency_violations AS
SELECT
  scope_user_id,
  scope_endpoint,
  key,
  COUNT(*)::int AS record_count,
  'I6_idempotency_duplicate'::text AS invariant
FROM idempotency_records
GROUP BY scope_user_id, scope_endpoint, key
HAVING COUNT(*) > 1;

-- Single-query rollup used by `npm run invariants` and the CI gate.
CREATE VIEW app.invariant_violations AS
SELECT invariant, tier_id::text AS subject_id, to_jsonb(v) AS observed
FROM app.inventory_row_invariant_violations v
UNION ALL
SELECT invariant, tier_id::text, to_jsonb(v) FROM app.live_allocation_violations v
UNION ALL
SELECT invariant, tier_id::text, to_jsonb(v) FROM app.counter_drift_violations v
UNION ALL
SELECT invariant, reservation_id::text, to_jsonb(v) FROM app.duplicate_booking_violations v
UNION ALL
SELECT invariant, scope_user_id::text || '/' || scope_endpoint || '/' || key, to_jsonb(v)
FROM app.idempotency_violations v;

-- The same over-allocation detector for the isolated lab fixture, so the unsafe baseline is judged by
-- exactly the same standard as the safe strategies.
CREATE VIEW lab.live_allocation_violations AS
SELECT
  i.tier_id,
  i.capacity,
  i.sold,
  COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ('PENDING', 'CONFIRMED')), 0)::bigint AS live_qty,
  'L3_lab_over_allocation'::text AS invariant
FROM lab.inventory i
LEFT JOIN lab.reservations r ON r.tier_id = i.tier_id
GROUP BY i.tier_id, i.capacity, i.sold
HAVING COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ('PENDING', 'CONFIRMED')), 0) > i.capacity;
