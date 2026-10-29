# Phase 6 — Observability and benchmarking

Status: **done**. Implements the pack's Phase 6 (line 167): *"Prometheus/Grafana/traces, k6, repeatable
comparisons and performance investigation. Gate: documented actual results, system metrics and SQL
invariant evidence."* This phase did not add a business feature — it made the existing system *measurable*
and then measured it for real. Every number below was produced on this checkout against a live API and a
live worker; nothing is an estimate.

The headline: a dependency-free Node HTTP benchmark harness drove the **real** reservation API under
1,000–1,500 concurrent buyers against 88/100/1,200-seat tiers. **Zero oversells in every run, `invariant_
violations` at 0 throughout, and all six SQL invariants PASS after the burst** — even when pool saturation
produced genuine HTTP 500s. The four metrics that were declared-but-never-emitted (outbox backlog/age, job
retries, lock waits) are now wired into the architecturally-correct home: the **worker** process.

Gate evidence is at the bottom, measured. Every claim above it maps to a re-runnable file or command.

## Boundaries (what we deliberately do NOT change)

- **The API/worker process split is respected ([ADR-0001](../adr/0001-modular-monolith-workspaces.md)).**
  Metrics only the worker can observe (outbox, BullMQ retries, DB-wide lock waits) live in a *second*
  prom-client registry in `apps/worker`, exposed over a purpose-built `node:http` `/metrics` server — not
  Express, because the worker owns no HTTP layer. Prometheus scrapes two targets; the registries never
  overlap. Nothing in `apps/worker` imports from `apps/api`.
- **No fabricated load.** k6 is **not installed** on this workstation and binaries may not be downloaded, so
  [`load-tests/flagship-booking.js`](../../load-tests/flagship-booking.js) ships as a clearly-labelled
  *as-code, not-run-here* declarative profile. The measured results come from the Node harness that drives
  the identical reserve→checkout HTTP flow. The report says this out loud rather than passing off one as the
  other (a standing lesson from the Phase 3 report's "no HTTP layer" limitation).
- **High-cardinality labels are banned.** Both registries label only bounded enums — route *template*
  (`/api/v1/reservations/:id`), status class, strategy, outcome, lock type, pool state, queue lane. No
  `user_id`/`booking_id`/`request_id` ever reaches a metric.
- **Liveness ≠ readiness, still.** The worker exposes `/health/live` (process up) and the API keeps
  `/health/live` vs `/health/ready` (dependencies). The Phase-6 `WorkerMetricsStalled` alert keys off the
  *tick outcome rate*, not a heartbeat file — a wedged loop is invisible to a naive liveness probe.

## Mechanism

1. **A second registry, in the right process.** `apps/worker/src/metrics.ts` defines `WorkerMetrics` (its own
   `Registry`, `collectDefaultMetrics({ prefix: 'ticketflow_worker_' })`) and `sampleLockWaits(pool)`.
   `apps/worker/src/metrics-server.ts` starts a minimal `node:http` server serving `/metrics` and
   `/health/live` on `WORKER_METRICS_PORT` (default 9464). `main.ts` runs one sampling loop
   (`METRICS_SAMPLE_MS`, default 5s) that sets the outbox backlog/age gauges from the *same*
   `backlogOf(pool)` query the readiness probe uses, sets the worker pool gauges, samples lock waits, and
   increments `worker_ticks_total{loop="metrics",outcome}`. Job retries/dead-letters increment in
   `queues.ts moveToDead`. The four dead API metrics were **removed** from `apps/api/.../metrics.ts` (they
   were never emitted there) — their real home is the worker.
2. **PostgreSQL 18 lock waits.** PG 18 dropped `wait_time` from `pg_stat_activity`. The sampler derives the
   elapsed wait as `clock_timestamp() - a.state_change` for backends with `wait_event_type='Lock'` joined to
   un-granted `pg_locks`. The first version queried the missing column and threw on *every* tick (surfacing
   as `ticks{outcome="error"}`) — caught at runtime, fixed, and re-scraped to prove `outcome="ok"`. This is
   exactly why the tick-outcome counter (not just a boolean health check) earns its place.
3. **Monitoring as code.** `infra/prometheus/prometheus.yml` gained a `ticketflow-worker` scrape job
   (`worker:9464`, `component="worker"`) and a `rule_files` reference. `infra/prometheus/alert-rules.yml`
   (new) ships 7 rules across delivery / consistency / saturation, each keyed off a metric that actually
   exists. `compose.yaml` mounts the rules file and publishes the worker metrics port. The Grafana dashboard
   (`infra/grafana/dashboards/ticketflow-core.json`) gained four panels: outbox backlog/age, job
   retries/dead-letters, lock-wait p50/p95/p99, and worker tick rate by outcome.
4. **The harness.** `scripts/benchmark.ts` (`npm run bench`) is dependency-free `node:http`, keep-alive off,
   a bounded worker pool of `concurrency`. It measures `startAvailable` from `/events/:id/tiers` (never
   assumes the fixture), probes `/health/ready` and aborts rather than emitting an empty success, asserts
   `confirmed ≤ startAvailable`, and writes a per-request CSV plus a JSON containing the aggregate and the
   full before/after `/metrics` text. Idempotency keys are salted per-run (see the finding below).

## Findings that changed the code (measured, not theoretical)

- **Fixed idempotency keys made runs non-comparable.** The first harness reused `bench-reserve-<index>`
  across runs; a re-run showed 88 spurious `409 idempotency_key_reuse`. Because "repeatable comparisons" is
  a Phase-6 requirement, the harness now salts keys with each run's unique `stamp`. This was found *by*
  running the benchmark twice, and the fix is in `scripts/benchmark.ts`.
- **Under saturation the system fails safe, not oversold.** The canonical 1,500-vs-1,200 run at concurrency
  120 drove `pg_pool_connections{state="waiting"}` from 0 → 100 and produced 62 HTTP 500s, all clustered at
  ~5.00s = `PG_CONNECTION_TIMEOUT_MS=5000` (connection acquisition). `invariant_violations` stayed 0 and
  `npm run invariants` was all-PASS afterward. Full write-up:
  [../experiments/http-booking-benchmark.md](../experiments/http-booking-benchmark.md).

## Verification

### Acceptance suite (`npm run verify`) — measured on this checkout

```
================ verify summary ================
PASS  build (workspaces)            PASS  unit tests            (89 passed / 13 files)
PASS  typecheck (strict)            PASS  integration tests     (119 passed / 11 files, real PostgreSQL)
PASS  lint                          PASS  boot smoke            (8/8 checks vs built artifact)
verify PASSED
```

No regression against the Phase 5 baseline (89 unit / 119 integration / 8 boot-smoke are identical counts).
Playwright e2e re-run green: `8 passed (1.9m)` — including "books two seats end-to-end", which is why the
benchmark had to restore seeded catalog inventory afterward (it had sold the fixture dry).

### The two registries, scraped live (metric families this phase guarantees)

API `:4000/metrics` (request rate, latency histogram, booking outcomes, pool, retries, invariants):

```
ticketflow_http_requests_total · ticketflow_http_request_duration_seconds
ticketflow_transaction_duration_seconds · ticketflow_tx_retries_total · ticketflow_tx_retries_exhausted_total
ticketflow_pg_pool_connections · ticketflow_pg_pool_errors_total
ticketflow_reservation_outcomes_total · ticketflow_idempotency_outcomes_total
ticketflow_inventory_invariant_violations · ticketflow_experiment_requests_total
```

Worker `:9464/metrics` (the four wired-in signals + liveness counter), observed under load
([`artifacts/worker-metrics-under-contention.txt`](../experiments/artifacts/worker-metrics-under-contention.txt)):

```
ticketflow_outbox_unpublished · ticketflow_outbox_oldest_age_seconds
ticketflow_worker_job_retries_total · ticketflow_worker_dead_letters_total
ticketflow_pg_lock_wait_ms            ← sampled from pg_stat_activity (PG 18 state_change form)
ticketflow_worker_pg_pool_connections · ticketflow_worker_ticks_total{loop,outcome}
```

Together these cover every metric the pack names: request rates, latency histograms, booking outcomes, lock
waits, DB pool utilisation, queue lag (outbox backlog/age), job retries, outbox age, and reconciliation
mismatches (`inventory_invariant_violations`).

### Real benchmark result (Node harness over HTTP) — measured

```
canonical 1,500 buyers vs 1,200 seats, concurrency 120, RATE_LIMIT_MAX raised:
  confirmed 1148 ≤ startAvailable 1200   oversellViolation = false
  sold_out 290 · 62 HTTP 500 (pool acquisition timeout, ~5.00s each) · invariant_violations 0
  reserve p50/p95/p99 = 3830 / 5429 / 5890 ms   checkout p50/p95/p99 = 4722 / 5972 / 6565 ms
  throughput 29.22 e2e ops/s · pg pool waiting 0 → 100
  worker under the same burst: outbox_unpublished 22 / oldest_age 1s ;
    pg_lock_wait_ms{tuple} count 253 sum 88763ms ; {transactionid} count 14 sum 9405ms
npm run invariants -- --quiescent   ->  PASS I1/I2 I3 I4 I5 I6 L3, all invariants hold
```

Two smaller runs (88-seat and 100-seat flagship) are recorded alongside it in
[../experiments/http-booking-benchmark.md](../experiments/http-booking-benchmark.md); the raw JSON/CSV
artifacts are committed under [../experiments/artifacts/](../experiments/artifacts/).

### Config validated as files (not by booting the whole stack)

Per the chosen scope, Prometheus/Grafana/OTel config was verified by *parsing* (YAML/JSON load) and by
direct `/metrics` scrapes, not by standing up the monitoring stack. Alert rules reference only metrics that
were observed in the scrapes above; the operator response for each alert is a file under
[../runbooks/](../runbooks/README.md).

## Limitations & hardening backlog

- **n = 1 per scenario.** Correctness is well supported (three runs, zero oversell, invariants 0); latency is
  indicative of the *shape* (pool-dominated tail), not a ranking — one machine, `cpus: 8`, shared with the
  dev server and containers. More repeats belong to a k6 run where k6 exists.
- **k6 not executed here** (not installed; downloads disallowed). The Node harness is the measured path; the
  k6 script is the portable re-expression.
- **`GIT_SHA` unset**, so no run is attributable to a revision — a prerequisite for the Phase 7
  reproducibility gate.
- **Redis runs `volatile-lru`**, which BullMQ warns should be `noeviction`; fine for a lab, a production fix.
- **Prometheus/Grafana are wired but not brought up** in this phase's verification; the config is as-code and
  parse-validated, the scrapes were direct. A full-stack smoke is a hardening item.

---

Previous: [Phase 5 — UI and lab](phase5-plan.md) ·
Next: [Phase 7 — Hardening and publication](phase7-plan.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md)
(the Phase 7 reproducibility/video gate is now implemented and met).
