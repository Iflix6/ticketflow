# Runbook — outbox backlog & Redis outage

**Audience:** on call. **Owner area:** `apps/worker` (relay + consumers), Redis.
**Related alerts:** `OutboxEventStuck` (warning), `OutboxBacklogGrowing` (warning),
`TicketflowConsistency`/dead-letter growth.

This is the file `alert-rules.yml` points at for `OutboxEventStuck`.

## The design, in one paragraph (so you reason correctly at 03:00)

Business transactions write an `outbox_events` row **in the same transaction** that changes inventory —
that is the whole point of the transactional outbox
([ADR-0005](../adr/0005-queue-and-outbox.md)). The worker's relay polls unpublished rows every
`OUTBOX_POLL_MS` (default 1000ms), claims a batch with `FOR UPDATE SKIP LOCKED`, and pushes jobs onto
BullMQ (Redis). Consumers read them idempotently. **If Redis dies, the DB rows are still there** — the
relay just cannot push, so `ticketflow_outbox_unpublished` grows. Booking keeps working end-to-end;
nothing oversells; only downstream delivery is delayed.

## Symptoms & what each metric actually means

| Metric (worker `:9464/metrics`) | Meaning when it moves |
| --- | --- |
| `ticketflow_outbox_unpublished` | Backlog depth: produced faster than dispatched. |
| `ticketflow_outbox_oldest_age_seconds` | Age of the oldest unpublished row. >60s → `OutboxEventStuck`. |
| `ticketflow_worker_job_retries_total{queue}` | A consumer failed and the job will be retried (attempt > 1). |
| `ticketflow_worker_dead_letters_total{queue}` | A consumer exhausted `JOB_MAX_ATTEMPTS`; job parked. |
| `ticketflow_worker_ticks_total{loop="metrics",outcome}` | Relay/sampler liveness (see [worker-failure.md](worker-failure.md)). |

> Measured reference point: a 1,500-buyer HTTP burst drove the backlog to **22 unpublished / oldest-age
> 1s** and back to 0 within a couple of relay windows on this local fixture
> ([../experiments/http-booking-benchmark.md](../experiments/http-booking-benchmark.md)). A backlog that
> grows into the hundreds and *does not* drain is the anomaly, not a burst blip.

## Confirm (read-only)

```powershell
# Backlog + age, live:
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'outbox_'

# Is Redis reachable? (compose data tier exposes 127.0.0.1:6379)
docker compose exec -T redis redis-cli ping          # expect PONG

# What does the DB actually hold unpublished?
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT count(*) AS unpublished, `
          COALESCE(FLOOR(EXTRACT(EPOCH FROM (app.now() - min(created_at))))::int, 0) AS oldest_age_s `
     FROM outbox_events WHERE published_at IS NULL;"

# Rows that keep failing dispatch (transport or consumer errors) carry attempt_count > 0 and a last_error:
docker compose exec -T postgres psql -U ticketflow -d ticketflow -c `
  "SELECT id, event_type, attempt_count, left(last_error, 120) AS last_error `
     FROM outbox_events WHERE published_at IS NULL ORDER BY attempt_count DESC LIMIT 20;"
```

Decision:

| Redis `ping` | Backlog trend | Diagnosis | Action |
| --- | --- | --- | --- |
| fails | growing | Redis outage / wrong `REDIS_URL`. | Restore Redis; relay auto-recovers. |
| PONG | growing | Consumers wedged, pool starved, or worker down. | [worker-failure.md](worker-failure.md); [db-lock-contention.md](db-lock-contention.md). |
| PONG | drains but retries/dead-letters rise | Consumer logic failing per-job. | See dead-letter section below. |

## Act

### Redis is down
Restore Redis (`docker compose up -d redis`). **Do nothing to the outbox rows** — they are the durable
record and the relay re-adopts them the instant Redis is back. This is exactly the degradation matrix
ADR-0005 promises: advisory dependency lost, correctness intact. Confirm the oldest-age gauge falls back
under 60s and `OutboxEventStuck` resolves.

### Redis is up but the backlog will not drain
1. Check the worker process is alive and ticking ([worker-failure.md](worker-failure.md)).
2. Check Redis memory policy: this stack runs `maxmemory-policy volatile-lru`; BullMQ warns it should be
   `noeviction` (the worker logs `IMPORTANT! Eviction policy is volatile-lru`). Eviction under memory
   pressure can drop queue keys. For anything beyond a lab, set `noeviction` (hardening backlog).
3. Do **not** flush the queue to "clear" a backlog — the outbox rows remain authoritative and will be
   re-dispatched; flushing only loses in-flight notifications, it does not fix the cause.

### Dead-letters are accumulating
A job that exhausts `JOB_MAX_ATTEMPTS` (default 5) is parked and increments
`ticketflow_worker_dead_letters_total{queue}`. Find the poison message *by inspection, not by guessing*:

```powershell
docker compose exec -T redis redis-cli --scan --pattern 'bull:*:failed' | Select-Object -First 20
```

Because consumers are idempotent, once the underlying fault is fixed you can safely re-enqueue the failed
job (BullMQ retry) — a duplicate dispatch cannot double-sell seats, since the DB row and the invariant
triggers are the gate, not the queue.

## Verify recovery

```powershell
curl.exe -s http://127.0.0.1:9464/metrics | Select-String 'outbox_'   # unpublished -> 0, oldest_age -> 0
npm run invariants -- --quiescent                                      # PASS — no dispatch delay slipped a count
```

## Never do

- Never `UPDATE inventory` to "reconcile" a delivery lag. Delivery lag is not an inventory error.
  If you suspect a real drift, use [reconciliation-mismatch.md](reconciliation-mismatch.md).
- Never delete `outbox_events` rows as cleanup; that discards the durable audit trail of what should have
  been published.
