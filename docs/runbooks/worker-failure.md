# Runbook — worker failure

**Audience:** on call. **Owner area:** `apps/worker`. **Related alert:** `WorkerMetricsStalled` (critical).

## Symptom

Downstream effects of a dead worker are *asynchronous*, so the first thing you notice is rarely "the
worker is down":

- the outbox backlog grows and `ticketflow_outbox_oldest_age_seconds` climbs past 60 (→ also fires
  `OutboxEventStuck` — see [outbox-and-redis.md](outbox-and-redis.md));
- reservation-expiry jobs stop draining from the queue, but **holds still expire on time** because the
  DB-only sweeper runs in the same process — so if the *process* is down, expiry lags too;
- Prometheus shows `rate(ticketflow_worker_ticks_total{loop="metrics",outcome="ok"}[2m]) == 0` for 3m.

**Booking does not break.** PostgreSQL is the source of truth ([ADR-0002](../adr/0002-postgres-source-of-truth.md));
the API serves reservations and checkouts without the worker. What degrades is *delivery* (emails,
projections) and *timely* expiry sweep.

## Confirm (read-only)

```powershell
# 1. Is the process even alive? Liveness is a separate signal from readiness (pack requirement).
curl.exe -s http://127.0.0.1:9464/health/live      # 200 {"status":"live"} or connection refused
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'ticks_total|outbox_'

# 2. Are ticks failing rather than absent? outcome="error" means the loop is running but a query threw.
#    (A real example from Phase 6: an early build emitted ticks outcome="error" because the lock-wait
#     sampler used a column PostgreSQL 18 removed — the sampler then threw every tick. The fix derived
#     the wait from pg_stat_activity.state_change instead. apps/worker/src/metrics.ts.)

# 3. Heartbeat file freshness (worker writes every 10s).
Get-Content -LiteralPath $env:TF_WORKER_HEARTBEAT -ErrorAction SilentlyContinue   # default /tmp/worker-heartbeat
```

Decision:

| `ticks_total` | `/health/live` | Diagnosis |
| --- | --- | --- |
| absent / scrape refused | refused | Process crashed or not running. |
| `outcome="ok"` frozen at a number | 200 | Event loop wedged (a tick never completed) — check DB connectivity. |
| only `outcome="error"` incrementing | 200 | A sampled query is throwing (permissions, missing column/view, DB overloaded). |

## Act

1. **Restart it.** Locally: `npm run dev:worker`. Under compose:
   `docker compose up -d --force-recreate worker`. The relay is restart-safe: it claims unpublished
   `outbox_events` with `FOR UPDATE SKIP LOCKED` each `OUTBOX_POLL_MS`, so a restart re-adopts the
   backlog with no lost or double-published events ([ADR-0005](../adr/0005-queue-and-outbox.md)).
2. **If it crash-loops on boot**, the log line `worker cannot reach PostgreSQL; exiting for the
   supervisor to retry` (`apps/worker/src/main.ts`) means the DB probe failed — fix database
   reachability / `DATABASE_URL` first; do not chase the queue.
3. **If only the metrics tick errors**, the consumer loops and relay are usually still healthy; capture
   the thrown error from the worker log (pino JSON, `msg":"metrics sampling tick failed"`) and treat it
   as a bug in the sampler, not an outage. Booking correctness is unaffected.

## Verify recovery

```powershell
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'ticks_total'   # outcome="ok" now incrementing
# The backlog should drain within a few OUTBOX_POLL_MS windows:
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'outbox_'       # unpublished -> 0, oldest_age -> 0
npm run invariants -- --quiescent                                          # all invariants hold
```

## Escalate / known limits

- The worker keeps a **small pool** (`max: 5`) on purpose so it never starves the API under a backlog
  burst; a large `OUTBOX_BATCH_SIZE` with a cold cache can make a single relay tick slow — that is a
  throughput issue, not a correctness one.
- Dead-lettered jobs (`ticketflow_worker_dead_letters_total{queue=...}`) are **not** this runbook; they
  mean a consumer ran and gave up after `JOB_MAX_ATTEMPTS`. See
  [outbox-and-redis.md](outbox-and-redis.md) for the dispatch path and
  [reconciliation-mismatch.md](reconciliation-mismatch.md) if a dead job left a projection behind.
