# Runbook — reconciliation mismatch

**Audience:** on call + data owner. **Owner area:** `apps/worker` reconciler, PostgreSQL invariant views.
**Related alert:** `InventoryInvariantViolation` (critical — P1).

## The one rule that governs this whole page

**The reconciler observes; it never mutates inventory.** `apps/worker/src/reconciliation.ts` writes rows
into `reconciliation_findings` and stops. That is deliberate: a reconciler that "corrected" counters would
launder a real lost-update bug into looking consistent. So a finding is always a *signal to investigate
the database truth*, never a ticket to `UPDATE` the counter to match a projection.

Two finding kinds exist:

| `kind` | Raised by | Means | Severity |
| --- | --- | --- | --- |
| `outbox_stuck` | age of an unpublished event > 60s | delivery lag, not a correctness break → see [outbox-and-redis.md](outbox-and-redis.md) | warning |
| `counter_mismatch` | `app.counter_drift_violations` (I4) returns a row | counters disagree with reservation rows — a **genuine consistency break** | critical |

`outbox_stuck` self-resolves (`resolveStaleFindings`) once the event publishes. `counter_mismatch` does
**not** auto-clear — it stays until a human resolves the underlying data, which is the point.

## Confirm which invariant actually broke (read-only)

`counter_mismatch` only covers counter drift (I4). The full set is the six invariant views, and only a
subset of them being violated tells you *what kind* of problem you have. Run the same checks the alert
and the CI gate use:

```powershell
npm run invariants -- --quiescent
# PASS  app.inventory_row_invariant_violations (I1/I2)   capacity partition intact
# PASS  app.live_allocation_violations         (I3)      no over-allocation vs capacity
# PASS  app.counter_drift_violations           (I4)      reserved/sold == reservation rows
# PASS  app.duplicate_booking_violations       (I5)      no booking booked twice
# PASS  app.idempotency_violations             (I6)      replay-consistent responses
# PASS  lab.live_allocation_violations         (L3)      LAB schema only (see below)
# all invariants hold  -> exit 0 ; any FAIL -> exit 1 and names the view
```

Then read the offending rows directly (never guess the magnitude from a count):

```powershell
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT * FROM app.counter_drift_violations;"                      # I4: reserved/sold vs live rows
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT * FROM app.live_allocation_violations;"                    # I3: live holds exceed capacity
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT kind, tier_id, detail, created_at `
     FROM reconciliation_findings WHERE resolved_at IS NULL ORDER BY created_at DESC;"
```

## Diagnose by *which* view failed

- **I1/I2 (inventory_row) fails** — a single row is internally inconsistent (`available + reserved + sold
  ≠ capacity`, or a negative). This is near-impossible via normal paths (the CHECK constraints and
  triggers enforce it) and almost always means a hand-edit, a partial migration, or a genuine code defect.
  **Stop writes to that tier**, treat as P1.
- **I3 (live_allocation) fails on `public`** — more live holds than capacity: a real over-allocation. P1.
  This is the invariant the safe strategies are *proven* to never violate (see the benchmark and
  strategy-comparison reports). If it trips in production, you have an oversell and must freeze the tier.
- **I3/L3 fails only on the `lab` schema** — expected: it is how the `unsafe_lab` baseline demonstrates a
  lost update, isolated by [ADR-0009](../adr/0009-unsafe-lab-isolation.md). `public` untouched is the pass
  condition. `npm run seed -- --experiment` re-resets the lab fixture.
- **I4 (counter_drift) fails** — counters drifted from the reservation rows they summarize. `app.counter_drift_violations`
  already exposes both sides side-by-side (`reserved` vs `pending_qty`, `sold` vs `confirmed_qty` per tier),
  so read the authoritative numbers straight from it rather than hand-rolling a join:
  ```powershell
  docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
    "SELECT tier_id, reserved, pending_qty, sold, confirmed_qty `
       FROM app.counter_drift_violations;"
  ```
  The counters (`inventory.reserved`/`sold`) are the cache; `pending_qty`/`confirmed_qty` are derived from
  the live `reservations`/`bookings` rows. The **rows** are the truth — never "fix" the drift by editing the
  counter to match a stale value. (A booking links to its tier only through `reservations`, so do not assume
  `bookings.tier_id` exists — it does not.)
- **I5 (duplicate_booking) / I6 (idempotency) fail** — a booking was created twice or a replayed request
  returned a different response. Check `consumed_events` / `idempotency_records` for the affected key.

## Act

1. **Establish the DB truth first** (the queries above). The counter is a cache; the reservation/booking
   rows are the facts.
2. **Do not edit counters to match the cache.** If I4 drift is real, the fix is the code path or the
   transaction that produced it, plus a *reviewed* data correction performed as a **migration**
   ([migrations.md](migrations.md)) so it is versioned, checksummed and reversible — not an ad-hoc `UPDATE`.
3. **If I3 public fired**, freeze the tier (`status` off sale) before anything else so you stop widening
   the hole, then recover seats by cancelling the excess bookings through the normal (audited) path.
4. Resolve the `counter_mismatch` finding only after the data is fixed; there is no auto-resolve by design.

## Verify

```powershell
npm run invariants -- --quiescent            # all PASS, exit 0
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT count(*) AS open_findings FROM reconciliation_findings WHERE resolved_at IS NULL AND kind='counter_mismatch';"
curl.exe -s http://127.0.0.1:4000/metrics | Select-String 'invariant_violations'   # back to 0
```

## Notes

- The reconciler runs on the worker's sweeper tick (`SWEEPER_INTERVAL_MS`, default 15000ms) in
  `apps/worker/src/main.ts`; if the worker is down, findings go stale rather than false — see
  [worker-failure.md](worker-failure.md).
- `reconciliation_findings` is de-duplicated by `NOT EXISTS` on an unresolved finding of the same subject,
  so a persistent condition records once, not spam.
