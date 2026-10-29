# HTTP booking benchmark — the real reservation API under load

Phase 6 deliverable. Requirements-gate wording (pack line 167): *"Prometheus/Grafana/traces, k6,
repeatable comparisons and performance investigation. Gate: documented actual results, system metrics
and SQL invariant evidence."* This report contains **only numbers produced by the Node HTTP harness
against a live API**, plus the system metrics and SQL-invariant evidence that corroborate them, plus the
limitations those numbers cannot answer. No figure is estimated, extrapolated, or copied from another run.

This is the HTTP counterpart to [strategy-comparison.md](strategy-comparison.md). That report drives
`pg` directly through the lab runner and measures **contention at the data layer**; this one drives the
**real endpoints over HTTP** (routing, auth, idempotency, the connection pool, and the JSON boundary all
included) and measures **end-to-end request cost**. They complement each other; neither substitutes for
the other, and this document never presents one as the other.

## How to re-verify these numbers (no hidden manual steps)

The harness is `scripts/benchmark.ts`, run via `npm run bench`. It only runs against a live `base` URL and
**refuses to fabricate**: it probes `/health/ready` and exits 1 rather than emitting an empty success
artifact, and it reads `startAvailable` from `/events/:id/tiers` (never assumes the fixture size), then
asserts `confirmed <= startAvailable` — a breach fails the run.

```powershell
# 0. Data tier up, schema+seed applied.
npm run db:up ; npm run migrate ; npm run seed

# 1. Start an API with the rate limiter raised, or you measure the 429 limiter — not reservation contention.
#    (These runs used a dedicated API on :4101. The limiter is a fixed window of RATE_LIMIT_MAX/60s keyed
#     per actor; the default 120 would cap the benchmark far below 1,000 buyers.)
$env:RATE_LIMIT_MAX='100000'; $env:LAB_ENABLED='true'
npm run dev:api   # or a second instance pinned to :4101 with PORT=4101

# 2. Run the canonical scenario (1,500 buyers vs a 1,200-seat tier), reserve->checkout over real HTTP:
npm run bench -- --base http://127.0.0.1:4101 --event-index 1 --tier <uuid> --users 1500 --concurrency 120 --quantity 1

# 3. Prove the SQL correctness gate held *after* the burst:
npm run invariants -- --quiescent
```

Every run writes a `.json` (config + environment + aggregate + full before/after `/metrics` text) and a
per-request `.csv` under `load-tests/results/`. Those paths are gitignored (regeneration is the point), so
the **canonical run and the two comparison runs are copied into [`artifacts/`](artifacts/)** as the
committed, browsable evidence behind every number below.

The raw artifacts backing this report:

| file | what it is |
| --- | --- |
| [`artifacts/canonical-1500-vs-1200.json`](artifacts/canonical-1500-vs-1200.json) | canonical run: aggregate + before/after `/metrics` text |
| [`artifacts/canonical-1500-vs-1200.csv`](artifacts/canonical-1500-vs-1200.csv) | canonical run: all 2,700 per-request rows (`index,op,status,outcome,latencyMs,reservationId,errorCode`) |
| [`artifacts/flagship-88-vs-1000.json`](artifacts/flagship-88-vs-1000.json) | first flagship run (88 seats) |
| [`artifacts/flagship-100-vs-1000-worker-demo.json`](artifacts/flagship-100-vs-1000-worker-demo.json) | 100-seat run that first exercised the worker lock sampler |
| [`artifacts/worker-metrics-under-contention.txt`](artifacts/worker-metrics-under-contention.txt) | worker `/metrics` scraped *during* the canonical burst (outbox backlog + lock-wait histogram) |

## Environment (captured by the harness itself, `environment` block — identical across all runs)

| field | value |
| --- | --- |
| `platform` / `arch` | `win32` / `x64` |
| `cpus` | 8 |
| `totalMemoryMb` | 8007 |
| `node` | v26.1.0 |
| `base` | `http://127.0.0.1:4101` (dedicated benchmark API, `RATE_LIMIT_MAX=100000`, `LAB_ENABLED=true`) |
| PostgreSQL | 18.6 (`postgres:18-alpine`, docker compose) |
| `PG_POOL_MAX` / `PG_CONNECTION_TIMEOUT_MS` / `LOCK_TIMEOUT_MS` / `STATEMENT_TIMEOUT_MS` | 20 / 5000 / 2000 / 5000 (all defaults, `packages/config/src/index.ts`) |

The harness is dependency-free (`node:http`, keep-alive **off**, one socket per request) so connection-pool
queueing is genuinely exercised rather than hidden behind a client-side connection cap.

## Results — three measured runs

`confirmed <= startAvailable` and `oversellViolation=false` in **all three**. Latency in ms, HTTP-level.

| run | tier / seats at start | buyers | conc. | reserved | sold_out | confirmed | HTTP 500 | reserve p50/p95/p99 | checkout p50/p95/p99 | e2e ops/s | wall ms | oversell |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| flagship-88 | Single Seat, 88 | 1000 | 120 | 88 | 912 | **88** | 0 | 1201 / 4078 / 5512 | 3108 / 4350 / 4422 | 64.66 | 16826 | **no** |
| flagship-100 | Backstage, 100 | 1000 | 100 | 100 | 812¹ | **100** | 0 | 1728 / 3850 / 5059 | 4839 / 9240 / 9508 | 42.97 | 25599 | **no** |
| canonical | Reserved Seats, 1200 | 1500 | 120 | 1200 | 290 | **1148** | 62² | 3830 / 5429 / 5890 | 4722 / 5972 / 6565 | 29.22 | 92402 | **no** |

¹ `flagship-100` also recorded **88 `409 idempotency_key_reuse`** on reserve. That is a harness artifact, not a
system behavior: the first version of `benchmark.ts` used **fixed** per-index idempotency keys
(`bench-reserve-<index>`), so re-running reused the keys from an earlier run against the same actor and the
API correctly replayed/409'd them. **This was itself a Phase-6 finding** — fixed keys make two nominally
identical runs *non-comparable*, defeating "repeatable comparisons." The harness was fixed to salt keys with
each run's unique timestamp (`bench-<stamp>-reserve-<index>`); the canonical run below shows zero reuse.

² The 62 HTTP 500s are a genuine saturation finding — see §Root cause of the 500s.

### Correctness headline (the gate)

Three different seat counts, three different concurrency levels, **zero oversells every time**:

```
flagship-88  : confirmed 88   <= startAvailable 88    ✓ no oversell
flagship-100 : confirmed 100  <= startAvailable 100   ✓ no oversell
canonical    : confirmed 1148 <= startAvailable 1200  ✓ no oversell   (62 requests failed safe as HTTP 500)
```

## System metrics corroborate the outcome (independent of the harness's own counters)

Pulled from the run's captured before/after API `/metrics` delta — a *different* code path (prom-client
instrumentation) than the harness's request accounting, so agreement is real cross-checking, not tautology:

| Metric (API `:4101/metrics`) | before → after (canonical run) | Reading |
| --- | --- | --- |
| `ticketflow_reservation_outcomes_total{strategy="atomic_update",outcome="created"}` | → 1300 (cumulative incl. prior run) | reserves created |
| `…outcome="sold_out"` | → 1102 (cumulative) | declined for no seats |
| `…outcome="confirmed"` | → 1248 (cumulative) | checkouts confirmed |
| `ticketflow_pg_pool_connections{state="waiting"}` | **0 → 100** | pool queue depth at 120-way concurrency vs `PG_POOL_MAX=20` |
| `ticketflow_pg_pool_connections{state="total"}` | 1 → 20 | pool fully checked out |
| `ticketflow_http_requests_total{route="/:id/checkout",status_class="5XX"}` | +52 | checkout failures |
| `ticketflow_http_requests_total{route="/",status_class="5XX"}` | +10 | reserve failures |
| `ticketflow_tx_retries_total{label="reserve.atomic_update",code="55P03"}` | +5 | `lock_not_available` fast-fail retried |
| `ticketflow_tx_retries_total{label="checkout",code="55P03"}` | +11 | ditto on the checkout transaction |
| `ticketflow_inventory_invariant_violations` | **absent (0)** throughout | no correctness breach under saturation |

SQLSTATE `55P03` is `lock_not_available` — the reservation raced the hot row and `LOCK_TIMEOUT_MS=2000`
made it fail fast and retry. That the retries landed (not exhausted) and invariants stayed at 0 is the safe
strategy doing exactly what [ADR-0003](../adr/0003-transaction-strategy.md) promises.

## Worker-side lock & outbox evidence (the four metrics wired this phase)

The outbox backlog/age, job retries, and `pg_lock_wait_ms` are emitted by the **worker** process (its own
prom-client registry on `:9464`, because only it can observe them — see
[phase6-plan.md](../architecture/phase6-plan.md)). A `/metrics` scrape taken *during* the canonical burst
([`artifacts/worker-metrics-under-contention.txt`](artifacts/worker-metrics-under-contention.txt)):

```
ticketflow_outbox_unpublished 22
ticketflow_outbox_oldest_age_seconds 1
ticketflow_pg_lock_wait_ms_bucket{locktype="tuple",le="250"}   118
ticketflow_pg_lock_wait_ms_bucket{locktype="tuple",le="1000"}  243
ticketflow_pg_lock_wait_ms_bucket{locktype="tuple",le="+Inf"}  253
ticketflow_pg_lock_wait_ms_sum{locktype="tuple"}               88763
ticketflow_pg_lock_wait_ms_count{locktype="tuple"}             253
ticketflow_pg_lock_wait_ms_sum{locktype="transactionid"}       9405
ticketflow_pg_lock_wait_ms_count{locktype="transactionid"}     14
ticketflow_worker_ticks_total{loop="metrics",outcome="ok"}     (incrementing; outcome="error" absent)
```

Reading: the relay **kept pace** — the backlog peaked at 22 rows / 1s age and drained within a couple of
`OUTBOX_POLL_MS` windows (a *healthy* system under a real surge, not the stuck state `OutboxEventStuck`
alerts on). The lock sampler observed 253 tuple-lock waits (mean ≈ 351 ms) and 14 transaction-id waits
(mean ≈ 672 ms), derived from `pg_stat_activity` on PostgreSQL 18 (which removed `wait_time`; the sampler
uses `clock_timestamp() - state_change`, see `apps/worker/src/metrics.ts`). A first version of that sampler
threw on the dropped column and set `ticks{outcome="error"}` on every tick — caught and fixed here, which is
why asserting on the tick *outcome* (the `WorkerMetricsStalled` alert) matters more than a bare liveness flag.

## Latency shape (what the tail is telling us)

Reserve latency percentile spread, all three runs (ms):

```
                 p50        p95        p99        max
flagship-88    1201 ────  4078 ────  5512 ───  5688      (88 seats → 88 fast confirms, 912 fast sold_outs)
flagship-100   1728 ────  3850 ────  5059 ───  5702      (100 seats)
canonical      3830 ───  5429 ──  5890 ── 10552          (1200 seats sustained → pool queue dominates)
```

The dominant latency cause is **not** lock hold time; it is **connection-pool queueing**. At `concurrency`
120 against `PG_POOL_MAX` 20, `waiting` climbed to 100 — the median buyer spent most of its latency in the
pg.Pool acquisition line, before any SQL ran. The canonical run's p50 (3.8s) is ~3× the 88-seat run's (1.2s)
despite an *easier* oversell ratio (1200 seats vs 88), which is only explainable by queue depth, not by
contention on a hot row. This is the same "the benchmark is where pool saturation belongs" conclusion the
Phase 3 report deferred to Phase 6.

## Root cause of the 500s (measured, then confirmed in config)

Every one of the 52 checkout 500s had latency **5005–5025 ms**, and the 10 reserve 500s the same. That ~5.0s
clustering is not random error — it is `PG_CONNECTION_TIMEOUT_MS = 5000` (`packages/config/src/index.ts`):
with the pool pinned at 20 and ~100 callers queued, a request that could not check out a connection within
5 seconds was rejected (`internal_error`) rather than held open indefinitely. **The system shed load instead
of overselling**: `invariant_violations` stayed 0 and `npm run invariants -- --quiescent` reported all-PASS
afterwards. This is documented as a finding, with an operator path in
[../runbooks/db-lock-contention.md](../runbooks/db-lock-contention.md).

## Charts

Confirmed vs declined (seats never exceeded; every excess buyer was `sold_out` or failed safe):

```
flagship-88    [####################] 88 confirmed    [########################...] 912 sold_out     of 1000
flagship-100   [######################] 100 confirmed [#####################...] 812 sold_out (+88 idem-reuse)  of 1000
canonical      [########] 1148 confirmed  [#] 52 checkout-500  [##] 290 sold_out  [·] 10 reserve-500  of 1500
```

Throughput vs offered load (e2e completed ops/s drops as the pool saturates — a capacity signal):

```
flagship-88   88 seats  1000 buyers  conc120  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 64.66 ops/s
flagship-100  100 seats 1000 buyers  conc100  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ 42.97 ops/s
canonical     1200 seats 1500 buyers conc120  ▓▓▓▓▓▓▓▓▓▓▓▓ 29.22 ops/s
```

## Limitations — stated, not hidden

- **n = 1 per scenario.** Each row above is a single run. The Phase 3 report showed a ~36% intra-strategy
  timing spread on an identical seed at n = 2; these HTTP numbers carry at least that much machine noise.
  **Correctness is well supported (three runs, zero oversell, invariant 0); latency/throughput are indicative
  of the *shape* (pool-dominated tail), not a benchmark to rank against another build.** Repeat counts belong
  to the k6 profile run where k6 exists.
- **One machine, shared with the dev server, worker, Postgres and Redis containers.** `cpus: 8` are
  contended by everything on the workstation, so absolute throughput is not a deployment figure.
- **The canonical run's 500s are load-shedding, not a defect.** They are the connection pool doing its job
  under deliberate over-subscription (120-way on a 20-lane pool). They are reported as a finding precisely
  because the harness surfaces server errors instead of hiding them behind the confirmed count.
- **Rate limiter must be raised or the whole exercise is meaningless** (measures 429, not contention). That
  is a real footgun the harness README and the k6 header both call out.
- **k6 was NOT run here.** The declarative profile lives in
  [`load-tests/flagship-booking.js`](../../load-tests/flagship-booking.js); it is not executed on this
  workstation because k6 is not installed and binaries may not be downloaded. The Node harness is the
  measured path; the k6 script is the portable re-expression of the same reserve→checkout scenario.
- **`GIT_SHA` is unset**, so no run is attributable to a revision — the Phase 7 reproducibility gate needs
  `GIT_SHA` set before the API starts (mirrors the standing note in strategy-comparison.md).
- **PostgreSQL 18 lock-wait approximation.** `pg_lock_wait_ms` is sampled every 5s (`METRICS_SAMPLE_MS`) and
  measures time-in-current-wait-state via `state_change`, not total time-to-acquire. It is a load *indicator*
  with bounded precision, not a per-transaction accounting of lock hold time.

## See also

- [strategy-comparison.md](strategy-comparison.md) — the data-layer lab runs this HTTP view complements.
- [../runbooks/db-lock-contention.md](../runbooks/db-lock-contention.md) — operating response to pool saturation.
- [../architecture/phase6-plan.md](../architecture/phase6-plan.md) — what was wired and the verification gate.
