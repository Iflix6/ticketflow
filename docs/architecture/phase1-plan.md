# Phase 1 — Foundation: monorepo, schema, boot path, CI

Status: **done**. Gate (master pack §Implementation phases): *"a fresh checkout boots and tests pass."*
Evidence for that gate is a real command run against a real database, recorded below — not a description of
what the tooling would do. ADRs established here: 0001 (workspaces), 0002 (PostgreSQL source of truth),
0003 (transaction strategy), 0006 (identifiers and time), 0008 (toolchain).

## Decisions and boundaries

- **npm workspaces, not pnpm.** The pack allows either and asks that one be documented; `package.json`
  declares `workspaces: ["packages/*", "apps/*"]` and every script runs through `npm run … --workspaces`.
  Chosen because the repo then needs exactly one package-manager binary, which matters for a reproducible
  fresh checkout (`ADR-0001`).
- **Four workspace packages, one direction of dependency.** `@ticketflow/contracts` and
  `@ticketflow/config` depend on `zod` only; `@ticketflow/api` depends on both; `@ticketflow/worker`
  depends on both plus `bullmq`/`ioredis`/`pg`. Nothing depends on the API — that is what keeps
  "the queue cannot authorize a sale" structural rather than a rule people remember.
- **TypeScript strict, plus the flags that actually catch bugs here**: `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`,
  `isolatedModules`, `noImplicitOverride`, `target/lib: ES2024`, `module: NodeNext`
  (`tsconfig.base.json`). The root `tsconfig.json` adds `noEmit` and deliberately includes
  `scripts/**`, `tests/**` and `apps/api/src/types/express.d.ts`, so CI typechecks the harness and the
  ambient `req.id` / `req.log` / `req.user` augmentations too — a test that stops compiling is a failure,
  not a silently-skipped assertion.
- **Engine floor `node >= 24.0.0`**, measured host `v26.1.0`. ESM throughout (`"type": "module"`), so
  every relative import carries a `.js` extension — the NodeNext resolution the pack's "no bundler magic"
  posture implies.
- **No ORM.** `pg` + hand-written SQL in repositories. The allocation statements in Phase 2/3 must be
  auditable character-by-character against what the documentation and the lab UI display, and an ORM's
  generated SQL cannot be pinned in a test.

## Boot path (what "fresh checkout" means)

1. `cp .env.example .env` — every value in it is a local default, and the file says so.
2. `npm ci` then `npm run db:up` (`docker compose up -d postgres redis`): `postgres:18-alpine` and
   `redis:7-alpine`, published to `127.0.0.1:${POSTGRES_PORT}` only, Redis with
   `appendonly yes`, `maxmemory 256mb`, `maxmemory-policy volatile-lru`.
3. `npm run migrate` — the hand-written runner in `scripts/migrate.ts`. Its rules fit in one file on
   purpose: `NNNN_name.up.sql`/`.down.sql` pairs, each version applied inside its own transaction (DDL is
   transactional in PostgreSQL), an advisory lock (`720300101`) so two processes cannot migrate
   concurrently, a checksum per applied version so an edited already-applied file is a **hard error**
   instead of a silent re-run, and `--down [n]` rolling back the newest `n` versions in reverse.
4. `npm run seed` — demo identities (`customer@local.test`, `lab@local.test` with `LAB_ADMIN`), the
   public catalog, and the flagship lab fixture `lab-flagship-1000-vs-100` via
   `SELECT lab.reset_fixture($1,$2,$3)`.
5. `npm run dev:api` / `npm run dev:worker`.

Env validation is the first thing that runs, in `@ticketflow/config`: `loadConfig` parses every variable
through Zod with explicit bounds (`PG_POOL_MAX`, `STATEMENT_TIMEOUT_MS`, `LOCK_TIMEOUT_MS`,
`RESERVATION_TTL_SECONDS` 5..86400, `MAX_QUANTITY_PER_RESERVATION` 1..100, `SESSION_TTL_HOURS` 1..720,
`RATE_LIMIT_*`, …) and **refuses to start when `NODE_ENV=production` while values still look like the
`.env.example` defaults**. That refusal is the reason this repository can ship a working unsafe lab mode
without shipping a working production misconfiguration.

## Data layer conventions set here (and used by every later phase)

- One `pg.Pool` per process, injected rather than imported (`db/pool.ts`), so a test can build a second
  pool against the same database and exercise real multi-process contention.
- `numeric` is parsed as **string**, never float — money-shaped values must not round silently in reports.
  `int8` is parsed as `BigInt`.
- Timeouts are applied with `set_config($1,$2,true)` inside a transaction, not `SET LOCAL x = $1`:
  PostgreSQL rejects a bind parameter in `SET` (SQLSTATE 42601). The parameterized form parses against a
  fake client and fails against a real server, which is exactly why the integration suite exists.
- Retries happen only in `runWithTransientRetry`, and only for the three codes where repeating the whole
  transaction is genuinely safe (`shared/errors.ts`): `40001` serialization_failure, `40P01`
  deadlock_detected, `55P03` lock_not_available — bounded attempts, full jitter. Everything else
  propagates. Connection-loss codes are a **separate** class (`isDependencyFailureCode`:
  `53300`/`57P03`/`08001`/`08006`/`57P01`) that fails readiness and answers 503 rather than being masked
  as a retryable transient, because an outage is not a contention signal. Non-idempotent side effects are
  never blindly retried.

## Verification — commands run, output measured

`npm run verify` (`scripts/verify.ts`) is the single-command acceptance suite the pack asks for. It runs
build → typecheck → lint → unit → integration → boot smoke, DB-gated steps SKIP honestly when PostgreSQL
is unreachable, and without `--allow-skip` a skip is a failure. Measured on this checkout:

```
npm run verify            → VERIFY_EXIT=0, "verify PASSED"
  unit        13 files / 89 tests  (7.80 s)
  integration 10 files / 101 tests (55.04 s)
  boot:smoke   8/8 checks, /health/ready → {"database":"ok","cache":"ok"}
```

The boot smoke check boots the **compiled artifact** (`apps/api/dist/server.js`), not `tsx`, and probes it
over real HTTP: liveness, readiness, `GET /api/v1/events`, a token exchange, an admin lab call, a
CUSTOMER rejected from the lab, and a clean shutdown. `GET /health/live` answers 200 with PostgreSQL down
while `/health/ready` answers 503 `dependency_unavailable` — the liveness/readiness split is tested, not
asserted in prose (`tests/integration/api.test.ts`).

CI skeleton (`.github/workflows/ci.yml`) runs: `npm ci` → build → typecheck → lint → `test:unit` →
migrate → `seed -- --experiment` → `test:integration` (service containers `postgres:18-alpine`,
`redis:7-alpine`, `TF_TEST_DATABASE_URL` set) → `invariants -- --quiescent` → `boot:smoke`
(`LAB_ENABLED=true`) → `migrate:down -- 9` then `migrate` again (the rollback smoke) → `npm audit` in
report-only mode.

## Limitations carried forward (stated, not hidden)

- **Phase boundaries are not clean in git history.** All nine migrations (0001–0009, including the lab
  schema and invariant views) landed in the foundation commit `f195504`, before any reservation code
  existed. The Phase 2/3 documents therefore describe behaviour *enabled* by schema shipped earlier; the
  per-migration rollback in CI is what proves each version still applies and reverts independently.
- `npm audit` is report-only, so a vulnerable transitive dependency fails nothing. Turning it into a gate
  belongs to the Phase 7 security review.
- Containers pin image tags but not digests; a rebuilt `postgres:18-alpine` could move a minor version
  underneath a "reproducible" experiment. Pinning digests is a hardening-backlog item.
- The `monitoring` Compose profile (Prometheus/Grafana/OTel) exists but is unexercised until Phase 6, so
  nothing here claims those dashboards work.

---

Previous: [Phase 0 — Discovery, Plan, and Execution Design](phase0-plan.md) ·
Next: [Phase 2 — Safe core](phase2-plan.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md)
