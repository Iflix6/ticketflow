# Phase 3 — Comparative strategies and the isolated unsafe lab

Status: **done**. Gate (master pack §Implementation phases): *"safe variants never oversell in repeated
controlled experiments; unsafe behavior accurately observed or limitations reported."* Both halves were
met with measurements, and the limitations are reported rather than smoothed over — see
[docs/experiments/strategy-comparison.md](../experiments/strategy-comparison.md) for the flagship numbers.
ADR in force: 0009 (unsafe lab isolation).

## What the four strategies actually differ by

They are the **same workload** with a different guard around the read-modify-write, which is what makes
the comparison meaningful (`modules/experiments/runner.ts`):

| id | guard | where the decision is taken | failure mode it accepts |
| --- | --- | --- | --- |
| `atomic_update` (Safe A) | `WHERE available >= $qty` inside the mutating UPDATE | database, in one statement | none; losers get `SOLD_OUT` |
| `pessimistic` (Safe B) | `SELECT … FOR UPDATE` first, then decide, then write | database, via held row lock | lock waits (measured as latency, not errors) |
| `optimistic` (Safe C) | `WHERE version = $read AND available >= $qty`, bounded retry with seeded jitter | application decides, database arbitrates | `CONFLICT` when the retry budget (`TX_MAX_ATTEMPTS + 2`) is exhausted while seats remain |
| `unsafe_lab` | **none** — unlocked read → `pg`-side artificial delay → blind write of stale-derived values | application only, on a snapshot already out of date | lost updates → over-allocation |

Two design points that matter more than the SQL:

- Safe C reports `CONFLICT` and `SOLD_OUT` as **different outcomes**, because conflating them is how a load
  test hides a contention bug (`reserveOptimistic` returns `SOLD_OUT` the moment a re-read shows
  `available < quantity`, and only reports `CONFLICT` after burning the budget).
- `unsafe_lab` is deliberately **not wrapped in a transaction** (`attemptUnsafe`), and it is the only place
  in the codebase where that is true. Its successful attempts are recorded with
  `failure_class = 'lost_update_overallocation'` — an anomaly tag on a "successful" row — so the history
  cannot be read as clean sales.

## Isolation (ADR-0009) — three independent locks

1. **Schema.** The runner writes only `lab.inventory` / `lab.reservations` (`0008_lab_schema.up.sql`), never
   public `inventory`. The lab CHECK constraints are byte-for-byte the same invariants as public —
   *the experiment is unsafe because of its code path, not because the schema was weakened*, which is the
   teaching point of the module.
2. **Service-layer refusal on both entry points.** The reservation path checks `PUBLIC_STRATEGIES`
   (= `SAFE_STRATEGY_IDS`) before a transaction opens, and `LabService.createRun` re-checks
   `unsafe_lab ⇒ LAB_ENABLED && NODE_ENV !== 'production'`. Two guards, so they cannot drift into
   disagreeing about whether the unsafe baseline may touch public inventory. An unrecognised strategy id
   gets the same 422 `strategy_unavailable` as `unsafe_lab`, because the contract types `strategy` as a
   bounded **string**, not an enum (`packages/contracts/src/domain.ts`) — verified live by
   `tests/integration/openapi-parity.test.ts`.
3. **Mount + role + gate.** `/api/v1/lab` (and `/api/v1/auth`) are **not registered at all** unless
   `isLabEnabled` (`LAB_ENABLED && NODE_ENV ∈ {local, test, ci}`). When mounted, the whole router sits
   behind `authenticate` → `requireRole('LAB_ADMIN')` → `labGate` — including the read-only endpoints, so
   `GET /api/v1/lab/runs` answers 401 without a token and 403 for a `CUSTOMER`. (That was not a guess: the
   parity suite initially assumed the list was anonymous and the live server returned 401.)

Determinism comes from SQL: `lab.tier_id(seed, index)` is `md5('lab-tier-' || seed || '-' || index)::uuid`,
so "same seed" means the same rows across strategies and machines, and `lab.reset_fixture(seed, capacity,
tier_count)` performs the whole reset in one function call so the HTTP endpoint and the test harness cannot
leave a half-reset state.

## How the measurement is taken (and what that excludes)

`LabService.createRun` executes a run **synchronously in-process**: reset fixture → `insertRun` →
`markRunRunning` → fire attempts → `recordResults` → `finalizeRun`. Then:

- `concurrentUsers` attempts are drained by `lanes = min(concurrentUsers, dbPoolMax)` workers pulling from
  a shared cursor, so a 1,000-buyer fan-out queues on the connection pool instead of exhausting it. With
  `rampMs = 0` starts are a barrier (all lanes fire together); a positive ramp staggers linearly.
- Latency is `process.hrtime.bigint()` around `attempt()` only — **µs-resolution, per-attempt, in-process**.
  `throughputPerSecond` is `attempts / wall duration`. Jitter uses a seeded mulberry32 PRNG so a given seed
  reproduces the same retry timing.
- Every thrown error is classified onto the taxonomy (`classifyThrown`): `40001`/`55P03` → CONFLICT,
  `40P01` → CONFLICT+deadlock, `23514` → SERVER_ERROR+`invariant_violation_failed_insert`, `23505` →
  DUPLICATE, `57014` → TIMEOUT+timeout. So a constraint that *does* fire shows up as a failure class, not a
  phantom sale.
- The run's `invariantViolations` is counted by `lab.live_allocation_violations` (`0009_invariant_views.up.sql`)
  — **the same over-allocation standard the safe path is judged by**. That symmetry is the point: the unsafe
  baseline is not given a custom definition of correctness.
- `experiment_runs` records `configuration`, `environment`, `git_sha`, `host_info`, `outcomes`,
  `report_paths`. Once `finished_at` is set, the `experiment_runs_enforce_immutability` trigger raises
  **SQLSTATE TF002** on any UPDATE *or DELETE* — a completed summary cannot be quietly edited, and a failed
  run is finalised `FAILED` with `outcomes = null` rather than looking half-good.

## Verification — commands run, output measured

```
npx vitest run --config vitest.integration.config.ts \
  tests/integration/comparative-strategies.test.ts tests/integration/openapi-parity.test.ts
  ✓ comparative-strategies.test.ts   11 passed  (3868 ms)
  ✓ openapi-parity.test.ts           23 passed  (3124 ms)
  Test Files 2 passed (2)   Tests 34 passed (34)   Duration 14.30 s      # vitest 3.2.7, Node v26.1.0
```

The claims that carry the gate, from inside that suite:

- Safe A, capacity 10 / 30 users: `succeeded === 10`, `soldOut === 20`, `conflict === 0`,
  `serverError === 0`, `invariantViolations === 0`, and `labViolations() === 0` by independent SQL; counters
  satisfy `available + reserved + sold === capacity` with `reserved === 10`.
- Safe B, capacity 8 / 24 users: `succeeded === 8`, zero violations.
- Safe C, capacity 6 / 18 users: `succeeded ≤ 6`, `succeeded + soldOut + conflict === 18` (the three
  outcomes are exhaustive and distinct), zero violations.
- Unsafe, capacity 5 / 15 users / `artificialDelayMs: 40`: `succeeded > capacity` **and**
  `invariantViolations ≥ 1`, with more `lost_update_overallocation` rows than capacity — i.e. the anomaly is
  observed, not asserted in prose.
- Run history is readable and paginated; a `CUSTOMER` is 403 on the lab mount; a completed run rejects
  tampering (`/immutable/`); `POST /api/v1/lab/fixtures/reset` returns `invariantViolations: 0`.

Repeated runs (the gate says *repeated*): the flagship 1,000-vs-100 scenario was executed **twice per
strategy** through the real HTTP lab API, four runs each for the safe strategies' variance picture — all
eight result sets are in [docs/experiments/strategy-comparison.md](../experiments/strategy-comparison.md),
including the two runs whose numbers disagree with each other.

## Limitations reported (per the gate's own wording)

- **No HTTP layer in the measurement.** Lab attempts are direct database calls, so latency/throughput
  numbers exclude JSON serialization, routing, auth and rate limiting. They are comparable *across
  strategies*, not a claim about end-to-end API throughput. The k6 work in Phase 6 measures the HTTP path.
- `invariantViolations` counts **violating rows** from a per-tier grouped view — with the single-tier
  fixture the lab uses, that is 0 or 1 regardless of how many seats were over-allocated. Seat-level
  magnitude must be read from the counters, not from that field.
- There is **no lab counter-drift view**: `0009` exposes `lab.live_allocation_violations` (L3) only, while
  the advisory-lean I4 equivalent exists only for public inventory. In the lab, a lost update whose sum
  still partitions capacity is caught by L3 because live reservations exceed capacity — but a hypothetical
  drift that keeps both invariants true would be invisible there.
- `git_sha` was **null** in the recorded runs (`GIT_SHA` unset in the local environment), so those runs are
  not machine-attributable to a commit — reproducible by seed and configuration, not by revision.
- Runs are synchronous and in-process, so one long experiment blocks the request that started it; the
  queue-backed variant is explicitly deferred (ADR-0005 / Phase 4).

---

Previous: [Phase 2 — Safe core](phase2-plan.md) ·
Next: [Phase 4 — Async processing, outbox relay, recovery](phase4-plan.md) ·
Flagship measurements: [docs/experiments/strategy-comparison.md](../experiments/strategy-comparison.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md)
