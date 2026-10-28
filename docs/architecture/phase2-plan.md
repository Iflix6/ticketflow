# Phase 2 — Safe core: reservations, state transitions, idempotency, fake checkout

Status: **done**. Gate (master pack §Implementation phases): *"independent SQL invariant checks and
integration tests pass."* Every claim below is traceable to a file that can be re-read or a test that can
be re-run; nothing here describes an intended design that the code does not implement.
ADRs established/used here: 0002 (PostgreSQL source of truth), 0003 (transaction strategy),
0004 (idempotency), 0006 (identifiers and database clock), 0007 (consistency trade-offs).

## The correctness model, stated once

Inventory for a tier is exactly three counters that must always partition its capacity:

```sql
CONSTRAINT inventory_counters_partition_capacity
  CHECK (available + reserved + sold = capacity)          -- migration 0002, invariant I1/I2
CONSTRAINT inventory_capacity_matches_tier FOREIGN KEY (tier_id, capacity)
  REFERENCES ticket_tiers (id, capacity)                  -- capacity cannot mutate underneath live counters
```

Both live in `0002_core_catalog.up.sql` and are **not weakened anywhere**, including for the lab schema.
A negative counter is not representable: `tests/integration/concurrent-reservation.test.ts` asserts the
database itself rejects it (`await expect(db.query('UPDATE inventory SET available = -1 …'))
.rejects.toMatchObject({ code: '23514' })` — CHECK_VIOLATION).

Reservation lifecycle: `PENDING → CONFIRMED | CANCELED | EXPIRED | FAILED`, and terminal rows never move.
That is enforced twice, deliberately (`reservations/state-machine.ts` mirrors the trigger in
`0005_booking_lifecycle.up.sql`): the `reservations_enforce_transition` trigger raises **SQLSTATE TF001**
and rolls the transaction back, while the application guard produces a clean `invalid_transition` 409. The
service comment states the reason for the duplication — *when the two ever disagree, the database wins*.
`isLegalTransition` treats `from === to` as legal so an idempotent guard does not fight the trigger, and
`isConfirmable` is `status === 'PENDING' && expiresAt > now` — confirmation is possible **strictly before**
the deadline.

## Mechanism — one transaction per mutation

Every write path (`createReservation`, `cancelReservation`, `checkout`) is ONE transaction that bundles the
idempotency-key acquisition, the inventory counter change, the reservation/booking rows, the outbox event
and the audit record (`reservations/service.ts`, `runTx`). That bundling *is* the correctness story: there
is no interleaving where money moved but inventory did not, because they share one commit.

The split between throwing and committing is explicit and load-bearing:

- **Thrown** (transaction rolls back, `IN_PROGRESS` key row disappears with it, so the key is free):
  `sold_out`, optimistic `conflict` after the retry budget, wrong owner, `invalid_transition`, a
  concurrently-moved reservation. A sold-out request must never pin an idempotency key to a failure —
  seats freed by a later expiry have to remain bookable with that same key
  (`reservations.test.ts` → *"returns 409 sold_out and frees the key so a later attempt is not pinned to
  the failure"*).
- **Committed** (a 409 is written into the idempotency record and survives): `reservation_not_confirmable`,
  including the payment-after-expiry case, because its reconciliation finding must be durable.

Allocation is a single **conditional UPDATE whose `WHERE` is the guard** (`tryAllocate`):

```sql
UPDATE inventory SET available = available - $2, reserved = reserved + $2, version = version + 1
 WHERE tier_id = $1 AND available >= $2
 RETURNING available, reserved, sold, version;
```

The row lock that UPDATE takes is the linearization point, so there is no read-then-write window to lose
an update in; zero rows returned means sold out, and the caller must not treat it as an internal error.
Safe B (`SELECT … FOR UPDATE` then guarded write) and Safe C (compare-and-set on `version`, bounded to
`OPTIMISTIC_MAX_ATTEMPTS = 5` with jitter) ship in Phase 3 but already return the same discriminated
`AllocationResult`, so `sold_out` and `conflict` are distinct outcomes here and are never conflated.
`findTierForUpdate` locks the tier/inventory rows even though Safe A does not strictly need it: it also
freezes the price, so the amount copied onto a booking is the price that was in effect when the allocation
succeeded. Clients never supply a price — `total_amount` is computed server-side
(`multiplyMoneyByInt(tier.price_display_only, quantity)`; the test asserts `2 × 10.00 === '20.00'`).

## Idempotency (ADR-0004)

`idempotency_records` is scoped `(scope_user_id, scope_endpoint, key)` with a UNIQUE constraint
(`0004_idempotency.up.sql`), `key` length 8..128, `state IN ('IN_PROGRESS','COMPLETED')`, and a CHECK that
a `COMPLETED` row carries the response it replays. Acquisition (`idempotency/repository.ts`) runs on the
**caller's** client and yields four kinds:

| kind | how it arises | what the service does |
| --- | --- | --- |
| `NEW` | `INSERT … ON CONFLICT DO NOTHING RETURNING id` produced a row | proceed; `completeIdempotency` later writes status/body/resource in the same transaction |
| `REPLAY` | conflict, existing row `COMPLETED`, same `request_hash` | return the stored status and byte-identical body; response carries `idempotent-replay: true` |
| `IN_PROGRESS` | conflict, existing row still in progress — or the row **vanished** between conflict and read (concurrent rollback) | 409 `idempotency_key_reuse`/`idempotency_in_progress`; the vanished-row corner is reported as in-progress so the caller retries instead of trusting a phantom state |
| `REUSE_MISMATCH` | conflict, `COMPLETED`, different `request_hash` | 409 `idempotency_key_reuse` "already used with a different request body" |

`request_hash` is `sha256(canonicalJson(payload))` (`hashRequestPayload`, `shared/crypto.ts`: keys sorted
recursively, insignificant whitespace removed, `undefined` dropped — so `{a:1,b:2}` and `{b:2,a:1}`
fingerprint identically, which is what stops a client that merely re-serializes a body from getting a
spurious `idempotency_key_reuse`). The canonical fields for create are tierId, quantity, the **explicit**
TTL or null, and strategy — so omitting the TTL and passing the effective value explicitly hash alike. The
endpoint scope is the template (`POST /api/v1/reservations`) or the concrete path for the per-resource
routes (`POST /api/v1/reservations/<id>/cancel`). Mutations without the header are rejected before any
work (`requireIdempotencyKey`).

Beyond the key, two operations are **idempotent by resource**: canceling an already-`CANCELED` reservation
returns 200 with the row and no second release, and checking out an already-`CONFIRMED` reservation replays
the existing booking whatever key is presented. `bookings.reservation_id UNIQUE`
(`0005_booking_lifecycle.up.sql`, invariant I5) makes a second fulfilment structurally impossible.

## Fake checkout — including the ambiguity nobody documents

`payments/fake-provider.ts` is a **pure function**: no network, no config, no `Math.random()`. Its
`provider_reference` is `fake_<sha256(reservationId|outcome)>`, so a replayed checkout produces the same
reference and `payment_attempts.provider_reference UNIQUE` turns a double submit into a no-op rather than
two rows. `simulatedOutcome` maps deterministically: `success → SUCCEEDED`, `failure → FAILED`,
`timeout → TIMEOUT`.

The four outcomes get four deliberately different transaction shapes:

- **success** → conditional `confirmReservation` (which re-checks `expires_at > app.now()`), booking
  `CONFIRMED`, `commitReservedToSold`, two outbox events, **201**.
- **failure** → `failReservation(…, 'payment_declined')`, seats released, booking + attempt recorded as
  `FAILED`, **200** (a decline is a completed business interaction, not a server error).
- **timeout** → **nothing is finalized**: hold stays `PENDING`, no booking row, audit record only, **202
  Accepted**. The comment is the policy: *we never mark money as settled on an ambiguous provider signal*.
- **confirm-vs-expire race** → `confirmReservation` returns no row, so the same transaction expires the
  hold and releases the seat, writes a `reconciliation_findings` row of kind `payment_after_expiry` (that
  table ships in `0007_experiments.up.sql`, alongside the five permitted finding kinds), and returns a
  **committed** 409 `reservation_not_confirmable`. Inventory is never resurrected to satisfy a late
  payment.

`request.delayMs` (simulated gateway latency) is applied **before** the transaction opens, so a slow
"provider" cannot hold row locks open — the race above is still reachable, it is just not widened by
holding a connection.

## Expiry

`expireDueReservations` is set-based and sweeper-safe:
`WHERE id IN (SELECT … WHERE status = 'PENDING' AND expires_at <= app.now() FOR UPDATE SKIP LOCKED)`,
returning tier/quantity so releases happen in the same transaction: two concurrent sweeps can therefore
never double-release a seat. The DB clock (`app.now()`, ADR-0006) decides every deadline comparison —
no application `Date.now()` in the TTL path — which is what makes the confirm/expire branch and the
sweeper mutually consistent. The BullMQ worker that runs this on a timer is Phase 4
(`docs/architecture/phase4-plan.md`); the SQL is tested here because it is a Phase 2 correctness surface.

## Independent verification

`0009_invariant_views.up.sql` exists specifically so assertions do not share code with the paths under
test: `I1/I2` row self-consistency, `I3` over-allocation (`live_qty > capacity` — not expressible as a
single-row CHECK, and the one the unsafe baseline breaks), `I4` counter drift against the reservation
ledger, `I5` duplicate bookings, `I6` duplicate idempotency scope. `npm run invariants -- --quiescent`
promotes I4 from advisory to blocking and is a CI step.

Measured on this checkout — the tests named in this document, re-runnable with the command shown:

```
npx vitest run --config vitest.integration.config.ts \
  tests/integration/reservations.test.ts tests/integration/concurrent-reservation.test.ts \
  tests/integration/expiry-sweeper.test.ts          # vitest 3.2.7, Node v26.1.0, PostgreSQL 18.6

  ✓ concurrent-reservation.test.ts   2 passed  (5463 ms)
  ✓ reservations.test.ts            15 passed  (2831 ms)
  ✓ expiry-sweeper.test.ts           5 passed  (1448 ms)
  Test Files 3 passed (3)   Tests 22 passed (22)   Duration 16.29 s

  "120 concurrent single-seat allocations on 100 capacity: exactly 100 win" → winners 100,
    soldOut 20, counters {capacity:100, available:0, reserved:100, sold:0}, invariant rows 0
  "a blind read-modify-write WITHOUT the guard loses an update that CHECK alone cannot catch"
    → both clients read the same snapshot, both write (9,1); 2 tickets taken, 1 decrement survived;
      CHECK silent, app.counter_drift_violations reports I4_counter_drift
```

That second test is the honest headline of this phase: **CHECK constraints alone do not detect a lost
update.** Both values written are legal; only ledger reconciliation (I4) sees the drift. That is precisely
why the invariant views are separate from the constraints.

## Limitations carried forward

- **The 202 timeout path has no automatic resolution of a late success.** A payment that reports success
  after we returned 202 is reconciled only if a later sweep/checkout observes it; `payment_attempts`
  statuses `SUCCEEDED_NOT_FULFILLED` exists in the schema for that, and the recovery work is Phase 4.
- `forbidden` (403) rather than 404 for another owner's resource discloses that the id exists. Verified
  behaviour (`assertOwner`, `BookingsService.getBooking`), documented in
  `docs/api/openapi.yaml` → `OwnershipForbidden`, with the additional caveat that a `LAB_ADMIN` token reads
  any reservation or booking, so 403 is not a complete privacy boundary in a lab-enabled deployment.
- Idempotency replays return the stored body, so a response that embeds a *later* state change is not
  refreshed — replay is byte-stable by design, which is correct for retries and wrong as a polling
  mechanism.
- Reservation rows are never deleted and keys expire only by `expires_at` sweep, so long-lived test
  databases accumulate both; no retention job exists yet.

---

Previous: [Phase 1 — Foundation](phase1-plan.md) ·
Next: [Phase 3 — Comparative strategies and the isolated unsafe lab](phase3-plan.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md)
