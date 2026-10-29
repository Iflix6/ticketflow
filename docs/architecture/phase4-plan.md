# Phase 4 — Async processing, outbox relay, recovery

Status: **done**. Implements ADR-0005 (queues + transactional outbox) and ADR-0002 (PostgreSQL is
the source of truth; Redis is advisory). Gate: *recover from worker restarts and duplicate delivery
without violating invariants.*

## Boundaries (what we deliberately do NOT change)

- **No new migration.** The schema already carries every Phase-4 column: `outbox_events
  (published_at, attempt_count, last_error)` + the partial `outbox_events_unpublished_idx`,
  `consumed_events (consumer, outbox_id)` for consumer dedup, and `reconciliation_findings` with the
  `outbox_stuck` / `counter_mismatch` kinds. Phase 2 already writes the outbox rows.
- **The API stays DB-only.** Redis/BullMQ live exclusively in `apps/worker`. The API's only Phase-4
  touch is wiring the already-supported `pingRedis` readiness seam (advisory: degraded, never down).
- **Correctness never depends on the queue.** The periodic DB sweeper is the expiry correctness path;
  the BullMQ delayed job is a latency optimization. Redis being down must not lose a business event.

## Mechanism

1. **Relay (restart-safe).** Each tick, in ONE transaction: claim up to `OUTBOX_BATCH_SIZE` rows with
   `SELECT ... WHERE published_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED`; dispatch each to the
   BullMQ `outbox-dispatch` queue using a **deterministic `jobId = outbox-<id>`** (a colon is illegal in
   a BullMQ custom job id — `Job.validateOptions` throws, which would fail every dispatch); then set
   `published_at = app.now()`. Ordering: publish-then-mark inside the same lock, so
   - crash after the queue add but before COMMIT → the row is still unpublished → next tick re-adds with
     the SAME job id → while that job is still pending BullMQ refuses to create a second one; and
   - a row is only marked published once its job is durably in Redis → no lost job.
   Net: **at-least-once into the queue, exactly-once effect**. Where the transport's dedup window ENDS
   matters: once a job has completed, re-adding the same id creates a fresh run (measured against BullMQ
   6.5, `worker-recovery.test.ts`). The consumer's `consumed_events` marker is therefore the load-bearing
   guarantee, and the job id is only an optimisation that stops a retry from stacking duplicate pending
   work. For the same reason the relay reports `published`/`failed` and NOT an "added vs deduped" split:
   BullMQ resolves `add` to the pre-existing job, so that distinction is not observable from the relay.
2. **Consumers (duplicate-safe).** Each handler opens with
   `INSERT INTO consumed_events (consumer, outbox_id) ON CONFLICT DO NOTHING`. If zero rows inserted
   the delivery is a redelivery → no-op. The marker is written in the SAME transaction as the effect, so
   a crash after the marker rolls BOTH back and a retry re-applies exactly once. Every state-changing
   action is additionally a conditional UPDATE guarded by current status, so even a fresh consumer redoes
   nothing. (Tests: "duplicate delivery … idempotent no-op", "consumer fault AFTER marker+effect but
   BEFORE commit rolls back both".)
3. **Expiry, two paths.**
   - *Fast path:* when the notification consumer handles `reservation.created` it schedules a delayed
     `reservation-expiry` job (delay from the reservation's DB-clock `expires_at`).
   - *Correctness path:* `sweepExpiries()` runs `expireDueReservations` (`FOR UPDATE SKIP LOCKED`) and
     `releaseReserved` in the SAME transaction, on `SWEEPER_INTERVAL_MS`. Both paths are idempotent and
     produce identical state; running both never double-releases (guarded by `reserved >= qty` and the
     `status='PENDING'` predicate).
4. **Retry + dead-letter.** Worker `defaultJobOptions`: `attempts = JOB_MAX_ATTEMPTS`, exponential
   backoff `delay 250ms, jitter 0.5` (BullMQ validates jitter as a **fraction 0..1**, despite its
   docstring saying "percentage" — `jitter: 50` throws on every `add`). Jitter matters because a worker
   that momentarily loses Redis sees every in-flight job fail at once, and identical delays would make
   them all retry at once too. On the final failed attempt the `failed` handler adds the payload to the
   matching `*-dead` queue and logs `job.id` (poison messages are parked, not retried forever).
   Both option traps are pinned hermetically in `tests/unit/queue-job-options.test.ts`.
5. **Reconciliation.** `reconcile()` records findings without silently mutating inventory: a backlog
   older than the stuck threshold → `outbox_stuck`; any row in `app.counter_drift_violations` →
   `counter_mismatch`. It surfaces disagreement between the queue world and the DB truth.

## Fault injection (how we prove the claims, not assume them)

The relay and the dispatch consumer accept an optional injected failure hook. Tests use it to:
- crash the relay **after** dispatching but **before** marking published, then run it again and assert
  the transport received no second job and the consumer saw the event exactly once;
- make a consumer throw **after** its dedup marker but **before** commit and assert the rollback left
  neither marker nor effect, so the retry applies the effect once;
- make a consumer fail on its first attempt and succeed on the next (the referenced outbox row appears
  mid-backoff), asserting one effect, `attemptsMade >= 1` and no dead-letter;
- make a poison job always fail and assert it lands in the dead-letter queue without corrupting state;
- keep the notification fast path optional: `sweepExpiries` alone releases every overdue hold exactly
  once even when two sweeps race (`FOR UPDATE SKIP LOCKED`).

## Verification

Integration suites (gated on real PostgreSQL **and** real Redis, skipped honestly otherwise):
`tests/integration/outbox-relay.test.ts`, `expiry-sweeper.test.ts`, `worker-recovery.test.ts`. Each
asserts against the independent `app.*_violations` views after the churn, never on HTTP counts alone.

Measured on this checkout, against live PostgreSQL 18.6 **and** live Redis (no suite self-skipped):

```
npx vitest run --config vitest.integration.config.ts \
  tests/integration/outbox-relay.test.ts tests/integration/worker-recovery.test.ts \
  tests/integration/expiry-sweeper.test.ts        # vitest 3.2.7, Node v26.1.0
  ✓ worker-recovery.test.ts        9 passed
  ✓ outbox-relay.test.ts          11 passed  (1783 ms)
  ✓ expiry-sweeper.test.ts         5 passed  (1440 ms)
  Test Files 3 passed (3)   Tests 25 passed (25)   Duration 24.94 s
```

---

Previous: [Phase 3 — Comparative strategies and the isolated unsafe lab](phase3-plan.md) ·
Next: [Phase 5 — UI and lab](phase5-plan.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md)
