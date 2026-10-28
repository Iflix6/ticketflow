# Strategy comparison — the flagship 1,000 buyers / 100 tickets experiment

Phase 3 deliverable. Requirements-gate wording: *"safe variants never oversell in repeated controlled
experiments; unsafe behavior accurately observed **or limitations reported**."* This report contains only
numbers that were actually produced by the lab runner and are still re-checkable in the database, plus the
limitations those numbers cannot answer.

Everything below was measured on the developer workstation described in §Environment. No figure is an
estimate, an extrapolation, or a value copied from another run.

## How to re-verify these numbers (no hidden manual steps)

The runs are stored in `experiment_runs`, and the `experiment_runs_enforce_immutability` trigger (SQLSTATE
TF002) rejects UPDATE *and* DELETE once a run is finished — so these rows are a durable record, not a
regenerated claim.

```powershell
# 1. Start the stack and make sure the lab is enabled (LAB_ENABLED=true, NODE_ENV=local).
npm run db:up ; npm run migrate ; npm run seed

# 2. Get a LAB_ADMIN token, then read the recorded flagship runs back:
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT strategy, left(id::text,8) AS run, configuration->>'artificialDelayMs' AS delay, outcomes `
   FROM experiment_runs ORDER BY started_at;"
```

A run cannot be created through the API without a token, and a `CUSTOMER` is rejected with 403 on that
mount, so the shortest reproduction path is:

```bash
# Verified live against `npm run dev:api` on the default local port (`.env`: PORT=4000).
TOKEN=$(curl -s -X POST http://127.0.0.1:4000/api/v1/auth/token \
  -H 'content-type: application/json' \
  -d '{"email":"lab@local.test","password":"local-demo-admin-2026"}' | jq -r .data.token)

curl -s -X POST http://127.0.0.1:4000/api/v1/lab/runs \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"strategy":"atomic_update","configuration":{"capacity":100,"concurrentUsers":1000,
       "quantityPerUser":1,"reservationTtlSeconds":300,"artificialDelayMs":0,"rampMs":0,
       "seed":42,"dbPoolMax":20,"isolation":"read_committed"}}' | jq .data.outcomes

# And the eight runs behind this report, straight from the same API:
curl -s -H "authorization: Bearer $TOKEN" 'http://127.0.0.1:4000/api/v1/lab/runs?pageSize=8' \
  | jq '.data[] | {id, strategy, status}'
```

(Replace `atomic_update` with `pessimistic`, `optimistic` or `unsafe_lab` to re-run the comparison. The
`password` above is the seeded local demo value `DEMO_ADMIN_PASSWORD` from `scripts/seed.ts`, overridable
with `TF_SEED_ADMIN_PASSWORD`; it is a local-only default and `@ticketflow/config` refuses to boot in
`production` with values that still look like it.)

## Configuration under test (identical for all eight runs except the delay)

```json
{ "capacity": 100, "concurrentUsers": 1000, "quantityPerUser": 1, "reservationTtlSeconds": 300,
  "rampMs": 0, "seed": 42, "dbPoolMax": 20, "isolation": "read_committed", "artificialDelayMs": 0 }
```

`unsafe_lab` #1 used `artificialDelayMs: 20`; `unsafe_lab` #2 used `0` (see §The unsafe baseline — it
matters more than the delay).

### Environment, captured by the runner itself (`host_info`)

| field | value |
| --- | --- |
| `platform` / `arch` | `win32` / `x64` |
| `cpus` | 8 |
| `totalMemoryMb` | 8007 |
| `node` | v26.1.0 |
| `postgresVersion` | 18.6 (`postgres:18-alpine`, via docker compose) |
| `environment` | `local` |
| `git_sha` | **null** — `GIT_SHA` was unset, so these runs are attributed by seed/configuration, not by revision |
| `pool` at record time | `totalCount` 20 (the `dbPoolMax` lanes); one row shows `totalCount` 1, the post-run drain |

## Results — safe strategies (two runs each)

`outcomes` as stored, verbatim. `succeeded + soldOut + conflict + timeout === attempted` in all eight runs.

| run | strategy | succeeded | soldOut | conflict | timeout | serverError | p50 ms | p95 ms | p99 ms | duration ms | req/s | invariantViolations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `d15005e0` | atomic_update | **100** | 900 | 0 | 0 | 0 | 42.962 | 353.306 | 889.272 | 4123 | 242.52 | 0 |
| `c8810059` | atomic_update | **100** | 900 | 0 | 0 | 0 | 70.777 | 262.979 | 586.955 | 5267 | 189.87 | 0 |
| `77dc097b` | pessimistic | **100** | 900 | 0 | 0 | 0 | 139.111 | 276.017 | 884.159 | 8020 | 124.69 | 0 |
| `247c827b` | pessimistic | **100** | 900 | 0 | 0 | 0 | 128.680 | 271.750 | 1133.392 | 7792 | 128.34 | 0 |
| `c7562e66` | optimistic | **100** | 900 | 0 | 0 | 0 | 35.340 | 334.999 | 604.200 | 3713 | 269.34 | 0 |
| `7d9619e1` | optimistic | **100** | 882 | **18** | 0 | 0 | 79.569 | 630.727 | 1309.866 | 8234 | 121.45 | 0 |

Independent cross-check on the same runs, from the stored per-request rows (not from the summary):

```
strategy        run        attempts  succeeded_rows
atomic_update   d15005e0       1000         100
pessimistic     77dc097b       1000         100
optimistic      c7562e66       1000         100
atomic_update   c8810059       1000         100
pessimistic     247c827b       1000         100
optimistic      7d9619e1       1000         100
```

**Gate claim supported:** in 6 of 6 safe runs, sales equalled capacity exactly — never more — with zero
violations reported by `lab.live_allocation_violations`, the same over-allocation view the safe path is
judged by. That is the "never oversell in repeated controlled experiments" half, measured.

**What the two runs per strategy buy us:** the safe strategies are consistent on correctness (100 every
time) but *not* on timing. `atomic_update` moved p50 from 42.962 ms to 70.777 ms between runs, and its
throughput fell from 242.52 to 189.87 req/s — a ~36 % spread on an identical seed and configuration. So:

- **Do not read ranking from these numbers.** On run #1 optimistic looks fastest (269.34) and pessimistic
  slowest (124.69); on run #2 optimistic is slowest (121.45) and pessimistic marginally fastest (128.34).
  The per-run ordering flips, which means the machine's noise floor is larger than the gap being compared.
  A repeat-count of 2 is not enough to support a performance conclusion — it is enough to support the
  correctness conclusion, because correctness did not vary at all.
- The one *mechanism-level* signal that survived both runs is pessimistic's latency profile: its p99
  (884 ms, 1133 ms) is the worst of the three safe strategies while its p95 (276 ms, 272 ms) is the
  *best*. That shape is what holding a row lock across the whole check-then-write window looks like: most
  requests queue briefly and predictably, and the tail is where the lock convoy shows. A Phase 6 k6
  benchmark with more repeats is the right place to turn that into a claim.
- `optimistic` run `7d9619e1` produced **18 CONFLICT outcomes**: 1,000 attempts, 100 succeeded, 882 sold
  out, 18 exhausted the retry budget (`TX_MAX_ATTEMPTS + 2`) while seats still existed. Its p99 (1309.866 ms)
  is the worst latency in the whole safe set, and it is the only safe run whose outcome counts do not split
  into just success/exhaustion. Reported as-is: optimistic *does* cost real retries under a barrier start,
  and a client that treated CONFLICT as SOLD_OUT would have silently lost 18 seats.

## The unsafe baseline — it matters more than the delay

| run | strategy | delay | succeeded | soldOut | timeout | serverError | p50 ms | p95 ms | p99 ms | duration ms | req/s | invariantViolations |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `35e0f871` | unsafe_lab | 20 ms | **1000** | 0 | 0 | 0 | 127.093 | 484.889 | 638.014 | 8756 | 114.21 | 1 |
| `3eb695db` | unsafe_lab | 0 ms | **999** | 0 | **1** | 0 | 203.401 | 1159.564 | 1920.591 | 16989 | 58.86 | 1 |

Per-request rows agree, and give the *magnitude* the summary field cannot:

```
strategy     run        blind_writes(failure_class=lost_update_overallocation)   attempts   excess_sales
unsafe_lab   35e0f871                                                1000            1000        +900 seats
unsafe_lab   3eb695db                                                 999            1000        +899 seats
```

Both runs over-allocated, and **the second one had no artificial delay at all**. That is the most important
observation in this report: the unlocked read-modify-write window does not need a simulated slow provider —
1,000 concurrent transactions on 8 cores / 20 pool lanes open the window by themselves. `artificialDelayMs`
only widens it to make the anomaly reliable and easy to see; removing it did not remove the bug. Run #2's
anomaly is even dirtier than run #1's: one attempt hit `statement_timeout` (`57014` → `TIMEOUT`, the only
timeout in all eight runs) while 999 blind writes still landed.

Every "successful" unsafe attempt is tagged `lost_update_overallocation`, so the history cannot be read as
1,000 legitimate sales.

## Quiescent invariant check

Immediately after an `unsafe_lab` run, on the same database:

```
npm run invariants -- --quiescent
  I1/I2 inventory_row   PASS      I4 counter_drift   PASS (public)
  I3 live_allocation    PASS      I5 duplicate_booking PASS
  I6 idempotency        PASS      L3 lab_over_allocation  FAIL — 1 row
  exit code 1
```

The tool fails loudly rather than reporting success, and the single failing row is the lab tier — public
inventory is untouched, which is ADR-0009 doing its job. After `npm run seed -- --experiment` (which calls
`SELECT lab.reset_fixture(42, 100, 1)` — the flagship fixture is one tier at capacity 100),
`npm run invariants -- --quiescent` reports **all invariants hold**.

## Limitations — stated, not hidden

- **`invariantViolations` is a row count, not a seat count.** The view groups per tier, so with the
  single-tier fixture the lab always reports 0 or 1. Run #1 sold 10× capacity and still shows `1`. Use the
  per-request `experiment_results` rows (or the counters) for magnitude. This is a reporting weakness in the
  current summary shape, not a missed violation.
- **No HTTP layer involved.** Lab attempts are direct `pg` calls through `ExperimentRunner`; latency
  excludes routing, serialization, auth and rate limiting, and is measured with `process.hrtime.bigint()`
  around `attempt()`. These are contention numbers, not API throughput numbers.
- **n = 2 is too few for a performance conclusion**, as shown by the 36 % intra-strategy spread above. The
  correctness claim (never exceed capacity) is well supported; any speed claim is not.
- **One machine, one PostgreSQL, `seed: 42` shared across all eight runs.** Same seed means comparable
  fixtures, but it also means all runs share one deterministic jitter sequence — optimistic's retry timing
  on run #1 and run #2 is therefore *not* an independent sample of jitter, only of machine state.
- **`git_sha` is null**, so none of these runs are attributable to a revision. Setting `GIT_SHA` before
  `npm run seed`/starting the API is a prerequisite for the Phase 7 reproducibility gate.
- **`report_paths` is empty `[]` for all eight runs.** The summary lives in the database; no file artifact
  (JSON/HTML report) was produced, so this markdown is currently the human-readable carrier.
- **The lab has no counter-drift view.** `0009_invariant_views.up.sql` exposes only
  `lab.live_allocation_violations` (L3). The unsafe runs above were caught by L3 because live reservations
  exceeded capacity; a drift pattern that preserved both capacity-partition and live-total would be
  invisible in the lab schema.
- **The lab fixture is currently re-seeded**, so `lab.inventory` no longer shows the post-run over-allocated
  counters. The evidence that persists is `experiment_runs.outcomes` + `experiment_results` (immutable),
  which is what the tables above were built from.
