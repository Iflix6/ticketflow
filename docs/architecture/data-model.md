# Data Model, Invariants, and State Machines

Authoritative source: **PostgreSQL**. Redis and any in-process cache are advisory only and can never
authorize a sale (ADR-0002).

## 1. Authoritative vs derived

| Data | Authoritative | Derived / cached | Notes |
| --- | --- | --- | --- |
| `inventory.capacity/available/reserved/sold/version` | PostgreSQL row | `GET /events/:id/tiers` response cache in Redis | Cache staleness may only cause an extra DB round-trip, never an oversell |
| `reservation.status` | PostgreSQL | BullMQ delayed job presence | Job is a *hint*; sweeper re-derives from DB |
| `booking.status` | PostgreSQL | — | Created only from a confirmed reservation |
| `idempotency_records` | PostgreSQL | — | Uniqueness does the dedup work |
| `outbox_events.published_at` | PostgreSQL | Redis queue acks | At-least-once publish; consumers dedupe by event id |
| metrics/traces | none (observability) | Prometheus | Never used for correctness decisions |

## 2. Tables (see `apps/api/src/db/migrations/*.sql` for executable DDL)

- `events`, `ticket_tiers`, `inventory` — catalog and counters.
- `app_users`, `sessions` — local demo identity (argon2/bcrypt hash, hashed session tokens).
- `reservations`, `bookings`, `payment_attempts` — booking lifecycle.
- `idempotency_records` — unique `(scope_user_id, scope_endpoint, key)`.
- `outbox_events` — transactional outbox.
- `audit_records` — actor/action/aggregate/metadata, PII-free.
- `experiment_runs`, `experiment_results` — Engineering Lab, local/test only.
- `reconciliation_findings` — recorded discrepancies (e.g. payment succeeded after expiry).
- `lab` schema clone (`lab.inventory`, `lab.reservations`) — unsafe baseline fixture, isolated.

Identifier strategy: UUID generated in the database (`uuid7()` when the pinned server provides it,
otherwise `gen_random_uuid()`), verified by the migration itself and recorded in
`docs/experiments/environment.md`. Rationale in ADR-0006.

## 3. Inventory invariants

Row-level (enforced by `CHECK` on `inventory`):

```
I1  available + reserved + sold = capacity
I2  available >= 0 AND reserved >= 0 AND sold >= 0 AND capacity >= 0
```

Cross-table (verified by independent SQL after every test run; **not** enforced by a row CHECK
because it spans many rows):

```sql
-- I3: live reservations plus sold units never exceed capacity
SELECT i.tier_id, i.capacity, i.sold,
       COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ('PENDING','CONFIRMED')), 0) AS live_qty
FROM inventory i
LEFT JOIN reservations r ON r.tier_id = i.tier_id
GROUP BY i.tier_id, i.capacity, i.sold
HAVING i.sold + COALESCE(SUM(r.quantity) FILTER (WHERE r.status IN ('PENDING','CONFIRMED')), 0) > i.capacity;
-- expected: 0 rows

-- I4: counters agree with reservation rows
SELECT i.tier_id
FROM inventory i
LEFT JOIN reservations r ON r.tier_id = i.tier_id
GROUP BY i.tier_id, i.reserved, i.sold
HAVING i.reserved <> COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'PENDING'), 0)
    OR i.sold      <> COALESCE(SUM(r.quantity) FILTER (WHERE r.status = 'CONFIRMED'), 0);
-- expected: 0 rows  (after quiescence: no in-flight transactions)

-- I5: no duplicate fulfilment per reservation
SELECT reservation_id FROM bookings GROUP BY reservation_id HAVING COUNT(*) > 1;
-- expected: 0 rows

-- I6: idempotency — one committed record per (user, endpoint, key)
SELECT scope_user_id, scope_endpoint, key, COUNT(*) FROM idempotency_records
GROUP BY 1,2,3 HAVING COUNT(*) > 1;
-- expected: 0 rows (also enforced by UNIQUE index)
```

`I1`/`I2` catch a corrupted counter; `I3` is the oversell detector that the unsafe baseline trips
(see §5). I4 is checked at quiescence only, because mid-transaction the counters legitimately lead
the row inserts of concurrent transactions.

## 4. Reservation state machine

```
                 +---------------------+
                 |      PENDING        |  (available -> reserved)
                 +--+-----+-----+------+
     confirm / ^    |     |     |      v / cancel
               |    |     |     |        |
        CANCELED <---+     |     +---> CONFIRMED   (reserved -> sold)
     (reserved -> available)|            |
                            |            v
                     EXPIRED <--- (TTL passed, DB now())   [reserved -> available]
                (reserved -> available)

Any strategy-level hard failure at request time => FAILED (terminal, no inventory effect)
```

Allowed transitions (enforced in the service layer and by a `CHECK`-style guard in every UPDATE's
`WHERE` clause):

| From | To | Trigger | Inventory effect (same tx) | Guard |
| --- | --- | --- | --- | --- |
| — | PENDING | successful reserve | `available -= q`, `reserved += q` | strategy-specific conditional UPDATE |
| PENDING | CONFIRMED | fake payment success | `reserved -= q`, `sold += q` | `status='PENDING' AND expires_at > now()` |
| PENDING | CANCELED | user cancel | `reserved -= q`, `available += q` | `status='PENDING'` |
| PENDING | EXPIRED | TTL elapsed (worker or sweeper) | `reserved -= q`, `available += q` | `status='PENDING' AND expires_at <= now()` |
| CONFIRMED | CANCELED | *not allowed in v1* | none | refund path is out of scope, documented |
| any terminal | any | **illegal** → rejected with `409 invalid_transition` | none | |

Terminal states: `CONFIRMED`, `CANCELED`, `EXPIRED`, `FAILED`.

Exact confirmation deadline: a reservation is confirmable while `expires_at > (SELECT now())`
evaluated **inside** the confirming transaction, using database time. The boundary race
(confirm vs expire at the same millisecond) is decided by row lock ordering plus the conditional
UPDATE, so exactly one of them changes the row — verified by test `confirm-vs-expire`.

Canceled/returned inventory policy: `PENDING → CANCELED/EXPIRED` returns units to `available`;
`CONFIRMED` units stay in `sold` (no resurrection), which is why post-expiry payment success is a
reconciliation finding rather than a re-reservation.

## 5. Unsafe baseline: expected, honest classification

The lab-only module performs: unlocked `SELECT available` → `pg_sleep(<configurable delay>)` →
blind `UPDATE inventory SET available = :read - :q, reserved = :capacity_read - ...` plus
reservation insert. Consequences measured, not assumed:

- Most common anomaly: **lost update → over-allocation**. Two+ transactions read the same snapshot,
  each writes a counter value that ignores the other, so N reservations exist while capacity supports
  fewer. `I3` returns rows. Row-level `I1` may still arithmetically hold, which is precisely why a
  counter-only CHECK is insufficient protection — the teaching point.
- Depending on interleaving, blind writes can also drive `available` negative or break `I1`, in which
  case PostgreSQL raises `23514` (check violation) and the transaction fails: classified as
  `invariant_violation_failed_insert`, not as a success.
- The unsafe module runs only against `lab.*` fixtures, only when `LAB_ENABLED=true` in
  `local`/`test` environments, and tests assert it cannot touch public inventory.

## 6. Idempotency semantics

Scope = `(user id, endpoint template)`. Key = client `Idempotency-Key`.

| Situation | Behaviour |
| --- | --- |
| New key | Insert `IN_PROGRESS` row inside the same tx as the business write; commit → `COMPLETED` with stored status/body |
| Same key, same request hash, committed | Replay stored status/body + header `Idempotent-Replay: true` |
| Same key, different hash | `409 idempotency_key_reuse` |
| Same key, still `IN_PROGRESS` (concurrent) | `409 idempotency_in_progress` with `Retry-After: 1` (choice documented in ADR-0004) |
| Tx rolled back | `IN_PROGRESS` row disappears with the tx (it was inserted in that tx), so retry is safe |
| Expired record (`expires_at`) | Sweeper deletes; key may be reused |

## 7. Outbox

Inside the business transaction: `INSERT INTO outbox_events(event_type, aggregate_id, payload)`.
A relay worker polls `WHERE published_at IS NULL ORDER BY id` with `FOR UPDATE SKIP LOCKED`,
publishes to BullMQ, marks `published_at`. At-least-once delivery; consumers dedupe on event id and
every consumer operation is idempotent (conditional UPDATE guarded by state).

## 8. Migrations and rollback policy

- Ordered, versioned SQL files, one logical change each, applied inside a transaction by
  `apps/api/src/db/migrate.ts`, recorded in `schema_migrations(version, name, checksum, applied_at)`.
- Every migration ships a paired `*.down.sql`. Rollback policy: revert **one** version at a time,
  take a backup first, and never roll back a migration that dropped a column the deployed API reads —
  therefore schema and code roll forward together in this project (documented in
  `docs/runbooks/migrations.md`).
- Additive changes preferred; destructive changes require a dedicated "no readers verified" note.
