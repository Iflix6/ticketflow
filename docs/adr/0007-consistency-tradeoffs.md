# ADR-0007 — Consistency trade-offs: single-row atomicity, one tier per reservation, no multi-region

Status: accepted (Phase 0).

## Context
Strong correctness and high throughput conflict when 1,000 buyers contend for 100 seats that live in
**one row**. The design must be explicit about which guarantees are absolute and which are relaxed.

## Decision

| Concern | Guarantee in this project | Deliberate relaxation |
| --- | --- | --- |
| Inventory counts | Always strongly consistent; invariant `I1`/`I2` enforced by CHECK | Catalog responses may be cached briefly (advisory) |
| Allocation fairness | First committed transaction wins; no ordering guarantee beyond Postgres row-lock queue | No waiting queue / virtual waiting room |
| Reservation scope | **One tier per reservation** in v1 | Multi-tier carts omitted, so multi-tier lock-ordering deadlock is out of scope by construction |
| Confirmation | Conditional UPDATE wins the confirm-vs-expire race; exactly one effect | No partial confirmation of a multi-quantity reservation |
| Post-expiry payment | Never resurrects inventory; recorded as `reconciliation_findings` + refund-path TODO | Payment is accepted then flagged, not silently dropped |
| Failure semantics | Committed effects only; on error nothing is half-written | No distributed saga (nothing to compensate across services) |
| Isolation level | READ COMMITTED + conditional UPDATE (default strategy A) | REPEATABLE READ/SERIALIZABLE only in measured experiments |

Strategy selection (per experiment, never per deployment convenience):

- **A `atomic_update`** is the production-shaped default: one round trip, no explicit lock statement,
  no retries, sold-out distinguished from conflict by whether the UPDATE returned a row.
- **B `pessimistic`** is kept for comparison and for cases where validation must read *and* write
  several rows under one lock; expected to cost lock-wait time under hot-row contention.
- **C `optimistic`** is kept to show retry amplification: conflicts are retried (bounded, jittered),
  sold-out is not. Under extreme contention on a single row its attempt count exceeds A's.
- **`unsafe_lab`** exists only to demonstrate the anomaly class described in
  `docs/architecture/data-model.md` §5 and is isolated per ADR-0009.

## Measured, not assumed
Throughput, p50/p95/p99, lock wait time, retries, and final invariant results are recorded per run in
`docs/experiments/`. Where a claim cannot be evidenced on the test machine, the report says so.
