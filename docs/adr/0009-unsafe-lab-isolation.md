# ADR-0009 — Isolation of the intentionally unsafe baseline

Status: accepted (Phase 0).

## Context
The lab must *show* a lost-update/oversell anomaly. Naively doing that by weakening the production
schema (dropping the CHECK, removing the conditional WHERE) would (a) risk the real inventory path and
(b) teach the wrong lesson, since the correct takeaway is "the unsafe *code path* is wrong", not
"constraints are annoying".

## Decision — four independent layers of isolation
1. **Schema separation.** The unsafe path writes only to the `lab` schema
   (`lab.inventory`, `lab.reservations`), created by its own migration and populated by
   `POST /api/v1/lab/fixtures/reset` (local/test only). Public tables are unreachable from the unsafe
   module because it receives a repository bound to `lab.*` identifiers — and the DB role used by the
   API can be restricted to `lab` writes in the compose setup (documented least-privilege variant).
2. **Configuration gate.** `LAB_ENABLED` must be `true` **and** `NODE_ENV` ∈ {`local`, `test`} for the
   `/api/v1/lab/*` router and the `unsafe_lab` strategy to exist at all. Otherwise the router is not
   mounted (404) and strategy resolution rejects `unsafe_lab` with `403 lab_disabled`.
3. **Authorization.** Lab routes require an authenticated `LAB_ADMIN` session; there are no default
   credentials — the admin user is created by `npm run seed:lab` printing a one-time local password.
4. **Automated isolation checks.** Tests assert that (a) running the unsafe strategy to completion
   leaves public `inventory` rows byte-identical (checksum query), (b) `unsafe_lab` is unavailable when
   `NODE_ENV=production`, and (c) the unsafe repository has no import path to public tables. CI runs
   these as part of `npm run verify`.

## Anomaly reporting honesty
If a Postgres constraint prevents overselling in a given interleaving, the run classifies the outcome
as `invariant_violation_failed_insert` with the recorded SQLSTATE (`23514`) rather than reporting a
generic "oversell happened". Reports include the exact observed counts and the invariant query output.
