# Phase 0 — Discovery, Plan, and Execution Design

Status: design baseline for Phase 1+ implementation.
Repository at discovery time: a single file, `Ticketflow-Requirements-Prompt-Pack.md` (the
specification). No code, no git history, no tooling config. Therefore: scaffold from scratch,
preserving the spec file as the requirements source of truth.

## 1. Environment constraints measured (not assumed)

| Probe | Command | Actual result |
| --- | --- | --- |
| Node.js | `node --version` | `v26.1.0` |
| npm | `npm --version` | `11.6.2` |
| pnpm | `pnpm --version` | **not installed** (`CommandNotFoundException`) |
| Docker CLI | `docker --version` | `Docker version 29.4.0, build 9d7ad9f` |
| Docker daemon | `docker info --format "{{.ServerVersion}}"` | initially `failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine`; after starting Docker Desktop → `29.4.0` |
| git | `git --version` | `2.49.0.windows.1` |
| Registry reachability | `npm ping` | `PONG 1337ms` |
| Express current major | `npm view express version` | `5.3.0` |

Consequences recorded as decisions:

- **Package manager: npm workspaces.** pnpm is not installed on this machine and the spec permits
  either. Using npm keeps "clean clone boots with documented commands" true on the reference
  machine without a global install step. Documented in ADR-0008.
- **Docker Desktop must be running** for integration tests and compose. The test suite detects an
  unreachable daemon and reports `SKIP`/failure explicitly instead of pretending a pass.
- **Express 5** is the version `npm install express` resolves to today; the code base targets it
  deliberately (no legacy `res.send(status, body)`, no unnamed wildcard routes).

## 2. Goals and non-goals

Goals:

1. Reproducible demonstration: 1,000 competing buyers, 100 tickets, one unsafe baseline plus three
   correct allocation strategies, with **measured** differences.
2. PostgreSQL as the single authoritative inventory source; every correctness claim verifiable by
   independent SQL invariant queries.
3. A teaching artifact: readable SQL, explicit transactions, honest documentation of what is *not*
   guaranteed.

Non-goals (explicit):

- No real payments, cards, gateways, or customer data. Fake, deterministic payment provider only.
- No production-readiness claims. No multi-region, no seat maps, no fraud scoring.
- Not a framework showcase: no ORM, no NestJS, no Fastify.

## 3. Target architecture (containers)

```
Browser ──> web (Next.js, :3000) ──> api (Express, :4000) ──> PostgreSQL :5432   [authoritative]
                                          │                        ▲
                                          │                        │ migrations/worker SQL
                                          ├────────> Redis :6379   │
                                          │            │           │
                                          │        worker (BullMQ) ─┘  [outbox relay, expiry sweeper,
                                          │                             fake notifications, reconciliation]
                                          ├──> /metrics ──> Prometheus ──> Grafana
                                          └──> OTel collector (optional) ──> traces
k6 (load-tests/) ───────────────> api  (local/test only, lab endpoints gated by env)
```

Components inside `api`: route handler (thin, Zod-validated) → service (business rules, state
machine, strategy selection) → repository (parameterized SQL) → `pg.Pool`/`PoolClient`.

## 4. Consistency model summary

- Linearization point of a successful reservation: the commit of the single transaction that
  (a) conditionally updates `inventory` (`available -= q`, `reserved += q`, `version += 1`) and
  (b) inserts the `reservation` row and (c) writes the idempotency record and outbox event.
- Confirmation: one transaction moves `reserved → sold`, sets booking/payment state, inserts outbox.
- Expiry: `UPDATE ... SET available = available + q, reserved = reserved - q WHERE ...` guarded by a
  conditional status update (`WHERE status = 'PENDING' AND expires_at <= now()`) so exactly one of
  confirm-vs-expire wins. A late success after expiry never resurrects inventory: it is recorded as a
  `payment_attempts` row plus a `reconciliation_findings` row (documented policy: refund-path,
  no double-fulfilment).
- v1 limits one reservation to one tier, so multi-tier lock ordering is out of scope (recorded).
- Canceled/expired tickets **do** return to inventory (`available += q`, `reserved -= q`); tickets
  already `sold` (confirmed) do not.

Full detail: `docs/architecture/data-model.md`, ADR-0002, ADR-0003, ADR-0004, ADR-0007.

## 5. Strategy matrix to be implemented

| Id | Name | Mechanism | Expected failure mode under contention |
| --- | --- | --- | --- |
| `unsafe_lab` | Unsafe baseline (lab-only) | unlocked read → artificial delay → blind write | lost update / oversell attempt; if blocked by CHECK, classify as invariant-violation + failed insert |
| `atomic_update` | Safe A (default) | conditional `UPDATE ... WHERE available >= $q RETURNING` | none; sold-out shown as `409`/`200`-with-outcome |
| `pessimistic` | Safe B | `SELECT ... FOR UPDATE`, validate, write | lock wait time, lower throughput |
| `optimistic` | Safe C | version-checked conditional UPDATE + bounded jittered retry | retry amplification; conflicts ≠ sold out |

## 6. Phase plan and gates (each ends with real command output)

| Phase | Deliverable | Gate evidence |
| --- | --- | --- |
| 0 | This plan, ADRs, diagrams, schema, risk register | Invariants + state transitions documented |
| 1 | Monorepo, strict TS, Express app, `pg` pool + migration runner + migrations + seeds, env validation, Docker compose, Vitest/Supertest smoke, lint+typecheck, CI skeleton, `make verify` | Fresh install → typecheck + lint + unit tests + integration tests pass; `/health/live`, `/health/ready` respond; migrations apply to empty DB |
| 2 | Reservations (safe A), state machine, idempotency, fake checkout, cancel/expire | SQL invariant checks + integration tests |
| 3 | Safe B, Safe C, isolated unsafe lab module | Repeated controlled experiments; observed anomalies |
| 4 | Redis/BullMQ, outbox relay, sweepers, retries, reconciliation, fault injection | Worker restart / duplicate delivery without invariant break |
| 5 | Public booking UI + Engineering Lab dashboard | E2E + accessibility + real run data |
| 6 | Prometheus/Grafana/OTel, k6 scenarios, measured comparison | Reports with measured numbers, lock waits, invariant SQL |
| 7 | Security review, docs, runbooks, video plan, final audit | README reproduces 1,000/100 end-to-end |

## 7. Exact commands (target state; updated with measured outcomes per phase)

```bash
npm install                                  # workspace install
npm run typecheck && npm run lint            # static gates
npm run db:up                                # docker compose up -d postgres redis
npm run migrate                              # apply apps/api/src/db/migrations
npm run seed                                 # synthetic fixture
npm run test                                 # unit + integration (needs db:up)
npm run verify                               # single-command acceptance suite
npm run dev:api                              # tsx watch api on :4000
npm run dev:worker                           # BullMQ worker
npm run bench -- --strategy atomic_update    # scripted concurrency experiment (Node worker_threads)
k6 run load-tests/scenarios/competing-buyers.js -e STRATEGY=atomic_update   # Phase 6
```

## 8. Risk register

| # | Risk | Likelihood | Impact | Mitigation / owner decision |
| --- | --- | --- | --- | --- |
| R1 | Docker daemon not running on the engineer's machine → integration tests fail opaquely | High (observed today) | Medium | Pretest guard prints actionable message; `npm run db:up`; CI uses service containers |
| R2 | Windows path/line-ending and shell differences break scripts | Medium | Medium | Node-based scripts only (no bash-isms), `.gitattributes` with LF, PowerShell-compatible docs |
| R3 | Unsafe module accidentally reachable outside lab | Low | High | Env gate (`LAB_ENABLED`), separate schema/fixture, isolation tests, CI check |
| R4 | 1,000 k6 VUs misread as 1,000 simultaneous DB transactions (coordinated omission) | High | High | Barrier-start scenario, documented generator limits, separate rejections from failures |
| R5 | pnpm absent though spec mentions it | Confirmed | Low | npm workspaces, ADR-0008 |
| R6 | Machine-generated benchmark numbers not comparable across runs | Medium | Medium | Record CPU/RAM/versions, identical seeds, reset fixture, report raw files |
| R7 | Idempotency in-progress window (client retry while first request runs) | Medium | High | Key row locked in same tx; concurrent same-key returns `409` + `Retry-After` (ADR-0004) |
| R8 | Redis outage considered fatal to booking | Medium | Medium | Redis advisory-only; DB-only booking continues; documented in ADR-0005 |
| R9 | Scope exceeds session budget → partial phases | High | Medium | Phase gates with real evidence; never claim unrun tests |

## 9. Open questions (all resolved pragmatically, no blocker)

- Canceled-ticket inventory semantics → returns to `available` (documented in data model).
- Identifier strategy → UUIDv7 for time-clustered primary keys; `gen_random_uuid()` fallback to v4 if
  PG lacks v7 support; verified against the pinned image.
- Metric cardinality → labels limited to `route`, `method`, `status`, `strategy`, `outcome`, `pool_state`.
