# Runbook — database lock contention & pool saturation

**Audience:** on call. **Owner area:** PostgreSQL, `apps/api` transaction layer.
**Related alerts:** `LockWaitTailHigh`, `DbPoolQueueing` (warning), `TransactionRetriesExhausted` (warning).

## What contention looks like here (and why it is *safe*)

The flagship flow is many buyers racing a hot inventory row. The API's default strategy is
`atomic_update` ([ADR-0003](../adr/0003-transaction-strategy.md)): a single conditional
`UPDATE ... WHERE available >= qty` that takes a row lock. Two guardrails keep a convoy from turning
into either an oversell or an outage:

- `LOCK_TIMEOUT_MS = 2000`: a reservation that cannot get the row lock in 2s **fails fast** with
  SQLSTATE `55P03` (lock_not_available) and is retried under a bounded policy — it does not pile up.
- `PG_CONNECTION_TIMEOUT_MS = 5000` / `PG_POOL_MAX = 20`: a request that cannot *check out a connection*
  in 5s is rejected (HTTP 500 `internal_error`) rather than queued indefinitely.

**The invariant is preserved under all of this.** A measured 1,500-buyer burst that pushed
`pg_pool_connections{state="waiting"}` from 0 to 100 and produced 62 connection-timeout 500s reported
`ticketflow_inventory_invariant_violations` = **none** and `npm run invariants -- --quiescent` all-PASS
afterwards ([../experiments/http-booking-benchmark.md](../experiments/http-booking-benchmark.md)). Under
saturation the system sheds load; it does not oversell. Keep that framing: **latency/availability alarm,
correctness intact** is the normal signature, and you are tuning capacity, not firefighting data loss.

## Confirm (read-only)

```powershell
# 1. Are the tails lock-driven or pool-driven? worker registry samples DB-wide lock waits:
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'pg_lock_wait_ms|worker_pg_pool'
#   ticketflow_pg_lock_wait_ms_bucket{locktype="tuple"...}   <- row-lock convoy on inventory
#   ticketflow_pg_lock_wait_ms_bucket{locktype="transactionid"...} <- waiting on another writer's xact
# API registry shows the pool queue + retries:
curl.exe -s http://127.0.0.1:4000/metrics | Select-String 'pool_connections|tx_retries'

# 2. Live lock graph, straight from PostgreSQL (read-only):
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT pid, wait_event_type, wait_event, state,
          FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - state_change)))::int AS waiting_s,
          left(query, 80) AS query
     FROM pg_stat_activity
    WHERE wait_event_type = 'Lock'
    ORDER BY waiting_s DESC;"
```

> Note on the `state_change` arithmetic: PostgreSQL 18 removed the old `wait_time` column, so both this
> query and the worker's sampler (`apps/worker/src/metrics.ts`) derive the elapsed wait from
> `clock_timestamp() - state_change`. Do not write `wait_time` against PG 18 — it throws `42704`/`42703`
> and (as seen in Phase 6) silently turns every worker metrics tick into `outcome="error"`.

Interpretation:

| Signature | Meaning |
| --- | --- |
| `pool_connections{state="waiting"}` high, lock buckets low | **Pool starvation** — you are under-provisioned relative to concurrency. |
| `pg_lock_wait_ms{locktype="tuple"}` p95 climbing, waits low | Normal convoy on the hot row under a real surge; watch, don't panic. |
| `tx_retries_total{code="55P03"}` rising | Lock timeouts fast-failing and retrying — contention shedding load correctly. |
| `tx_retries_exhausted_total` > 0 (→ `TransactionRetriesExhausted`) | Retries ran out for a *hot* request; check for a stuck long transaction. |

## Act

Work cheapest-first:

1. **Cut per-request connection hold time.** The 500s in the measured run were 5s *connection-acquisition*
   timeouts, not query timeouts — the pool (20) was the bottleneck at concurrency 120. Reducing client
   concurrency, or the rate limit (`RATE_LIMIT_MAX`), relieves it immediately without touching the DB.
2. **Raise `PG_POOL_MAX` only in lockstep with PostgreSQL `max_connections`** (across API and worker,
   which keeps a small pool of 5). Over-sizing the pool past what Postgres serves turns connection waits
   into backend-fork pressure and makes it worse.
3. **Do not lengthen `LOCK_TIMEOUT_MS` reflexively.** The fast-fail is what keeps the convoy bounded and
   correctness intact. A longer lock timeout converts quick sheddable errors into long held connections
   (feeding pool starvation). Tune it only with a measured reason.
4. **Hunt a stuck transaction** (not steady-state load) with:
   ```powershell
   docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
     "SELECT pid, xact_start, FLOOR(EXTRACT(EPOCH FROM (clock_timestamp()-xact_start)))::int AS xact_s,
             state, left(query,80) AS query
        FROM pg_stat_activity
       WHERE state <> 'idle' AND xact_start IS NOT NULL
       ORDER BY xact_s DESC LIMIT 10;"
   ```
   An `idle in transaction` backend is a bug (a code path leaving a session open); the
   `IDLE_IN_TRANSACTION_TIMEOUT_MS = 10000` guard kills it, but find the code, don't just reap it.

Never terminate (`pg_terminate_backend`) a *reservation* writer just because it holds a lock — that is
the correctness-critical path; prefer shedding the load above.

## Verify

```powershell
curl.exe -s http://127.0.0.1:4000/metrics | Select-String 'pool_connections\{state="waiting"'   # back near 0
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'tx_retries_exhausted'                 # no growth
npm run invariants -- --quiescent                                                                # all PASS
```

## Cross-reference

Reproduce the whole saturation curve on demand (this is what generated the numbers above):
`npm run bench -- --base http://127.0.0.1:4000 --users 1500 --concurrency 120` — see the benchmark report.
