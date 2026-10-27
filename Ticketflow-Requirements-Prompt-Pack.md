# TicketFlow Reliability Lab — Master Engineering Agent Specification

## Role and mission

Act as a principal-level backend engineer, systems architect, SRE, security reviewer, and technical writer. Build a complete, reproducible, professionally documented event-ticket booking reliability laboratory. The central demonstration is **1,000 competing buyers attempting to reserve 100 tickets**, with an intentionally unsafe baseline and multiple correct algorithms. This is a portfolio and education project, not a payment processor or a production ticket marketplace. Do not claim production readiness without evidence.

**Mandatory stack:** Node.js LTS, Express.js, TypeScript (strict), PostgreSQL, `pg` (node-postgres), versioned SQL migrations, Redis, BullMQ, Next.js (App Router) + TypeScript + Tailwind CSS, Zod, Vitest, Supertest, k6, Pino, Prometheus, Grafana, OpenTelemetry, Docker Compose, GitHub Actions. No Laravel, NestJS, Fastify, Prisma, Sequelize, TypeORM, or other ORM. SQL is explicit and parameterized. Prefer minimal libraries; justify each addition.

## Working agreement

1. Inspect the repository first. If empty, scaffold; if populated, preserve useful work. Produce a short plan and architecture decisions before editing.
2. Implement in small, verifiable phases, running tests and documenting results after each. Do not stop at architecture diagrams, pseudocode, or scaffolding.
3. Never fabricate benchmarks, test passes, throughput, or screenshots. Report actual commands, environment, measured values, failures, and limitations. If a tool is unavailable, document how to reproduce.
4. Make pragmatic choices without repeatedly asking for approval. Ask only when blocked by a consequential ambiguity or an irreversible operation.
5. No real payments, financial credentials, third-party customer data, or employer-specific business logic. Use synthetic test data and a deterministic fake payment provider.
6. Deliver readable, maintainable code and explain why correctness holds, including where it does not.

## Product scope

Two experiences: (A) a simple public event catalog and booking UI; (B) a restricted **Engineering Lab** dashboard for creating isolated experiments, choosing a booking strategy, configuring capacity and concurrent users, launching or importing k6 tests, viewing real metrics, inspecting failures, and comparing strategies. Provide a local-only experiment runner; never expose load-test or unsafe endpoints publicly by default. Show environment and experiment identifiers clearly.

### Core domain

- Event: id, slug, title, description, start_at, status, timestamps.
- Ticket tier: id, event_id, name, price_display_only, capacity, timestamps.
- Inventory: tier_id PK, capacity, available, reserved, sold, version, updated_at; invariant `available + reserved + sold = capacity`, all nonnegative. Define whether canceled tickets return to inventory.
- Reservation: id, user_id, tier_id, quantity, status (`PENDING`, `CONFIRMED`, `EXPIRED`, `CANCELED`, `FAILED`), expires_at, idempotency_key reference, timestamps. Use explicit state-transition rules and prevent illegal transitions.
- Booking/order: id, reservation_id unique, status, timestamps; do not duplicate fulfillment on retries.
- Fake payment attempt: id, booking_id, provider_reference unique, status, simulated outcomes, timestamps. No real funds or external gateway.
- Idempotency record: scope (user + endpoint), key, request_hash, state (`IN_PROGRESS`, `COMPLETED`), response status/body, resource reference, timestamps and expiry; unique(scope,key). Define handling for concurrent same-key requests and differing payloads.
- Outbox: id, event_type, aggregate_id, payload, created_at, published_at, attempt_count; worker delivery is at least once, consumers must deduplicate.
- Audit record: actor, action, aggregate, metadata, occurred_at; avoid secrets/PII.
- Experiment run: id, strategy, configuration, started_at, finished_at, git_sha, environment, outcomes, report locations; immutable summary after completion.
- Experiment result: run_id, user/request outcome, status, latency, failure classification, timestamp, correlation id (bounded retention).

Provide SQL DDL with primary/foreign keys, uniqueness, CHECK constraints, useful indexes and migration rollback policy. Use UUIDs or another well-reasoned identifier strategy. Use `TIMESTAMPTZ`, UTC storage, explicit timeouts. Include a seed dataset and a resettable experiment fixture. Explain what is authoritative and what is derived.

## Consistency model and correctness

PostgreSQL is the single authoritative inventory source. Redis caches are advisory and must never independently authorize a sale. Define the linearization point of successful reservation. A successful reservation atomically decrements available and increments reserved, and inserts its reservation record in the **same database transaction**. Confirmation atomically moves reserved to sold and updates booking/payment state. Expiration atomically returns reserved to available **only if still pending**. Use conditional updates to ensure exactly one winner in confirm-versus-expire races. Always lock/update rows in a consistent order for multi-tier operations, or explicitly limit v1 to one tier per reservation.

**Safe strategy A — atomic conditional UPDATE (preferred default):** `UPDATE inventory SET available=available-$qty, reserved=reserved+$qty, version=version+1 WHERE tier_id=$id AND available >= $qty RETURNING ...`, followed by reservation insert in the same transaction. On zero rows return sold-out/conflict, not an internal error.

**Safe strategy B — pessimistic locking:** `SELECT ... FOR UPDATE` on the inventory row inside a transaction, validate, mutate, and insert reservation; compare throughput and contention.

**Safe strategy C — optimistic version check:** read version, conditional UPDATE with `WHERE version=$expected AND available >= $qty`, retry boundedly with jitter; distinguish conflict from sold out.

**Unsafe baseline:** deliberately read inventory without a lock, introduce a configurable artificial delay, then perform an unsafe read-modify-write and insert, in a separately named lab-only module and isolated database/fixture. It must visibly demonstrate a real anomaly when possible, not rely on assumed overselling. If constraints block overselling, classify the observed failure accurately (e.g. invariant violation, lost update, failed insert). Do not weaken the safe schema or allow unsafe code to operate on live/public inventory. Include explicit warnings and automated isolation checks.

Use `pg.Pool`; obtain one `PoolClient` for an entire transaction (`BEGIN`/`COMMIT`/`ROLLBACK`/`release` in finally), never mix `pool.query` into a transaction. Implement a typed transaction helper with configurable statement/lock timeouts and retry only on appropriate transient PostgreSQL codes (e.g. 40001, 40P01), with bounded attempts and jitter. Do not blindly retry non-idempotent side effects. Define isolation level (READ COMMITTED default) and demonstrate differences with REPEATABLE READ/SERIALIZABLE only where supported by actual tests.

### Idempotency and exactly-once claims

Require `Idempotency-Key` on booking mutation requests. Same scope/key/hash returns the original committed outcome; same key/different payload returns 409; concurrent same-key requests must not create two reservations. Choose a PostgreSQL-backed unique-key acquisition approach with transactionally consistent result persistence and a documented behavior for in-progress requests (wait briefly or return 409/425 + Retry-After). On transaction rollback, ensure key can be safely retried. Document that exactly-once processing across external systems is generally not guaranteed; achieve effectively-once business effects using unique constraints, idempotent consumers, and transactional outbox.

### Expiration and simulated payments

Reservations have configurable TTL (e.g. 5 minutes). Fake payment success/failure/timeout and webhook-style duplicate/out-of-order callbacks are simulated. A successful payment after expiry must not resurrect inventory; record and reconcile the discrepancy according to a documented policy. Background expiration jobs are best-effort; correctness must not depend solely on the scheduler firing exactly on time. Provide periodic sweeper/reconciliation. Use database time for deadline comparisons. Specify the exact moment a reservation ceases to be eligible for confirmation and test boundary races.

## API contract

Version all endpoints under `/api/v1`. Generate OpenAPI 3.1 documentation with request/response examples and error taxonomy. At minimum:

- `GET /events`, `GET /events/:id`, `GET /events/:id/tiers`
- `POST /reservations` with event/tier/quantity and idempotency key; `GET /reservations/:id`; `POST /reservations/:id/cancel`
- `POST /reservations/:id/checkout` invoking fake payment; `GET /bookings/:id`
- `GET /me/bookings`
- Lab-only, authenticated and disabled outside local/test: `POST /lab/runs`, `GET /lab/runs`, `GET /lab/runs/:id`, `GET /lab/runs/:id/results`, `POST /lab/fixtures/reset`, `GET /lab/strategies`
- `GET /health/live`, `GET /health/ready`, internal `/metrics`

Define exact JSON schemas, status codes (201, 200, 202, 400, 401, 403, 404, 409, 422, 429, 500, 503), pagination, request IDs, timestamps, error shape, and rate limits. Use Zod at request boundaries. Never trust client-provided price or inventory counts. Auth can be a small local demo identity system with password hashing and secure cookie sessions, or explicitly documented local test tokens; lab/admin routes must be access-controlled. No default hardcoded production credentials. CORS allowlist, secure headers, body limits, SQL parameters, safe error reporting, audit logs.

## Modular code structure

Use a pnpm workspace or npm workspaces; choose one and document it. Suggested structure:

```
apps/
  api/src/
    app.ts server.ts config/ middleware/ routes/
    modules/{auth,events,inventory,reservations,bookings,payments,idempotency,outbox,experiments}/
    db/{pool.ts,transaction.ts,migrations,queries}/
    jobs/ observability/ shared/
  web/{app,components,lib,features}/
  worker/src/{main.ts,processors,scheduled}/
packages/{contracts,config}/
infra/{docker,postgres,prometheus,grafana,otel}/
load-tests/{scenarios,fixtures,thresholds}/
docs/{architecture,adr,api,experiments,runbooks,video}/
scripts/
.github/workflows/
```

Modules expose typed interfaces; route handlers stay thin, services own business rules, repositories own SQL, and domain transitions are unit-tested. Avoid generic abstraction for its own sake. Separate API and worker processes. Validate env variables at startup; include `.env.example` only.

## Redis, BullMQ, and outbox

Redis for cache, rate limiting and queues, not ticket allocation truth. Use BullMQ for expiration notifications, outbox delivery, fake email notifications and reconciliation. Avoid enqueueing a job as the sole side effect of a DB commit: insert outbox event inside the DB transaction, publish asynchronously, and handle duplicate publication/consumption. Implement exponential backoff with jitter, retry ceilings, dead-letter/failure inspection, worker concurrency controls, job retention, poison-message handling, graceful shutdown and health checks. Show worker restart recovery and Redis outage behavior. Clarify when to degrade, reject, or continue with database-only booking.

## Frontend and engineering lab

Create responsive, accessible Next.js UI with event list/details, quantity selection, reservation countdown, fake checkout, booking status, meaningful loading/error states and no misleading success before server confirmation. Engineering Lab pages: scenario builder (users, capacity, request rate, strategy, injected delay, TTL), live progress (SSE preferred), results dashboard (attempted/succeeded/sold out/duplicate/conflict/error, inventory invariants, p50/p95/p99, throughput, duration), compare runs, request timeline, failure explorer, architecture/SQL explanation panels, export CSV/JSON, and shareable local run report. Charts must use real run data, not invented placeholders. Ensure unsafe strategy cannot be triggered on a non-lab deployment. Use proper keyboard navigation and semantic HTML.

## Load tests and experiment methodology

k6 scenarios:

1. 1,000 competing virtual users, one ticket each, exactly 100 tickets; ramp and simultaneous-start variants.
2. Same idempotency key repeated concurrently.
3. Unique keys with 100, 500, 1,000, 5,000 request levels; control generator saturation.
4. Mixed read/write traffic and hot-tier contention.
5. Cancel/expire/confirm race; delayed payment callback.
6. Redis down, worker killed/restarted, DB transient failure, slow queries, queue backlog.
7. Baseline unsafe versus safe A/B/C with identical seeds and comparable environment.

Record the test machine, CPU/memory, Node/Postgres/Redis versions, pool size, concurrency, test duration, data reset, p50/p95/p99, RPS, error classifications, database lock waits, CPU/memory, and final invariant query. Separate application rejections (sold out) from server failures. Explain coordinated omission and load-generator limitations; avoid treating 1,000 VUs as exactly 1,000 simultaneous database transactions. Provide repeatable k6 commands and seed/reset scripts. Use a synchronization barrier for a truly simultaneous attempt scenario if implemented, and label its limitations.

## Correctness verification

Mandatory automated tests:

- Domain state-machine transitions, invalid transitions, TTL boundaries.
- Integration tests against actual PostgreSQL and Redis, not only mocks.
- Multi-process concurrent reservation test verifying **no more than 100 tickets confirmed/reserved from 100 capacity**, exactly consistent inventory accounting, no duplicate bookings, and no negative inventory.
- Concurrent same-key idempotency; mismatched body; retry after timeout; rollback and retry.
- Confirmation versus expiration race, cancellation versus confirmation race, duplicate fake callbacks.
- DB deadlock/serialization retry handling; outbox duplication; worker crash before/after processing.
- Cache staleness cannot authorize oversell; queue outage does not silently lose committed outbox events.
- Auth, authorization, rate limiting, validation, SQL injection attempts, lab endpoint isolation.
- E2E UI flows and accessibility smoke tests.

Assert database invariants via independent SQL queries after every test run. Do not infer correctness from HTTP 200 counts alone. Provide a `make verify` or equivalent single-command acceptance suite.

## Observability and operations

Pino JSON logs with request ID, run ID, reservation ID, strategy, outcome, elapsed time, sanitized error; no sensitive payloads. Prometheus metrics for request rates, latency histograms, booking outcomes, lock waits, DB pool utilization, queue lag, job retries, outbox age, inventory reconciliation mismatches. OpenTelemetry traces across HTTP, SQL, workers and outbox events where feasible. Grafana dashboards provisioned as code. Avoid high-cardinality metric labels (no user_id, booking_id, request_id). Health checks distinguish liveness and readiness. Add graceful shutdown, pool draining, resource limits, DB backup/restore walkthrough, schema migration procedure, alert examples, incident runbooks and troubleshooting guides.

## Security and deployment constraints

Docker Compose starts PostgreSQL, Redis, API, worker, web, Prometheus, Grafana, and optional collector with one command. Use non-root containers where practical, pinned versions, health checks, persistent volumes, isolated networks, `.dockerignore`, multi-stage builds, and documented resource requirements. No real payment processing. Never publish unsafe lab mode or admin test controls to the internet. CI: lint, typecheck, unit tests, integration tests with service containers, migration smoke test, security/dependency scan, build, and a bounded concurrency test. Use least-privilege DB roles where feasible. Document that local lab settings are not production deployment guidance.

## Engineering documentation deliverables

- Root README with prerequisites, quickstart, architecture, feature list, and 1,000-vs-100 reproduction commands.
- C4 context/container/component diagrams (Mermaid), sequence diagrams for reserve/confirm/expire/idempotency/outbox, and ERD.
- ADRs for modular monolith, PostgreSQL source of truth, transaction strategy, idempotency, queue/outbox, unsafe isolation, and consistency trade-offs.
- OpenAPI spec and example curl requests.
- `docs/experiments/` methodology, actual measured result reports and comparison charts; include raw k6 JSON/CSV where practical.
- `docs/runbooks/` worker failure, Redis outage, DB lock contention, reconciliation mismatch, migrations, and rollback.
- `docs/video/` 10-episode engineering-video plan: hooks, demonstrations, exact commands, shots, expected concepts, placeholders for real results, concise 60–75 second scripts after experiments have been run. Never invent results.
- Clear architecture limitations and a production-hardening backlog (multi-region, real payments, seat maps, fraud prevention, accessibility, disaster recovery).

## Implementation phases and acceptance gates

**Phase 0 — Discovery and design:** inspect repo, write plan, ADRs, diagrams, schemas, risk register, and exact commands. Gate: documented invariants and state transitions.

**Phase 1 — Foundation:** monorepo, TS strict, Express app, PostgreSQL pool/migrations/seeds, Docker, env validation, tests, lint/typecheck, CI skeleton. Gate: fresh checkout boots and tests pass.

**Phase 2 — Safe core:** events, inventory, atomic reservations, state transitions, idempotency, fake checkout, cancellation/expiry. Gate: independent SQL invariant checks and integration tests pass.

**Phase 3 — Comparative strategies:** pessimistic and optimistic variants; isolated unsafe baseline. Gate: safe variants never oversell in repeated controlled experiments; unsafe behavior accurately observed or limitations reported.

**Phase 4 — Async and recovery:** Redis/BullMQ, outbox, workers, sweepers, retries, reconciliation, fault injection. Gate: recover from worker restarts and duplicates without violating invariants.

**Phase 5 — UI and lab:** public booking experience and restricted experiment dashboard. Gate: end-to-end flows, accessibility, real results.

**Phase 6 — Observability and benchmarking:** Prometheus/Grafana/traces, k6, repeatable comparisons and performance investigation. Gate: documented actual results, system metrics and SQL invariant evidence.

**Phase 7 — Hardening and publication:** security review, CI completeness, docs, runbooks, scripts, video guides, final audit. Gate: a new engineer can reproduce the flagship 1,000-users/100-tickets experiment from README without hidden manual steps.

## Definition of done

A clean clone boots with documented commands; all required services and migrations initialize; the 1,000/100 experiment is reproducible; safe strategies preserve inventory and idempotency under concurrency; unsafe baseline is isolated and instructive; reservation lifecycle and background recovery work; monitoring shows real data; CI verifies key guarantees; documentation and video plans are complete. Report incomplete items explicitly instead of silently claiming success.

## Required agent response format after each phase

1. What was built and why.
2. Files added/changed.
3. Commands executed and actual outcomes.
4. Correctness evidence and measurements.
5. Known risks, trade-offs, and blockers.
6. Next phase plan.

**Start now:** inspect the repository, identify existing constraints, produce Phase 0 design and execution plan, then implement Phase 1. Continue phase by phase unless blocked. Do not substitute an implementation proposal for working code.