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
- Consumers are idempotent by construction: each action is a conditional UPDATE guarded by current
  state, so a duplicate delivery is a no-op (verified by test `outbox-duplicate-delivery`).
- Expiry uses **two** mechanisms: BullMQ delayed jobs (fast path) and a periodic DB sweeper
  (`status='PENDING' AND expires_at <= now()`) that is the correctness path. Correctness never depends
  on the scheduler firing on time.
- Retry policy: exponential backoff with jitter, `attempts` ceiling, `backoff.strategic`, failed jobs
  moved to a `*-dead` queue for inspection, concurrency capped per worker (`WORKER_CONCURRENCY`).
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
