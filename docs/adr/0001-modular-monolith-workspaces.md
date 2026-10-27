# ADR-0001 — Modular monolith in an npm workspace monorepo

Status: accepted (Phase 0).

## Context
The lab must demonstrate transactional correctness, not distributed-system plumbing. Multiple
independently deployable services would multiply infrastructure without improving the lesson, while a
single-file demo would not scale to API + worker + web + load tests + docs.

## Decision
One repository, npm workspaces, three deployable units and two library packages:

- `apps/api` — Express 5 + TypeScript (strict), HTTP boundary, services, repositories.
- `apps/worker` — BullMQ consumer process (outbox relay, expiry sweeper, reconciliation).
- `apps/web` — Next.js App Router (public UI + restricted Engineering Lab).
- `packages/contracts` — Zod schemas and inferred types shared by api/web/worker.
- `packages/config` — shared tsconfig / eslint base.

Modules inside `api` (`events`, `inventory`, `reservations`, `bookings`, `payments`, `idempotency`,
`outbox`, `experiments`, `auth`) expose typed interfaces; routes are thin, services own rules,
repositories own SQL.

## Consequences
+ One transaction can span reservation + idempotency + outbox (required for correctness).
+ Cross-cutting refactors are cheap; deployment stays simple (`api`, `worker`, `web` images).
- No enforced compile-time boundary between modules; mitigated by eslint import rules and review.
- Shared `contracts` package requires workspace-aware build order (handled by `npm run build` order).
