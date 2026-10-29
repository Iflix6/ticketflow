# TicketFlow Reliability Lab

> **A production-oriented event ticketing and reliability engineering laboratory for exploring concurrency, transactional consistency, reservation expiration, idempotency, asynchronous processing, and observability under load.**

**Project status:** Implemented through Phase 7 (hardening and publication). The flagship experiment is
reproducible and has been measured — see
[Reproduce the flagship experiment](#reproduce-the-flagship-experiment-1000-buyers-vs-100-tickets),
[`docs/experiments/`](docs/experiments/), and [`docs/security/audit.md`](docs/security/audit.md). Run
`npm run verify` to reproduce the full gate locally.

> **Quick start.** `cp .env.example .env && npm install && npm run db:up && npm run migrate &&
> npm run seed -- --experiment && npm run build && npm run boot:smoke`. On Windows, if a native
> PostgreSQL owns `:5432`, keep `POSTGRES_PORT=5433` and use `:5433` in `DATABASE_URL` (the working
> `.env` already does).

## Overview

TicketFlow Reliability Lab is a full-stack ticket booking system designed around a deceptively difficult question:

**What happens when 1,000 people try to buy the last 100 tickets at the same time?**

The objective is not merely to display events and accept bookings. The objective is to demonstrate how a system can preserve inventory correctness, provide predictable user experiences, recover from failures, and remain observable when traffic spikes.

The initial reference scenario is **1,000 concurrent booking attempts competing for 100 available
tickets**. It is no longer only hypothetical: the harness in [Reproduce the flagship
experiment](#reproduce-the-flagship-experiment-1000-buyers-vs-100-tickets) has run it over real HTTP and
measured the outcome (exactly 100 confirmed, 900 `sold_out`, **zero oversells**, all six invariant views
passing on a quiet host; under host load the same run fails safe with retryable 5xx and still never
oversells). Latency/throughput numbers are host-dependent and reported as such, not as a headline
benchmark claim.

### Engineering goals

- Prevent overselling even under concurrent requests.
- Guarantee that a ticket allocation is never duplicated.
- Make retried booking operations idempotent.
- Expire abandoned reservations and release their inventory safely.
- Process non-critical work asynchronously without weakening booking correctness.
- Provide measurable behavior through logs, metrics, traces, and load tests.
- Make failure modes reproducible and document the resulting tradeoffs.

### Non-goals for the first release

- Real payment processing or storage of payment credentials.
- Secondary-market ticket resale.
- Multi-region active-active inventory writes.
- Blockchain ticket ownership.
- A guarantee of exactly-once message delivery.

---

## Table of contents

1. [Problem statement](#problem-statement)
2. [System invariants](#system-invariants)
3. [Technology stack](#technology-stack)
4. [Architecture](#architecture)
5. [Core domain model](#core-domain-model)
6. [Reservation lifecycle](#reservation-lifecycle)
7. [Concurrency control](#concurrency-control)
8. [Idempotency and retries](#idempotency-and-retries)
9. [Expiration and recovery](#expiration-and-recovery)
10. [Asynchronous jobs and transactional outbox](#asynchronous-jobs-and-transactional-outbox)
11. [API design](#api-design)
12. [Frontend experience](#frontend-experience)
13. [Security and abuse prevention](#security-and-abuse-prevention)
14. [Observability](#observability)
15. [Testing strategy](#testing-strategy)
16. [Load-testing scenarios](#load-testing-scenarios)
17. [Performance reporting](#performance-reporting)
18. [Repository structure](#repository-structure)
19. [Local development](#local-development)
20. [Environment configuration](#environment-configuration)
21. [Deployment considerations](#deployment-considerations)
22. [Failure injection](#failure-injection)
23. [Engineering decisions and tradeoffs](#engineering-decisions-and-tradeoffs)
24. [Roadmap](#roadmap)
25. [Definition of done](#definition-of-done)
26. [Contributing](#contributing)
27. [License](#license)

---

## Problem statement

Traditional CRUD implementations often follow this pattern:

1. Read the number of available tickets.
2. Check whether the requested quantity is available.
3. Insert a booking.
4. Reduce the available quantity.

This is unsafe when multiple requests execute concurrently. Two requests can read the same availability before either updates it, allowing both to reserve the final ticket.

TicketFlow treats inventory allocation as a **transactional correctness problem**, not a frontend validation problem. Redis, queues, and caches may improve responsiveness, but PostgreSQL remains the authoritative source of booking inventory.

### Example scenario

| Input | Value |
| --- | ---: |
| Event capacity | 100 tickets |
| Simulated contenders | 1,000 virtual users |
| Tickets requested per contender | 1 |
| Maximum legitimate allocations | 100 |
| Expected oversells | 0 |
| Possible valid outcomes | Confirmed, temporarily reserved, sold out, expired, cancelled, or rejected |

The system must never issue more than 100 valid allocations for this event, regardless of how many attempts are made.

---

## System invariants

The following are **non-negotiable correctness rules**:

1. `confirmed + active_reservations <= capacity` for each ticket inventory pool.
2. A reservation may be confirmed at most once.
3. A reservation that has expired or been cancelled cannot be confirmed without a new allocation.
4. Repeating an operation with the same idempotency key and equivalent request must not create another reservation or confirmation.
5. Reusing an idempotency key with a different request payload must be rejected.
6. Reservation creation, inventory allocation, and durable event recording must commit atomically where required.
7. Expiration, confirmation, and cancellation must compete through controlled state transitions so inventory is released at most once.
8. Background jobs may execute more than once; their handlers must remain safe under duplicate delivery.
9. A client-visible success must correspond to committed durable state.
10. Cached availability is advisory; database-enforced allocation is authoritative.

**Important distinction:** An active reservation is inventory already held, not inventory available to other buyers.

---

## Technology stack

| Layer | Proposed technology | Purpose |
| --- | --- | --- |
| Web frontend | Next.js, React, TypeScript | Event discovery, booking flow, status screens |
| UI | Tailwind CSS | Responsive interface |
| Backend | Node.js, Express, TypeScript | HTTP APIs and domain services |
| Database | PostgreSQL | Transactions, constraints, durable inventory |
| Database access | `pg` or a thin query layer | Explicit transactional SQL and lock control |
| Cache and coordination | Redis | Rate-limit state, short-lived read caching, queue backing |
| Background jobs | BullMQ | Notification and reconciliation workloads |
| Load testing | k6 | Reproducible concurrent traffic |
| Containerization | Docker, Docker Compose | Consistent local services |
| Telemetry | OpenTelemetry | Trace and metric instrumentation |
| Metrics | Prometheus | Time-series metrics collection |
| Dashboards | Grafana | Reliability and performance dashboards |
| Error monitoring | Sentry | Exception reporting and diagnostics |
| CI | GitHub Actions | Linting, tests, builds, security checks |

The architecture intentionally uses familiar TypeScript and SQL rather than introducing an ORM as a prerequisite. Database operations that require locking should be explicit and reviewable.

---

## Architecture

```mermaid
flowchart TB
    Client[Browser / Next.js] --> API[Express API]
    API --> Auth[Authentication and rate limiting]
    Auth --> Booking[Booking service]
    Booking --> DB[(PostgreSQL: source of truth)]
    API --> Cache[(Redis: cache and limits)]
    DB --> Outbox[(Transactional outbox table)]
    Publisher[Outbox publisher] --> Outbox
    Publisher --> Queue[BullMQ / Redis]
    Queue --> Worker[Notification and recovery workers]
    Worker --> DB
    API --> OTel[OpenTelemetry]
    Worker --> OTel
    OTel --> Metrics[Prometheus / Grafana]
    API --> Errors[Sentry]
    Worker --> Errors
    Test[k6 load tests] --> API
```

### Component responsibilities

**Frontend:** Presents event information, requests reservations, shows expiration countdowns, handles retries, and retrieves authoritative booking status.

**API:** Validates inputs, authenticates users, applies admission controls, manages idempotency, and invokes domain services.

**Booking service:** Owns transactional allocation, state transitions, inventory rules, and durable booking results.

**PostgreSQL:** Holds event capacity, reservation state, confirmed orders, idempotency records, and outbox events. It is the final authority for inventory.

**Redis:** Supports optional cached availability, request throttling, and BullMQ. Losing Redis must not cause overselling.

**Workers:** Deliver notifications, publish outbox events, and run reconciliation tasks. They do not bypass inventory constraints.

**Observability:** Captures latency, contention, queue delays, database errors, inventory anomalies, and operational failures.

---

## Core domain model

The following is a proposed logical schema. Actual migrations should encode constraints, indexes, foreign keys, and state transition rules explicitly.

### `events`

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID | Event identifier |
| `title` | TEXT | Public event name |
| `starts_at` | TIMESTAMPTZ | Event start time |
| `status` | TEXT | Draft, published, closed, cancelled |
| `created_at` | TIMESTAMPTZ | Creation time |

### `ticket_pools`

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID | Inventory pool identifier |
| `event_id` | UUID | Parent event |
| `capacity` | INTEGER | Total sellable units |
| `reserved_count` | INTEGER | Active inventory holds |
| `confirmed_count` | INTEGER | Finalized allocations |
| `version` | BIGINT | Optional optimistic concurrency token |

Recommended database checks:

```sql
CHECK (capacity >= 0),
CHECK (reserved_count >= 0),
CHECK (confirmed_count >= 0),
CHECK (reserved_count + confirmed_count <= capacity)
```

These checks prevent invalid counters but are not a replacement for correct transaction logic.

### `reservations`

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID | Reservation identifier |
| `user_id` | UUID | Requesting user |
| `ticket_pool_id` | UUID | Inventory pool |
| `quantity` | INTEGER | Number of held tickets |
| `status` | TEXT | Pending, confirmed, expired, cancelled |
| `expires_at` | TIMESTAMPTZ | Reservation deadline |
| `created_at` | TIMESTAMPTZ | Creation time |
| `updated_at` | TIMESTAMPTZ | Last transition |

Use a database check requiring `quantity > 0` and indexes on `(ticket_pool_id, status)` and `(status, expires_at)` as justified by query plans.

### `orders`

Records a successful simulated checkout. Use a unique constraint on `reservation_id` so one reservation cannot produce multiple orders.

### `idempotency_keys`

| Column | Type | Description |
| --- | --- | --- |
| `id` | UUID | Record identifier |
| `actor_id` | UUID | Owner of the operation |
| `operation` | TEXT | API operation scope |
| `key` | TEXT | Client-supplied idempotency key |
| `request_hash` | TEXT | Canonical request fingerprint |
| `status` | TEXT | In progress, completed |
| `response_status` | INTEGER | Stored HTTP response code |
| `response_body` | JSONB | Replayable result |
| `created_at` | TIMESTAMPTZ | Creation time |

Enforce uniqueness on `(actor_id, operation, key)`. Design retention periods carefully; deleting old keys permits a formerly seen request to be treated as new.

### `outbox_events`

Contains durable domain events committed in the same transaction as the related state change: `id`, `aggregate_id`, `event_type`, `payload`, `created_at`, `published_at`, and delivery metadata.

### `audit_logs`

Append-only records of important transitions and operator actions, with trace/correlation IDs. Do not log credentials, raw tokens, or sensitive user details.

---

## Reservation lifecycle

```mermaid
stateDiagram-v2
    [*] --> Pending: Atomic inventory hold
    Pending --> Confirmed: Simulated checkout succeeds
    Pending --> Expired: Deadline reached
    Pending --> Cancelled: User cancels
    Confirmed --> [*]
    Expired --> [*]
    Cancelled --> [*]
```

### Reservation creation

1. Authenticate and validate the request.
2. Resolve and lock the idempotency record for this operation.
3. Begin a PostgreSQL transaction.
4. Atomically allocate inventory if enough units remain.
5. Create a pending reservation with a server-generated expiration time.
6. Write the corresponding outbox event in the same transaction.
7. Persist the idempotent response and commit.
8. Return the reservation identifier, authoritative state, and expiration timestamp.

If the allocation fails because capacity is exhausted, return a clear sold-out result rather than silently retrying indefinitely.

### Confirmation

Confirmation is a **simulated checkout**. Within one transaction, lock the reservation, validate its state and expiration against the database clock, transition it to confirmed, decrement `reserved_count`, increment `confirmed_count`, create one order, and record an outbox event. The transaction must be all-or-nothing.

### Cancellation and expiration

Cancellation or expiration must acquire the same reservation-level synchronization as confirmation. Only a successful transition from `pending` releases inventory. Repeated jobs must have no additional effect.

---

## Concurrency control

### Preferred initial strategy: atomic conditional update

A single conditional statement provides a database-enforced inventory gate:

```sql
UPDATE ticket_pools
SET reserved_count = reserved_count + $1,
    version = version + 1
WHERE id = $2
  AND capacity - reserved_count - confirmed_count >= $1
RETURNING id, capacity, reserved_count, confirmed_count;
```

If no row is returned, the allocation is not available. The update and reservation insertion must run inside **the same database transaction**. On rollback, both the counter change and the reservation creation must roll back.

This statement serializes conflicting updates to the same inventory row through PostgreSQL row locking. For a very hot event, that row may become a contention bottleneck; this is a tradeoff to measure, not hide.

### Alternative strategies to evaluate

- `SELECT ... FOR UPDATE` for explicit pessimistic locking.
- Optimistic concurrency with version checks and bounded retries.
- Partitioning inventory into independent pools when the domain allows it.
- Queue-based admission control to smooth extreme spikes, while retaining database correctness.

**Never use a Redis lock as the only protection against overselling.** Redis locks may help coordinate work but should not replace database constraints and atomic state transitions.

### Lock-order policy

Establish and document a consistent lock order across idempotency records, reservations, and inventory rows. Measure deadlocks and retry only known transient transaction failures with bounded backoff.

---

## Idempotency and retries

Networks fail in ambiguous ways. A client may time out after the server has successfully committed a reservation. Blindly retrying without idempotency could allocate additional tickets.

Example request:

```http
POST /api/v1/reservations
Authorization: Bearer <access-token>
Idempotency-Key: 8eac9d32-5e6a-45be-8a78-02d733aab987
Content-Type: application/json

{
  "ticketPoolId": "d3e81dd7-7722-4e4e-bde8-7fbdc7439e11",
  "quantity": 1
}
```

Expected behavior:

- First valid request: execute once and store the committed result.
- Same key, same actor, same operation, same canonical payload: return the stored result.
- Same key with a different payload: return `409 Conflict`.
- Concurrent duplicate requests: coordinate using a unique constraint and transactional locking; never perform the operation twice.
- In-progress request: wait for completion within a bounded period or return a documented retryable response.

Idempotency must be enforced on the server and scoped to an authenticated principal. A frontend button disabling itself is not sufficient.

---

## Expiration and recovery

Reservations use a server-controlled time-to-live (TTL), such as **5 minutes** for the initial experiment. This is a configurable design choice, not a universal production recommendation.

### Expiration process

1. A periodic worker selects due reservations in manageable batches.
2. Workers use `FOR UPDATE SKIP LOCKED` or an equivalent safe claiming strategy.
3. Each reservation is rechecked under lock.
4. Pending, expired reservations transition to `expired`.
5. Inventory is released exactly once inside the same transaction.
6. A durable outbox event is recorded.

The database clock is authoritative. The UI countdown is only a convenience and cannot authorize a late confirmation.

### Recovery guarantees

- A stopped worker must not permanently strand inventory.
- Restarting a worker must not release inventory twice.
- A delayed expiration job must not undo a confirmed reservation.
- A periodic reconciliation process must detect counter drift.
- Reconciliation must alert on inconsistencies and repair only through a carefully defined, auditable procedure.

A reservation may remain physically marked `pending` briefly after its deadline if workers are delayed. Confirmation must still reject it once the deadline has passed. Availability can remain temporarily conservative until the worker releases the hold.

---

## Asynchronous jobs and transactional outbox

Use BullMQ for work that can occur after a booking transaction commits, such as:

- Confirmation notifications.
- Reservation-expiry notifications.
- Audit enrichment.
- Reporting projections.
- Reconciliation and scheduled maintenance.

### Why an outbox?

A direct sequence such as “commit booking, then publish to Redis” has a failure gap. If the process crashes after the database commit but before publishing, the event can be lost.

The transactional outbox closes this gap by storing the domain event in PostgreSQL in the same transaction as the booking. A separate publisher reads committed outbox rows and sends them to BullMQ.

### Delivery semantics

Outbox publication and BullMQ processing should be treated as **at least once**. Duplicates are possible, so workers must be idempotent, typically using unique event IDs and durable consumer deduplication records.

Retries should use bounded exponential backoff and jitter. Permanently failing jobs should be visible in a failed-job workflow or dead-letter mechanism, with operator procedures for replay.

Do not claim exactly-once distributed delivery.

---

## API design

Proposed base path: `/api/v1`.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/health/live` | Process liveness |
| `GET` | `/health/ready` | Dependency readiness |
| `GET` | `/api/v1/events` | List published events |
| `GET` | `/api/v1/events/:id` | Get event details |
| `GET` | `/api/v1/events/:id/availability` | Read advisory inventory availability |
| `POST` | `/api/v1/reservations` | Atomically reserve inventory |
| `GET` | `/api/v1/reservations/:id` | Retrieve authoritative reservation status |
| `POST` | `/api/v1/reservations/:id/confirm` | Simulate checkout confirmation |
| `POST` | `/api/v1/reservations/:id/cancel` | Cancel an active reservation |
| `GET` | `/api/v1/orders/:id` | Retrieve confirmed simulated order |

All mutation endpoints should define authentication, authorization, idempotency behavior, request validation, error schemas, and response examples in an OpenAPI document.

### Example reservation response

```json
{
  "data": {
    "id": "6dc1516d-f6c8-42ac-a12b-249af9a6b7c3",
    "ticketPoolId": "d3e81dd7-7722-4e4e-bde8-7fbdc7439e11",
    "quantity": 1,
    "status": "pending",
    "expiresAt": "2026-10-27T14:10:00Z"
  },
  "requestId": "req_01"
}
```

The timestamp and identifiers above are **illustrative examples**, not live application data.

### Error format

```json
{
  "error": {
    "code": "TICKETS_SOLD_OUT",
    "message": "There are not enough tickets available.",
    "retryable": false
  },
  "requestId": "req_02"
}
```

Recommended HTTP semantics:

- `400` for malformed requests.
- `401` for missing or invalid authentication.
- `403` for forbidden operations.
- `404` for missing or inaccessible resources.
- `409` for conflicting state transitions or idempotency-key payload mismatches.
- `422` for validly structured but invalid domain inputs.
- `429` for rate limiting, optionally with `Retry-After`.
- `503` for temporary dependency unavailability.

A sold-out response may use `409` with a stable machine-readable domain code. Document this consistently.

---

## Frontend experience

The frontend should demonstrate reliability concepts visibly, not merely expose API endpoints.

### Core screens

1. **Event catalogue:** Discover available events.
2. **Event details:** View ticket pools, prices if simulated, and advisory availability.
3. **Reservation checkout:** Submit an idempotent reservation request.
4. **Reservation countdown:** Display server-provided expiration time.
5. **Booking status:** Refresh authoritative status after network failures.
6. **Sold-out experience:** Show meaningful, accessible feedback.
7. **Engineering dashboard:** Visualize contention, successful holds, expired holds, and failures.

### Frontend reliability requirements

- Preserve an idempotency key across retries of the same intended action.
- Avoid creating a new booking attempt automatically after an ambiguous timeout.
- Reconcile state with the server after reconnecting.
- Make loading, error, pending, expired, and confirmed states explicit.
- Provide keyboard-accessible controls and status announcements.
- Prevent misleading countdown-based confirmation after server-side expiration.
- Handle HTTP `429`, `409`, and `503` intentionally.

---

## Security and abuse prevention

Security is part of reliability because malicious or accidental traffic can exhaust limited inventory and service capacity.

Planned controls include:

- Authentication and ownership checks for reservations and orders.
- Strict request schemas and server-side quantity limits.
- Parameterized SQL queries.
- Per-account and per-IP rate limits with sensible exemptions and safeguards.
- Configurable reservation caps per user and event.
- Short reservation TTLs and abuse detection.
- CORS allowlists, secure headers, and appropriately scoped credentials.
- Secrets supplied through environment variables or a secrets manager.
- Structured logging with sensitive fields redacted.
- Dependency scanning and CI security checks.
- Separate, least-privilege database credentials for API and workers where feasible.
- Administrative endpoints protected by strong authorization.

Rate limiting should be considered an admission-control layer, **not** the source of inventory correctness.

**Status (Phase 7):** the controls above are implemented and were reviewed code-by-code in
[`docs/security/audit.md`](docs/security/audit.md) — helmet/CORS/body-limit (`middleware/security.ts`),
scrypt hashing + HMAC tokens (`modules/auth/credentials.ts`), hashed-at-rest DB sessions with atomic
rotation (`modules/auth/sessions.ts`), per-user idempotency scoping and reservation ownership checks
(`modules/reservations/service.ts`), the double-locked lab gate (`middleware/lab-gate.ts`), and fail-closed
writes in the rate limiter. The audit found and fixed one real defect (a login timing side-channel that
enabled username enumeration) and records the remaining production-hardening items.

---

## Observability

The system should be diagnosable during a load test without relying on guesswork.

### Metrics

| Metric | Type | Purpose |
| --- | --- | --- |
| `http_requests_total` | Counter | Request volume by route and outcome |
| `http_request_duration_seconds` | Histogram | Latency distribution |
| `reservation_attempts_total` | Counter | Reservation attempts by result |
| `reservation_confirmations_total` | Counter | Successful confirmations |
| `reservation_expirations_total` | Counter | Expired holds |
| `inventory_invariant_violations_total` | Counter | Detected correctness anomalies |
| `booking_transaction_retries_total` | Counter | Database transaction retries |
| `booking_deadlocks_total` | Counter | Detected deadlocks |
| `outbox_pending_events` | Gauge | Events awaiting publication |
| `outbox_oldest_pending_age_seconds` | Gauge | Publication lag |
| `queue_jobs_waiting` | Gauge | Worker backlog |
| `queue_jobs_failed_total` | Counter | Failed background jobs |

Use low-cardinality labels such as route templates and outcome codes. Do not use user IDs, reservation IDs, or raw event IDs as Prometheus labels.

### Distributed tracing

Use OpenTelemetry spans to connect HTTP requests, database transactions, outbox publication, and background job processing. Propagate trace context across queue boundaries when supported.

### Structured logs

Include timestamp, level, service, request ID, trace ID, operation, result, and error code. Exclude access tokens, passwords, and unnecessary personal data.

### Suggested Grafana dashboards

- API traffic, p50/p95/p99 latency, and error rates.
- Reservation success, rejection, and expiration rates.
- PostgreSQL transaction duration, lock waits, and deadlocks.
- Redis availability and queue depth.
- Outbox backlog and oldest unpublished event age.
- Inventory correctness and reconciliation findings.

### Sentry

Capture unexpected application exceptions with release and environment context. Configure data scrubbing, sampling, and alert routing. Sentry complements metrics and traces; it does not replace them.

---

## Testing strategy

### Unit tests

Test state transition rules, request validation, idempotency fingerprints, expiration logic, and error mapping.

### Integration tests

Use a real PostgreSQL test instance for transaction and locking behavior. Mock-only tests cannot prove concurrency safety.

Key cases:

- Allocate one remaining ticket from many competing requests.
- Roll back inventory when reservation insertion fails.
- Retry the same idempotency key after a simulated lost response.
- Reject a changed payload under an existing key.
- Confirm and expire the same reservation concurrently.
- Cancel and expire the same reservation concurrently.
- Process the same outbox event more than once.
- Restart workers after partially completed processing.
- Reject confirmation after server-side expiration.
- Verify foreign keys, uniqueness, and inventory check constraints.

### End-to-end tests

Test booking flows in the browser, including slow responses, reconnects, accessibility, and sold-out messaging.

### Property-based and invariant tests

Generate randomized sequences of reservations, confirmations, cancellations, retries, and expirations. After each test run, verify:

```text
reserved_count >= 0
confirmed_count >= 0
reserved_count + confirmed_count <= capacity
confirmed orders are unique per reservation
inventory counters agree with durable reservation state
```

### Fault-injection tests

Deliberately terminate API processes, restart workers, interrupt Redis, inject database timeouts, and delay queue delivery. Validate recovery and correctness.

---

## Load-testing scenarios

Use k6 to generate reproducible traffic and report both **performance** and **correctness**. A fast system that oversells is a failed system.

| Scenario | Workload | Main assertion |
| --- | --- | --- |
| Baseline | 1–10 virtual users | Correct functional behavior |
| Moderate load | 100 contenders | Stable response and allocation |
| Flash sale | 1,000 contenders, 100 tickets | No more than 100 valid allocations |
| Retry storm | Duplicate keys and timeouts | No duplicate reservations |
| Hot inventory row | Many requests to one pool | Correctness under lock contention |
| Expiration race | Confirm near TTL boundary | Exactly one valid terminal outcome |
| Worker outage | Pause workers and restart | Eventual recovery, no double release |
| Redis outage | Disable Redis during traffic | Safe degradation, no overselling |
| Database pressure | Increased latency or limited connections | Bounded failures and recovery |
| Soak test | Sustained traffic | No uncontrolled resource growth |

### Example k6 script

Save as `tests/load/flash-sale.js` after implementing the corresponding endpoint and authentication strategy:

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { uuidv4 } from 'https://jslib.k6.io/k6-utils/1.4.0/index.js';

export const options = {
  scenarios: {
    flash_sale: {
      executor: 'per-vu-iterations',
      vus: 1000,
      iterations: 1,
      maxDuration: '2m',
    },
  },
};

const baseUrl = __ENV.API_BASE_URL || 'http://localhost:4000';
const poolId = __ENV.TICKET_POOL_ID;
const token = __ENV.TEST_ACCESS_TOKEN;

export default function () {
  if (!poolId || !token) {
    throw new Error('Set TICKET_POOL_ID and TEST_ACCESS_TOKEN');
  }

  const response = http.post(
    `${baseUrl}/api/v1/reservations`,
    JSON.stringify({ ticketPoolId: poolId, quantity: 1 }),
    {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Idempotency-Key': uuidv4(),
      },
    }
  );

  check(response, {
    'expected booking outcome': (r) => [201, 409, 429, 503].includes(r.status),
  });
}
```

**Test caveats:** This is an illustrative starter script, not a finished benchmark harness. For meaningful contention, provision test users and authentication so per-user limits do not unintentionally dominate the test. Pre-create an event with exactly 100 tickets, reset the database between runs, synchronize the test start, and verify results with authoritative SQL queries. k6 virtual users are not necessarily simultaneous arrivals; report the achieved arrival pattern. The expected response-code set must be adjusted to match the implemented API contract.

### Authoritative post-test checks

```sql
SELECT id, capacity, reserved_count, confirmed_count,
       reserved_count + confirmed_count AS allocated
FROM ticket_pools
WHERE id = $1;
```

```sql
SELECT status, COALESCE(SUM(quantity), 0) AS tickets
FROM reservations
WHERE ticket_pool_id = $1
GROUP BY status;
```

Check that counters agree with reservation records and that the total allocated never exceeds capacity. Run the verification after background expiration has settled, or account for still-pending reservations explicitly.

---

## Performance reporting

**No performance results are claimed until reproducible tests have been executed.**

Record the environment, machine resources, database settings, test duration, actual request rate, response-code distribution, and invariant-check results alongside each benchmark.

| Metric | Target / acceptance criterion | Measured result |
| --- | --- | --- |
| Oversold tickets | **0** | Not measured |
| Duplicate confirmations | **0** | Not measured |
| Inventory invariant violations | **0** | Not measured |
| Flash-sale contenders | 1,000 | Not measured |
| Available inventory | 100 tickets | Not measured |
| HTTP p95 latency | Establish after baseline | Not measured |
| HTTP p99 latency | Establish after baseline | Not measured |
| Error rate | Define by expected vs unexpected outcomes | Not measured |
| Deadlock rate | Measure and investigate | Not measured |
| Outbox publication lag | Define operational SLO | Not measured |
| Expiration release delay | Define operational SLO | Not measured |

Do not count legitimate sold-out responses as unexpected application failures. Report them separately from timeouts, 5xx errors, and data-integrity violations.

Benchmark artifacts should include raw k6 output, environment configuration, database validation queries, and dashboard screenshots.

---

## Repository structure

Proposed monorepo layout:

```text
ticketflow-reliability-lab/
├── apps/
│   ├── web/                     # Next.js frontend
│   ├── api/                     # Express API
│   └── worker/                  # BullMQ workers and outbox publisher
├── packages/
│   ├── contracts/               # Shared API schemas and types
│   ├── config/                  # Shared configuration
│   └── observability/           # Telemetry helpers
├── database/
│   ├── migrations/
│   ├── seeds/
│   └── queries/
├── infrastructure/
│   ├── docker/
│   ├── prometheus/
│   └── grafana/
├── tests/
│   ├── integration/
│   ├── e2e/
│   ├── concurrency/
│   ├── fault-injection/
│   └── load/
├── docs/
│   ├── architecture/
│   ├── adr/
│   ├── api/
│   ├── runbooks/
│   └── benchmarks/
├── .github/
│   └── workflows/
├── .env.example
├── compose.yaml
├── package.json
└── README.md
```

This tree describes the intended structure; directories and scripts should be created during implementation.

---

## Local development

### Prerequisites

- Node.js LTS version selected and pinned by the repository.
- npm or another explicitly configured package manager.
- Docker Engine and Docker Compose.
- Git.
- k6 for load testing.

### Verified startup workflow

Every command below was run against a **fresh database** for this project and produced the results in
[Reproduce the flagship experiment](#reproduce-the-flagship-experiment-1000-buyers-vs-100-tickets) —
there are no hidden manual steps.

```bash
git clone <your-remote>/ticketflow.git && cd ticketflow

cp .env.example .env            # local dev defaults; edit the DB port note below if needed
npm install                     # npm workspaces (ADR-0008)

npm run db:up                   # docker compose up -d postgres redis
npm run migrate                 # applies migrations 1..9 to a fresh database
npm run seed -- --experiment    # catalog + the 1,000-vs-100 flagship fixture (one 100-seat tier)

npm run build                   # compiles apps/api/dist/server.js (used by boot:smoke and the bench)
npm run boot:smoke              # boots the COMPILED artifact over HTTP, asserts graceful shutdown
```

> **Windows / port 5432 caveat (real, not hypothetical).** A native PostgreSQL service frequently owns
> `127.0.0.1:5432`. When it does, set `POSTGRES_PORT=5433` so Docker publishes the container on `:5433`
> and point `DATABASE_URL` / `TF_TEST_DATABASE_URL` at `:5433`. This repository's working `.env` already
> runs the compose database on host port `5433` for exactly that reason — **do not assume `:5432`.**

To run the full local stack (API + worker + Postgres + Redis) instead of driving the compiled artifact
by hand: `npm run compose:up`. Bring up the observability stack separately (it sits behind a compose
profile): `docker compose --profile monitoring up -d`.

### Development endpoints

| Service | URL | Notes |
| --- | --- | --- |
| Web (Next.js) | `http://localhost:3000` | `npm run dev:web` |
| API | `http://localhost:4000` | `npm run dev:api` (watch) or the compiled artifact |
| API readiness | `http://127.0.0.1:4000/health/ready` | live DB + cache check; the benchmark refuses to run if this is not `200` |
| Worker metrics | `http://127.0.0.1:9464/metrics` | separate `prom-client` registry (ADR-0001); Prometheus scrapes it as its own target |
| Prometheus | `http://localhost:9090` | `--profile monitoring` only |
| Grafana | `http://localhost:3001` | `--profile monitoring`; local admin bootstrap `admin` / `admin_local_only` |

### npm scripts (as defined in the root `package.json`)

```bash
npm run build            # build all workspaces
npm run typecheck        # strict TS across workspaces
npm run lint             # eslint .
npm run test             # unit then integration
npm run test:unit
npm run test:integration # real PostgreSQL service
npm run test:e2e         # Playwright against the running web+api
npm run db:up            # compose up -d postgres redis
npm run db:down
npm run compose:up       # full stack, --build
npm run migrate          # up
npm run migrate:down     -- 9
npm run seed             [-- --experiment | -- --reset]
npm run boot:smoke       # boot compiled artifact, assert HTTP + graceful shutdown
npm run invariants       # -- --quiescent SQL invariant views
npm run bench            # HTTP benchmark harness (Phase 6/7)
npm run verify           # the whole documented gate in one command
npm run clean
```

`npm run dev` does not exist as a single aggregate command — start `dev:api`, `dev:worker` and `dev:web`
in separate terminals (or use `compose:up`).

### Reproduce the flagship experiment (1,000 buyers vs 100 tickets)

This is the Phase 7 gate, executed. It needs the app's own dependencies plus a running API; nothing else.

```bash
# 0. Precondition: stack up + migrated + seeded exactly as in the startup workflow above.
#    `seed --experiment` created event slug `lab-flagship-1000-vs-100` with one `Single Seat` tier of
#    capacity 100. Confirm the fresh database is already correct:
npm run invariants -- --quiescent

# 1. Start the API the experiment will drive. Raise the rate limiter so the run measures reservation
#    contention, not the 429 limiter (see the harness's own note). On PowerShell use `$env:` form.
RATE_LIMIT_MAX=100000 node apps/api/dist/server.js        # bash;  ->  http://127.0.0.1:4000

# 2. Reproduce: 1,000 buyers, 100 concurrent, one ticket each, simulated success. The harness resolves
#    the target by EVENT SLUG (stable and readable), measures start capacity from the live API, and
#    exits non-zero ONLY on an actual oversell.
npm run bench -- --event-slug lab-flagship-1000-vs-100 --users 1000 --concurrency 100 --quantity 1 --outcome success --label flagship

# 3. Re-assert invariants over the post-burst data.
npm run invariants -- --quiescent
```

**Measured result (clean host, run against a fresh `seed --experiment` database).** `100` buyers got a
reservation and confirmed, the other `900` were correctly rejected `sold_out`, and **no seat was
oversold**:

```json
{
  "startAvailable": 100,
  "reserveOps": 1000,
  "confirmed": 100,
  "outcomeTally": { "reserve:reserved": 100, "checkout:confirmed": 100, "reserve:sold_out": 900 },
  "oversellViolation": false
}
```

The database agrees (measured directly):

```sql
SELECT capacity, available, reserved, sold FROM inventory WHERE tier_id = (…Single Seat…);
-- 100 | 0 | 0 | 100          SELECT count(*) FROM bookings;  --> 100
-- npm run invariants -- --quiescent  ->  all 6 invariant views PASS
```

Raw artifact: [`docs/experiments/artifacts/repro7-flagship-1000-vs-100.json`](docs/experiments/artifacts/repro7-flagship-1000-vs-100.json).

**Measured result (loaded host — the fail-safe, not a defect).** On a busy machine the same command
competes for CPU and the PostgreSQL pool's 5-second acquisition timeout (`PG_CONNECTION_TIMEOUT_MS=5000`)
returns HTTP 500 for some requests instead of waiting. That is the *correct* behaviour: it degrades to a
retryable error rather than overselling. A measured loaded run confirmed only `56` of 100 seats, produced
`95` reserve + `44` checkout `500`s, and **still** reported `oversellViolation: false` with all six
invariant views passing. Artifact:
[`repro7-flagship-slug-under-host-load.json`](docs/experiments/artifacts/repro7-flagship-slug-under-host-load.json).
So the reproducible *guarantee* is "confirmed ≤ 100 and no invariant broken", which holds on every run;
raw latency/throughput depends on how quiet the machine is.

---

## Environment configuration

The authoritative list is [`.env.example`](.env.example) — copy it to `.env`. It is validated once at
process start by `packages/config` (Zod); an unknown/invalid value is a hard startup failure, not a
silent default. Key variables (all local-dev defaults, never production credentials):

```dotenv
NODE_ENV=local
PORT=4000
# A native Postgres on :5432 is common on Windows; publish compose on :5433 and match DATABASE_URL.
POSTGRES_PORT=5433
DATABASE_URL=postgresql://ticketflow:ticketflow_local_only@localhost:5433/ticketflow
TF_TEST_DATABASE_URL=postgresql://ticketflow:ticketflow_local_only@localhost:5433/ticketflow
REDIS_URL=redis://localhost:6379

PG_POOL_MAX=20
PG_CONNECTION_TIMEOUT_MS=5000      # the knob that produces the fail-safe 500 under saturation
STATEMENT_TIMEOUT_MS=5000
LOCK_TIMEOUT_MS=2000               # fast-fail (55P03) instead of piling up behind a row lock

AUTH_SECRET=                       # >=32 chars; generate: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SECURE_COOKIES=false
RESERVATION_TTL_SECONDS=300
MAX_QUANTITY_PER_RESERVATION=10
RATE_LIMIT_MAX=120                 # raise (e.g. 100000) when benchmarking reservation contention

LAB_ENABLED=false                  # the Engineering Lab is off unless explicitly enabled in local/test/ci
METRICS_ENABLED=true
GIT_SHA=                           # set in CI to attribute experiment runs to a commit
```

**Security:** These are example local values. `NODE_ENV=production` **refuses to start** if `AUTH_SECRET`
/ `DATABASE_URL` still contain a committed local default, or if `LAB_ENABLED=true` (see
`packages/config/src/index.ts`). Never commit real credentials; supply production secrets out of band.

---

## Deployment considerations

A production-like deployment should include:

1. Separate API, frontend, worker, PostgreSQL, and Redis services.
2. TLS termination and trusted reverse-proxy configuration.
3. Health checks, readiness probes, and graceful shutdown.
4. Database migration controls and tested rollback procedures.
5. Connection pool sizing and database capacity planning.
6. Redis persistence/availability decisions appropriate for queued work.
7. Worker concurrency and backpressure limits.
8. Automated backups and periodic restore drills.
9. Centralized logs, metrics, traces, and error monitoring.
10. Resource limits, autoscaling policies, and cost monitoring.
11. Restricted administrative access and secrets management.
12. CI/CD gates for migrations, tests, builds, and deployment.

### CI/CD quality gates

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push to `main` and every pull
request, against real PostgreSQL 18 and Redis service containers. The chain is exactly the local
`npm run verify` gate plus the executed flagship experiment:

```text
install → build → typecheck (strict) → lint → unit tests
    ↓
migrate on a fresh database → seed (--experiment) → integration tests (real PostgreSQL)
    ↓
invariant views (--quiescent)
    ↓
boot smoke (the COMPILED artifact over HTTP + graceful shutdown)
    ↓
migration rollback smoke (down 9, up again)
    ↓
flagship experiment: 1,000 buyers vs 100 tickets over HTTP — asserts NO oversell, then re-checks invariants
    ↓
dependency audit (report only until the advisory baseline is triaged)
```

The flagship step exits the build **red only on an actual oversell**; transient 5xx from runner CPU
contention are the documented fail-safe path and do not turn the gate red (the no-oversell assertion is
what matters). `GIT_SHA` is exported to the job so every recorded experiment run is attributable to the
commit under test.

Load tests must run against controlled environments with explicit authorization, not against third-party
production services.

---

## Failure injection

TicketFlow is a lab, so failure demonstrations are first-class deliverables.

| Failure | Injection method | Expected behavior |
| --- | --- | --- |
| Duplicate submit | Replay identical idempotency key | One durable reservation |
| Lost HTTP response | Drop response after commit | Retry retrieves original result |
| API crash | Terminate API mid-operation | Commit or rollback, never partial inventory |
| Redis outage | Stop Redis temporarily | Safe degraded behavior; no overselling |
| Worker crash | Kill worker during job | Safe retry, no duplicate side effects |
| Delayed expiry | Pause expiry worker | Late confirmation rejected; eventual release |
| Database contention | Saturate one ticket pool | Correctness preserved; latency measured |
| Outbox delay | Stop publisher | Durable backlog, eventual delivery |
| Duplicate event | Redeliver outbox event | Idempotent consumer effect |

Each experiment should document setup, expected behavior, actual outcome, logs/traces, invariant checks, and lessons learned.

---

## Engineering decisions and tradeoffs

Document architecture decisions as ADRs under `docs/adr/`.

### ADR-001: PostgreSQL as inventory source of truth

**Decision:** Enforce booking correctness in PostgreSQL transactions.

**Rationale:** A durable transactional database can atomically couple inventory allocation with reservation creation and constraints.

**Tradeoff:** Hot rows may cause lock contention under intense demand.

### ADR-002: Redis for acceleration, not correctness

**Decision:** Use Redis for caching, throttling, and queue infrastructure, not authoritative ticket counts.

**Rationale:** A cache outage or stale value must not create oversells.

**Tradeoff:** Database traffic remains necessary for authoritative allocation.

### ADR-003: Transactional outbox for post-commit events

**Decision:** Persist booking events with booking state and publish asynchronously.

**Rationale:** Prevent events from disappearing in the database-commit-to-queue failure window.

**Tradeoff:** Requires polling/publishing infrastructure, deduplication, and backlog monitoring.

### ADR-004: Explicit SQL for critical transactions

**Decision:** Use transparent, reviewed SQL for locking and allocation paths.

**Rationale:** Makes concurrency behavior easier to reason about and test.

**Tradeoff:** Requires careful query maintenance and schema discipline.

### ADR-005: Correctness before throughput optimization

**Decision:** Establish invariant-based tests before tuning latency and throughput.

**Rationale:** Higher throughput is not useful if inventory correctness fails.

**Tradeoff:** Some performance optimizations may be deferred until measurements justify them.

---

## Roadmap

### Phase 1: Foundation

- [ ] Initialize monorepo, TypeScript configuration, linting, and CI.
- [ ] Configure PostgreSQL, Redis, and local Docker services.
- [ ] Implement migrations, constraints, indexes, and seed data.
- [ ] Add structured error handling and request IDs.
- [ ] Implement authentication and authorization.

### Phase 2: Correct booking engine

- [ ] Implement atomic inventory allocation.
- [ ] Implement reservations and state transitions.
- [ ] Implement idempotency persistence and response replay.
- [ ] Implement confirmation and cancellation.
- [ ] Add integration tests for contention and race conditions.

### Phase 3: Lifecycle and recovery

- [ ] Implement reservation expiration worker.
- [ ] Implement transactional outbox and publisher.
- [ ] Add BullMQ consumers with deduplication.
- [ ] Implement reconciliation and recovery runbooks.

### Phase 4: Frontend and developer experience

- [ ] Build event catalogue and details pages.
- [ ] Build reservation and simulated checkout flows.
- [ ] Add countdown, status recovery, and sold-out UX.
- [ ] Publish OpenAPI documentation.

### Phase 5: Observability

- [ ] Add OpenTelemetry instrumentation.
- [ ] Expose Prometheus metrics.
- [ ] Build Grafana dashboards.
- [ ] Configure Sentry and alerting.
- [ ] Add trace correlation across jobs.

### Phase 6: Load and failure testing

- [ ] Create repeatable k6 scenarios.
- [ ] Run 1,000-contender / 100-ticket experiment.
- [ ] Validate database invariants after every run.
- [ ] Inject failures and document recovery.
- [ ] Publish measured results and hardware configuration.

### Phase 7: Production hardening

- [ ] Configure deployment pipelines and staging.
- [ ] Add backups, restore drills, and security checks.
- [ ] Tune queries and database connections from measurements.
- [ ] Publish architecture decision records and operational runbooks.
- [ ] Record a public engineering demonstration of the results.

---

## Definition of done

TicketFlow is ready to be described as a **completed reliability lab** only when:

- The API, frontend, database, and workers run from documented setup instructions.
- A reproducible 1,000-contender / 100-ticket scenario has been executed.
- Authoritative database checks demonstrate **zero overselling**.
- Duplicate requests do not produce duplicate reservations or confirmations.
- Expiration, cancellation, and confirmation races are tested.
- Worker restarts and queue redelivery do not corrupt inventory.
- Metrics, logs, traces, and operational dashboards are accessible.
- CI runs meaningful correctness tests.
- Actual latency, error rates, throughput, and infrastructure details are published.
- Known limitations and unresolved tradeoffs are documented.

---

## Contributing

Contributions, bug reports, and technical discussions are welcome once the repository is publicly available.

Suggested contribution process:

1. Open an issue describing the problem or proposed improvement.
2. Discuss changes to inventory invariants or public API contracts before implementation.
3. Add or update tests, especially for concurrency-sensitive behavior.
4. Run linting, type checks, integration tests, and applicable load tests.
5. Submit a focused pull request with a clear rationale and verification evidence.

Do not submit benchmark claims without a reproducible test procedure and the environment used.

---

## License

**License: To be determined.** Add a `LICENSE` file and update this section before describing the repository as open source. Publicly visible source code is not automatically licensed for unrestricted reuse.

---

## Final perspective

TicketFlow Reliability Lab is built to demonstrate a core principle of production engineering:

> **A successful request is not enough. A trustworthy system must remain correct when requests overlap, clients retry, workers fail, and demand exceeds supply.**

The project's value lies in the engineering evidence: reproducible experiments, explicit invariants, observable failure modes, and documented tradeoffs.
