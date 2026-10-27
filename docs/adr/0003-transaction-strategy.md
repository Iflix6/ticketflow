# ADR-0003 — Transaction strategy: one client, conditional UPDATE default, bounded retries

Status: accepted (Phase 0).

## Context
`pg.Pool` hands out different clients per `pool.query`, so a "transaction" built from pool queries is
not a transaction. Contention on one inventory row is the workload under test.

## Decision
- `withTransaction(client => …)`: acquires exactly **one** `PoolClient`, issues
  `BEGIN ISOLATION LEVEL …`, runs all statements on that client, `COMMIT`s, and always `ROLLBACK` +
  `release()` in a `finally`. A typed helper exposes `client.query<T>()`.
- Statement and lock timeouts are configured per transaction
  (`statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`) from validated env.
- Default isolation: **READ COMMITTED** with strategy A (single atomic conditional UPDATE) — the row
  lock taken by the UPDATE *is* the serialization point, so no explicit lock statement is needed.
- Retry policy: retry only on `40001` (serialization failure), `40P01` (deadlock), `55P03`
  (lock-not-available on timeout) and connection-level errors before any side effect, with bounded
  attempts (default 3) and full jitter. Never retry `23514` (check violation), `23505` (unique),
  `22P02`, or an unknown code — those are surfaced with a stable error taxonomy.
- Non-idempotent side effects (fake payment calls, queue publishes) are never inside a retry loop;
  publishing happens via outbox so a retry cannot duplicate an external effect.
- `REPEATABLE READ`/`SERIALIZABLE` are exercised only in dedicated tests that measure the anomaly they
  prevent, so the comparison is evidence rather than folklore.

## Rejected alternatives
- Explicit table-level locks / advisory locks per tier: serializes more than necessary, hides the
  difference between strategies A, B, C.
- Retry on any error ("resilience by timeout spam"): converts sold-out into latency.

## Consequences
+ Reservation, idempotency record, and outbox event commit atomically.
+ Pool sizing becomes a first-class measured parameter (`PG_POOL_MAX`), not an invisible default.
- Strategy B and C need the same helper with different SQL; kept as sibling repository functions rather
  than an abstraction layer, to keep the SQL readable.
