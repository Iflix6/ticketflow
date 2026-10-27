# ADR-0006 — Identifiers and time: database-generated UUIDs, `TIMESTAMPTZ`, DB clock

Status: accepted (Phase 0).

## Context
Reservation IDs appear in URLs, logs, idempotency records, and outbox payloads. Deadline decisions
(confirm-vs-expire) must not depend on any clock a client or a second process controls.

## Decision
- All primary keys are `uuid`, generated **by the database**: `uuid7()` where the pinned PostgreSQL
  server provides it (time-ordered → better B-tree locality and roughly monotonic log/URL ordering),
  otherwise `gen_random_uuid()` (v4). The choice is made by a capability probe in migration
  `0001_extensions.sql`, and the observed outcome is recorded in `docs/experiments/environment.md` —
  not asserted optimistically.
- No sequential integer business IDs (avoids enumerable resources and hot-spot contention).
- Every timestamp column is `timestamptz`, storage and comparison in UTC, defaults `now()`.
- All deadline logic uses `now()` evaluated by the server **inside** the relevant transaction.
  Application clocks are used only for latency measurement, never for eligibility decisions.
- API responses carry ISO-8601 strings with offset; lab reports carry both epoch micros and ISO text.

## Rejected alternatives
- Application-side UUIDv7 generation: extra library, clock-skew dependent, and duplicates risk under
  misconfigured generators.
- `bigint` identity + hashids: complexity without benefit for a local lab.
