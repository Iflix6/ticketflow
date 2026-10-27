# ADR-0004 — Idempotency: PostgreSQL unique key acquired inside the business transaction

Status: accepted (Phase 0).

## Context
Booking mutations are retried by clients and by the load generator. A Redis `SETNX` guard would be
lost independently of the DB, and an "insert then do work, update record" pattern leaves a window
where a crash strands a key with no outcome.

## Decision
1. `Idempotency-Key` is required on `POST /api/v1/reservations` (and checkout). Scope is
   `(user_id, endpoint-template)`. Unique index `(scope_user_id, scope_endpoint, key)`.
2. Flow inside one transaction:
   a. `INSERT INTO idempotency_records(... state='IN_PROGRESS', request_hash) ON CONFLICT DO NOTHING
       RETURNING id, state`;
   b. if a conflict occurred, `SELECT` the existing row and branch:
      - `COMPLETED` + same hash → replay stored `response_status`/`response_body`;
      - `COMPLETED` + different hash → `409 idempotency_key_reuse`;
      - `IN_PROGRESS` → `409 idempotency_in_progress` with `Retry-After: 1`;
   c. otherwise perform the business write, then `UPDATE … SET state='COMPLETED', response_status,
      response_body, resource_id` before `COMMIT`.
3. Because the `IN_PROGRESS` row is created in the same transaction as the business effect, a rollback
   removes the key entirely and a retry is safe; no orphan state to clean up.
4. Records expire (`expires_at`, default 24h) and are swept by the worker.

Chosen behaviour for concurrent same-key requests: **fail fast with 409 + Retry-After** rather than
blocking on an advisory lock. Rationale: a waiting request would hold a pool client and multiply tail
latency under the exact contention this lab measures; the client-visible semantics (one effect) are
identical.

## Claims made, honestly
- Effectively-once **business effect** in PostgreSQL, via unique constraints + in-transaction result
  persistence + idempotent consumers + transactional outbox.
- **Not** claimed: exactly-once delivery or exactly-once processing across external systems. The fake
  payment provider is deterministic and local, and its call is deliberately *outside* the DB
  transaction with an attempt row written before/after (documented in `docs/api/idempotency.md`).
