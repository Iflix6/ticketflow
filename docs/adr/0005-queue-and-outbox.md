# ADR-0005 — Queues and the transactional outbox

Status: accepted (Phase 0).

## Context
Enqueueing a BullMQ job as the sole side effect of a commit is unsound: the commit can fail after the
enqueue (phantom job) or the enqueue can fail after the commit (lost job). Delayed expiry jobs are
also unreliable timers under Redis outage.

## Decision
- Business transactions only **write `outbox_events`**. A relay in `apps/worker` polls
  `WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT n`, publishes to BullMQ, then
  marks `published_at` — restart-safe, duplicate-safe, and visible via the `outbox_age_seconds` metric.
- Consumers are idempotent by construction: the `consumed_events` marker is written in the SAME transaction
  as the side effect, and each action is a conditional UPDATE guarded by current state, so a duplicate
  delivery is a no-op (verified by `outbox-relay.test.ts` "duplicate delivery to the consumer is an
  idempotent no-op" and `worker-recovery.test.ts` "duplicate DELIVERY (new jobId, same event)").
- Expiry uses **two** mechanisms: BullMQ delayed jobs (fast path) and a periodic DB sweeper
  (`status='PENDING' AND expires_at <= now()`) that is the correctness path. Correctness never depends
  on the scheduler firing on time.
- Retry policy: exponential backoff with jitter (`{ type: 'exponential', delay: 250, jitter: 0.5 }` —
  BullMQ validates `jitter` as a **fraction 0..1**, not the percentage its docstring claims), `attempts`
  ceiling (`JOB_MAX_ATTEMPTS`), failed jobs moved to a `*-dead` queue for inspection, concurrency capped
  per worker (`WORKER_CONCURRENCY`).
- Finished-job retention is **bounded** (`{ age, count }` for both completed and failed), never
  `removeOnComplete: false`: "keep forever" is a slow Redis OOM. The trade-off is explicit — relay jobIds
  dedupe only while the job record is retained, so a very delayed re-dispatch after the window CAN create
  a second run. That is acceptable precisely because the `consumed_events` marker, not the jobId, is the
  exactly-once guarantee; the jobId is only an optimisation that stops retries from stacking duplicate
  pending work. Failed records are retained much longer, because a dead-letter is a human artifact.
- Poison messages are logged with `job.id`, moved to dead-letter, and never retried indefinitely.

## Degradation matrix

| Condition | Behaviour |
| --- | --- |
| Redis down | Booking continues (DB-only). Reads served without cache. Rate limiting fails **closed** for lab/admin mutations and fails **open with a logged warning** for read-only public GETs. Outbox accumulates; `outbox_age_seconds` alerts. |
| Worker down | No expiries via fast path; sweeper recovers on restart. Outbox grows; nothing is lost (events live in PG). |
| DB down | Liveness OK, readiness fails; API returns `503` with `Retry-After`; no partial writes. |

## Consequences
+ Recovery from worker restart and duplicate delivery is testable and tested.
- Outbox relay adds one poll interval of latency to notifications (documented, tunable).
- Dedup by jobId is time-bounded by retention, so duplicate *delivery* remains possible by design; only
  the consumer-side marker makes it harmless.
