# ADR-0008 — Toolchain: npm workspaces, TypeScript strict ESM, Express 5, no ORM

Status: accepted (Phase 0).

## Context
The spec mandates Express + TypeScript strict + `pg` with explicit parameterized SQL, and permits
either pnpm or npm workspaces. Measured environment: `pnpm` is **not installed**
(`CommandNotFoundException`), `npm` 11.6.2 is, `npm view express version` → `5.3.0`.

## Decision
- **npm workspaces** (`package.json` `workspaces: ["apps/*", "packages/*"]`). Chosen because the
  reference machine has npm and no pnpm; "clean clone boots" must hold with one command
  (`npm install`). Justification for revisiting: if pnpm is added to CI images, switching is a
  lockfile-and-script change only.
- **TypeScript strict ESM**: `"type": "module"`, `module: NodeNext`, `target: ES2024`,
  `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`.
  Explicit `.js` specifiers in imports (Node ESM requirement). `tsx` for dev/test, `tsc` for build.
- **Express 5** (current default major). Consequences handled: async handlers propagate errors
  natively, no unnamed wildcards, `body-parser` 2 bundled with explicit limits.
- **No ORM.** `pg` + SQL files + a ~150-line migration runner. Every query is visible in the repo,
  which is the point of the artifact.
- Minimal dependency footprint (each addition justified): `zod` (boundaries), `pino` (structured logs),
  `prom-client` (metrics), `@opentelemetry/*` (traces), `bullmq` (queues), `ioredis` (transitive via
  bullmq plus explicit cache/rate-limit use), `helmet`, `argon2` (or `bcryptjs` pure-JS fallback —
  decided by install feasibility on Windows and recorded here after testing), `vitest`, `supertest`,
  `eslint`, `typescript`.

## Rejected alternatives
- NestJS/Fastify/Prisma: explicitly out of scope by the requirements.
- `ts-node` CommonJS interop: keeps `verbatimModuleSyntax` and ESM clarity impossible.
- Sequelize/TypeORM: would hide the very SQL the lab teaches.
