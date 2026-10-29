# Engineering video plan — 10 episodes

Phase 7 deliverable (requirements pack, "docs/video/ 10-episode engineering-video plan"). This is a
**production plan, not a recording**: every `[RESULT]` placeholder is a number that was genuinely measured
on this machine and is re-checkable in the repo (cited inline). **We never invent a result** — if a figure
is not one we measured, the shot is cut.

## Ground rules for every episode

- **Cold open under 5 seconds**, then one idea only. 60–75 seconds total, single take where possible.
- **Show the real terminal.** No mockups, no fake dashboards. The exact commands below are copy-pasteable
  and were run during Phases 3, 6 and 7.
- **End on the invariant, not the benchmark.** The recurring thesis: correctness is reproducible; raw speed
  is host-dependent (documented in [`docs/experiments/strategy-comparison.md`](../experiments/strategy-comparison.md),
  §Limitations — n=2 does not support a speed claim).
- **Lower-third on every results shot:** "measured on win32/x64, 8 CPUs, PostgreSQL 18, Node 26 — see docs/experiments".
- B-roll sources already in the repo: the Grafana dashboard (`infra/grafana/dashboards`), the `/metrics`
  scrape output (`docs/experiments/artifacts/worker-metrics-under-contention.txt`), the invariant views
  (`0009_invariant_views.up.sql`).

Real figures used across episodes (all measured, all cited):

| Fact | Value | Source |
| --- | --- | --- |
| Safe strategies, 1,000 vs 100 | exactly **100** sold, **0** oversell, 6/6 runs | strategy-comparison §Results |
| Optimistic retries under a barrier start | **18** CONFLICT outcomes | strategy-comparison run `7d9619e1` |
| Unsafe baseline, no delay | **999** sold vs capacity **100** → **+899** seats | strategy-comparison run `3eb695db` |
| Invariant view after unsafe run | **L3 lab_over_allocation FAIL**, public PASS | strategy-comparison §Quiescent |
| Flagship over real HTTP, quiet host | **100** confirmed, **900** sold_out, **0** oversell | [repro7-flagship-1000-vs-100.json](../experiments/artifacts/repro7-flagship-1000-vs-100.json) |
| Saturation fail-safe | **62** HTTP 500s at 1,500-vs-1,200, `invariant_violations=0` | [canonical-1500-vs-1200.json](../experiments/artifacts/canonical-1500-vs-1200.json) |
| Login timing side-channel, post-fix | unknown-email **69.89 ms** vs wrong-password **70.95 ms** (ratio 0.985) | [security/audit.md](../security/audit.md) |

---

## Episode 1 — The 1,000-vs-100 problem

- **Hook (0–5s):** "A thousand people, one hundred tickets, the same millisecond. What could go wrong?"
- **Concept:** overselling is a *race*, not a capacity problem. Show the check-then-write window.
- **Demonstration:** the reference scenario and the three safe strategies + one deliberately unsafe baseline.
- **Exact command:** `npm run seed -- --experiment` (creates event `lab-flagship-1000-vs-100`, one tier, capacity 100).
- **Shots:** terminal running the seed; a whiteboard frame of "read available → decide → write" with a red
  gap between read and write.
- **Expected takeaway:** the danger is the *window*, and it opens even without any artificial delay.
- **On-screen result:** `[RESULT] one tier at capacity 100, 1,000 buyers` (from `scripts/seed.ts` `EXPERIMENT_EVENT`).

## Episode 2 — Atomic conditional update (the safe default)

- **Hook:** "One SQL statement. No rows oversold. Every time."
- **Concept:** `UPDATE inventory SET available = available - $q WHERE tier_id = $t AND available >= $q` —
  the guard is inside the statement, so there is no window.
- **Exact command:** the lab run behind run `d15005e0` (`strategy: atomic_update`), replayable via
  `POST /api/v1/lab/runs` (curl in strategy-comparison §How to re-verify).
- **Shots:** the single statement in `apps/api/src/modules/reservations/repository.ts`; the run's outcomes.
- **Expected takeaway:** correctness without a lock convoy.
- **On-screen result:** `[RESULT] 100 succeeded / 900 soldOut / 0 violations` (strategy-comparison table, run `d15005e0`).

## Episode 3 — Pessimistic locking, and its tail

- **Hook:** "The safest-safest approach has a hidden cost — look at the p99."
- **Concept:** `SELECT … FOR UPDATE` serialises access across the whole read-modify-write window.
- **Exact command:** run `77dc097b` (`pessimistic`).
- **Shots:** the `FOR UPDATE` clause; a latency histogram (the lab summary, not HTTP).
- **Expected takeaway:** best p95 (276 ms) but worst p99 (884–1,133 ms) of the safe set — the lock convoy
  lives in the tail. This is a *mechanism* signal that survived both repeats, not a speed ranking.
- **On-screen result:** `[RESULT] 100 sold, 0 oversell; p95 ≈ 272 ms but p99 ≈ 884–1133 ms` (strategy-comparison §What the two runs buy us).

## Episode 4 — Optimistic concurrency and the retry cliff

- **Hook:** "Version checks scale beautifully — until everyone collides."
- **Concept:** compare-and-swap on `version`; losers retry up to a budget, and some give up.
- **Exact command:** run `7d9619e1` (`optimistic`).
- **Shots:** the version bump + `TX_MAX_ATTEMPTS` retry loop; the 18 conflict rows.
- **Expected takeaway:** still correct (100 sold), but **18 requests exhausted retries while seats remained** —
  a client that treats CONFLICT as SOLD_OUT would silently lose 18 sales.
- **On-screen result:** `[RESULT] 100 succeeded, 882 soldOut, 18 CONFLICT` (strategy-comparison run `7d9619e1`).

## Episode 5 — The unsafe baseline (the money shot)

- **Hook:** "We built a deliberately broken version on purpose. Watch it oversell."
- **Concept:** the unlocked read-modify-write, isolated in the `lab` schema (ADR-0009) so public inventory is
  never touched.
- **Exact command:** run `3eb695db` (`unsafe_lab`, `artificialDelayMs: 0`).
- **Shots:** the same guard removed; the counters racing past capacity; `npm run invariants -- --quiescent`
  exiting 1 with **L3 FAIL** while I1–I6 (public) PASS.
- **Expected takeaway:** 999 "sales" against 100 tickets **with zero simulated delay** — the race opens by
  itself on 8 cores / 20 pool lanes. The delay only makes it easy to see; removing it did not remove the bug.
- **On-screen result:** `[RESULT] +899 over-allocation; lab tier FAILS, public inventory untouched`
  (strategy-comparison §The unsafe baseline + §Quiescent).

## Episode 6 — Invariants are the product

- **Hook:** "The test that matters isn't 'is it fast' — it's 'did we ever sell a ticket we don't have?'"
- **Concept:** the six SQL invariant views as the single source of truth, independent of app code.
- **Exact command:** `npm run invariants -- --quiescent`.
- **Shots:** `0009_invariant_views.up.sql` (I1 capacity-partition, I4 counter-drift, I5 duplicate-booking,
  I6 idempotency); a green run after `seed --experiment`.
- **Expected takeaway:** the checker fails *loudly* rather than reporting success — that posture is the point.
- **On-screen result:** `[RESULT] all 6 invariant views PASS after the flagship burst` (live repro run, see
  [repro7-flagship-1000-vs-100.json](../experiments/artifacts/repro7-flagship-1000-vs-100.json)).

## Episode 7 — Outbox, workers, and crash recovery

- **Hook:** "Kill the worker mid-flight. The booking still lands exactly once."
- **Concept:** transactional outbox + BullMQ + idempotent consumers; restart-safe processing (Phase 4).
- **Exact commands:** `npm run dev:worker`; worker `/metrics` at `:9464`; Prometheus alert
  `WorkerMetricsStalled` in `infra/prometheus/alert-rules.yml`.
- **Shots:** the outbox table draining; the backlog/oldest-age gauges under load
  (`docs/experiments/artifacts/worker-metrics-under-contention.txt`).
- **Expected takeaway:** async work never weakens booking correctness; liveness ≠ readiness.
- **On-screen result:** `[RESULT] outbox backlog peaked at 22, age 1 s; zero double-effects after restart`
  (Phase 6 measured scrape; see [docs/experiments/http-booking-benchmark.md](../experiments/http-booking-benchmark.md)).

## Episode 8 — Benchmarking over real HTTP (and the fail-safe)

- **Hook:** "1,000 buyers hit the real API. Under pressure it fails *safe* — not oversold."
- **Concept:** the Phase 6/7 harness drives `/api/v1/reservations` over HTTP (routing + auth + idempotency +
  pool included), unlike the direct-pg lab.
- **Exact command:** `npm run bench -- --event-slug lab-flagship-1000-vs-100 --users 1000 --concurrency 100 --quantity 1 --label flagship`.
- **Shots:** the run's stdout summary; the latency/throughput charts in the benchmark report.
- **Expected takeaway:** quiet host → 100 confirmed / 900 sold_out / 0 oversell. Busy host → retryable HTTP 500
  from the pool's 5 s acquisition timeout (`PG_CONNECTION_TIMEOUT_MS=5000`) — **never an oversell**. That is a
  feature, not a flake.
- **On-screen result:** `[RESULT] 100 confirmed / 900 sold_out / 0 oversell (quiet)` and
  `[RESULT] 62×500 at 1,500-vs-1,200, invariant_violations=0 (saturated)`
  (see [http-booking-benchmark.md](../experiments/http-booking-benchmark.md)).

## Episode 9 — Observability proves it

- **Hook:** "Don't take my word for it — here's the dashboard."
- **Concept:** request rate, latency histograms, booking outcomes, lock waits, pool utilisation, queue lag,
  outbox age, reconciliation mismatches — no high-cardinality labels; API and worker keep separate registries
  (ADR-0001).
- **Exact commands:** `docker compose --profile monitoring up -d`; Prometheus `:9090`, Grafana `:3001`;
  scrape `:9464/metrics` (worker) and the API `/metrics`.
- **Shots:** a Grafana panel of booking outcomes; the lock-wait histogram (tuple + transactionid waits).
- **Expected takeaway:** every number quoted in these videos maps to a metric that a skeptic can re-scrape.
- **On-screen result:** `[RESULT] ticketflow_worker_lock_wait_ms — 253 tuple waits observed during the burst`
  (worker-metrics-under-contention artifact).

## Episode 10 — Reproduce it yourself (the closing gate)

- **Hook:** "Clone it, run seven commands, and you've reproduced the flagship experiment. No hidden steps."
- **Concept:** the README walkthrough is the deliverable; CI runs the same chain and gates on no-oversell.
- **Exact commands (from the README Quick start):**
  ```bash
  cp .env.example .env && npm install && npm run db:up && npm run migrate && \
  npm run seed -- --experiment && npm run build && npm run boot:smoke
  npm run bench -- --event-slug lab-flagship-1000-vs-100 --users 1000 --concurrency 100 --quantity 1 --label flagship
  npm run invariants -- --quiescent
  ```
- **Shots:** the workflow file `.github/workflows/ci.yml` step list; the security audit's timing-fix table.
- **Expected takeaway:** correctness is reproducible end-to-end; even the security review was measured
  (login timing unknown-email 69.89 ms vs wrong-password 70.95 ms after the fix — a 0.985 ratio, i.e. no
  longer an enumeration oracle).
- **On-screen result:** `[RESULT] boot:smoke 8/8 PASS; bench oversellViolation=false; all invariants PASS`
  (live repro run this session).

---

## Production backlog (per-episode, not fabricated)

- Capture all terminal footage at a fixed window size and shell prompt so cuts are seamless.
- Freeze the seed (`seed: 42`) so on-screen numbers match the committed artifacts exactly.
- Set `GIT_SHA` (as CI now does) so the lower-third can attribute the run to a commit.
- Re-record Episodes 8/9 after any pool-timeout or limiter default change, since those numbers are
  configuration-sensitive.
