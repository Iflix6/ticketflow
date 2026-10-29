# Runbooks

Operational playbooks for the TicketFlow reliability lab. Each runbook is written for a human on
call at 03:00: it names the **symptom**, the **metric or alert that fires**, the **read-only checks**
to confirm the diagnosis, the **action**, and the **verification that the system is healthy again**.

Nothing here is invented. Every metric cited is one the API (`:4000/metrics`) or worker (`:9464/metrics`)
actually emits — the set was verified against real scrape output in
[../architecture/phase6-plan.md](../architecture/phase6-plan.md). Every command is one that exists in
`package.json` or `compose.yaml`. Every threshold traces to `packages/config/src/index.ts` or a named
constant in `apps/worker/src/main.ts`.

## Alert → runbook map

The Prometheus rules in [`infra/prometheus/alert-rules.yml`](../../infra/prometheus/alert-rules.yml)
route to these files:

| Alert (alert-rules.yml) | severity | Runbook |
| --- | --- | --- |
| `OutboxEventStuck` | warning | [outbox-and-redis.md](outbox-and-redis.md) |
| `OutboxBacklogGrowing` | warning | [outbox-and-redis.md](outbox-and-redis.md) |
| `WorkerMetricsStalled` | critical | [worker-failure.md](worker-failure.md) |
| `InventoryInvariantViolation` | critical | [reconciliation-mismatch.md](reconciliation-mismatch.md) |
| `TransactionRetriesExhausted` | warning | [db-lock-contention.md](db-lock-contention.md) |
| `DbPoolQueueing` | warning | [db-lock-contention.md](db-lock-contention.md) |
| `LockWaitTailHigh` | warning | [db-lock-contention.md](db-lock-contention.md) |

Schema changes and their reversals are not alerts but planned operations:

| Operation | Runbook |
| --- | --- |
| Applying migrations forward | [migrations.md](migrations.md) |
| Rolling a migration / deploy back | [rollback.md](rollback.md) |

## Load-bearing facts (so you don't have to re-derive them under pressure)

- **PostgreSQL is the only source of truth for inventory.** A queue, Redis, or dashboard outage must
  never change a seat count. If a runbook ever tempts you to "fix" `inventory` by hand, stop — the
  invariant views and `npm run invariants` are how you prove the truth instead.
- **The worker and the API are separate processes** ([ADR-0001](../adr/0001-modular-monolith-workspaces.md)).
  Restarting one does not restart the other. The worker exposes `/metrics` and `/health/live` on
  `127.0.0.1:9464`; the API exposes them on its own port. Two registries, never merged.
- **Redis is advisory** ([ADR-0005](../adr/0005-queue-and-outbox.md)). If it is down, booking still
  succeeds and the sweeper still expires holds; only downstream dispatch lags (the outbox backlog grows).
- **Correctness under saturation is fail-safe, not fail-oversell.** A measured benchmark proved the
  system returns HTTP 500 (`PG_CONNECTION_TIMEOUT_MS` = 5s acquisition) rather than overselling when the
  pool starves — see [../experiments/http-booking-benchmark.md](../experiments/http-booking-benchmark.md).

## Default thresholds (local fixture; production re-tunes these)

| Name | Default | Where |
| --- | --- | --- |
| `PG_POOL_MAX` | 20 | `packages/config/src/index.ts` |
| `PG_CONNECTION_TIMEOUT_MS` | 5000 | `packages/config/src/index.ts` |
| `STATEMENT_TIMEOUT_MS` | 5000 | `packages/config/src/index.ts` |
| `LOCK_TIMEOUT_MS` | 2000 | `packages/config/src/index.ts` |
| `IDLE_IN_TRANSACTION_TIMEOUT_MS` | 10000 | `packages/config/src/index.ts` |
| `OUTBOX_POLL_MS` | 1000 | `packages/config/src/index.ts` |
| `OUTBOX_BATCH_SIZE` | 50 | `packages/config/src/index.ts` |
| `SWEEPER_INTERVAL_MS` | 15000 | `packages/config/src/index.ts` |
| `WORKER_CONCURRENCY` | 5 | `packages/config/src/index.ts` |
| `JOB_MAX_ATTEMPTS` | 5 | `packages/config/src/index.ts` |
| Outbox stuck threshold | 60 s | `OUTBOX_STUCK_THRESHOLD_SECONDS`, `apps/worker/src/main.ts` |
| Worker metrics sample | 5000 ms | `METRICS_SAMPLE_MS`, `apps/worker/src/main.ts` |
| Worker heartbeat path | `/tmp/worker-heartbeat` | `TF_WORKER_HEARTBEAT`, `apps/worker/src/main.ts` |

## How to see the stack

```powershell
# API + worker + Postgres + Redis (data tier), no monitoring sidecars:
npm run db:up
npm run dev:api        # :4000  -> /metrics, /health/ready
npm run dev:worker     # :9464  -> /metrics, /health/live

# Full observability sidecars (Prometheus :9090, Grafana :3001, OTel collector) run under compose profiles:
docker compose --profile monitoring --profile tracing up -d
```

Scrape the two registries directly at any time:

```powershell
curl.exe -s http://127.0.0.1:4000/metrics   # API: http, transaction, pool, reservation outcomes, invariants
curl.exe -s http://127.0.0.1:9464/metrics   # worker: outbox backlog/age, job retries/dead-letters, lock waits, ticks
```
