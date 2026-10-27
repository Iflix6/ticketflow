# ADR-0002 — PostgreSQL is the single authoritative inventory source

Status: accepted (Phase 0).

## Context
Redis is fast, and "reserve in Redis, reconcile later" is a common ticketing pattern. It also makes
correctness claims dependent on cache fidelity, replication lag, and eviction policy — exactly the
failure modes this lab is meant to expose rather than embody.

## Decision
- All allocation decisions are made by PostgreSQL in a single transaction. No read of Redis, cache,
  or in-process state may authorize a sale.
- Redis is used for: response caching (advisory), rate limiting (advisory), BullMQ queues.
- Linearization point of a successful reservation = commit of the transaction that performs the
  conditional inventory UPDATE, the reservation INSERT, the idempotency record, and the outbox event.
- Cache staleness is allowed to cause an extra DB round-trip or an unnecessary "sold out" *hint* that
  is re-checked against the DB before being returned.

## Rejected alternatives
- Redis `DECR`-based allocation with Lua: correct-ish under single writer, but loses the DB invariant,
  complicates refunds/expiry, and cannot be verified by SQL — rejected for a teaching artifact.
- Database-level materialized view for availability: adds refresh latency as a correctness input.

## Consequences
+ Every guarantee is verifiable with independent SQL (`docs/architecture/data-model.md` §3).
+ Redis outage degrades throughput only; booking continues DB-only (documented runbook).
- Throughput ceiling is the DB row's lock throughput; that is the point of comparing A/B/C.
