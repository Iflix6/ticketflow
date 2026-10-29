# Phase 7 — Hardening and publication

Status: **done**. Implements the pack's Phase 7 (line 169): *"security review, CI completeness, docs,
runbooks, scripts, video guides, final audit. Gate: a new engineer can reproduce the flagship
1,000-users/100-tickets experiment from README without hidden manual steps."* This phase added no business
feature either — it proved the system is *reproducible by a stranger*, closed one real security defect, made
the flagship experiment reproducible by event slug in code and as an executed CI gate, and reconciled the
design-era README with tested reality. Every number below was produced on this checkout against live
PostgreSQL/Redis; nothing is an estimate.

The headline: on a **fresh database** (`ticketflow_repro7`) a clean-checkout sequence — migrate → seed
`--experiment` → invariants → build → boot:smoke → `npm run bench` against the flagship fixture — sold
**exactly 100 of 100 tickets to 1,000 concurrent buyers with `oversellViolation = false` and all six SQL
invariants PASS**, using only commands copied from the README. `npm run verify` is fully green (integration
and boot-smoke no longer skipped). A real login timing side-channel (SEC-1) was found, fixed, and measured
to 0.985 timing parity, with a deterministic unit guard.

Gate evidence is at the bottom, measured. Every claim above it maps to a re-runnable file or command.

## Boundaries (what we deliberately do NOT change)

- **No new architecture, no new dependencies.** Phase 7 is verification + publication. The only runtime code
  edits are the SEC-1 fix (`credentials.ts`, `routes.ts`), a benchmark selector flag (`--event-slug`), and two
  Dockerfiles that had a latent build bug. The DB-owns-truth model ([ADR-0002](../adr/0002-postgres-source-of-truth.md))
  and the API/worker split ([ADR-0001](../adr/0001-modular-monolith-workspaces.md)) are untouched.
- **CI is wired as-code and YAML-validated, not executed here.** There is no GitHub runner on this
  workstation; the workflow's `run:` bodies were reproduced manually against a live stack to prove each step
  would pass. The flagship gate step *executes the same `npm run bench` command the README documents*, so the
  README and CI cannot drift.
- **The security audit is code-grounded, not a checklist.** It reads the real auth/rate-limit/ownership/error
  paths and cites files; a finding is only claimed "fixed" when a measurement or a unit test proves it. No
  finding was invented to fill a template, and no already-mitigated item is passed off as a bug.
- **Docs cite artifacts that exist.** The video plan and hardening backlog reference committed JSON/CSV under
  [`artifacts/`](../experiments/artifacts/) and real ADR numbers; no figure is quoted that a re-run cannot
  regenerate.

## Mechanism

1. **Reproducible-by-slug fixture (code).** `scripts/benchmark.ts` now accepts `--event-slug lab-flagship-1000-vs-100`
   and resolves the tier by slug instead of list index, so the flagship experiment no longer depends on how
   many events happen to be seeded or their ordering. If the slug is absent it fails with an actionable message
   ("run `npm run seed -- --experiment` first") rather than silently benchmarking the wrong tier. This is what
   makes the README's single command genuinely self-contained.
2. **The flagship gate as an executed CI step.** `.github/workflows/ci.yml` gained `GIT_SHA: ${{ github.sha }}`
   (so runs are revision-attributable — the Phase 6 prerequisite), a step that boots the built API, waits for
   `/health/ready`, runs the flagship `npm run bench -- --event-slug … --users 1000 --concurrency 100`, a
   **post-burst** `npm run invariants -- --quiescent`, and `upload-artifact` of the `ci-flagship-*` results. The
   bench exits non-zero only on a real oversell, so the step is a true no-oversell gate. 17 steps; YAML parsed
   with `js-yaml` to confirm structure (no runner here to execute them).
3. **SEC-1: closing a login timing oracle.** Previously the unknown-email branch of `authenticateCredentials`
   set `presented = false` **without running `scrypt`**, returning in a few ms, while a wrong password spent
   ~70 ms of `scrypt` — a textbook username-enumeration oracle that even defeated the surrounding comment and
   the integration test titled *"…without enabling enumeration"*. Fix: `credentials.ts` exports a module-level
   `DUMMY_PASSWORD_HASH` (well-formed, real `scrypt` work), and the route always verifies against
   `user?.password_hash ?? DUMMY_PASSWORD_HASH`, so both unknown-account and wrong-password paths do identical
   work and return the identical `unauthorized`. A deterministic guard was added to
   `tests/unit/credentials.test.ts` ("exposes a well-formed dummy hash so the unknown-account login branch costs
   real scrypt work").
4. **README reconciled with reality.** The design-era sections that said "Proposed" (startup, endpoints, npm
   scripts, env config, CI/CD gates) were replaced with the **commands actually tested this phase**, and a
   "Reproduce the flagship experiment" section was added with the exact command and its measured output. The
   status/quick-start/reference-scenario paragraphs and a Security-section pointer were updated to match.
5. **Publication docs.** [`docs/security/audit.md`](../security/audit.md) (posture table + SEC-1 finding/fix/
   measurement + deferred items), [`docs/video/plan.md`](../video/plan.md) (10-episode plan; every cited figure
   is a real, artifact-backed number — no invented results), and
   [`docs/hardening/limitations-and-backlog.md`](../hardening/limitations-and-backlog.md) (L-1…L-12 architecture
   limitations + a production backlog: real payments, seat maps, multi-region, fraud, accessibility, DR).

## Findings that changed the code (measured, not theoretical)

- **SEC-1 login timing enumeration** — found by reading the auth path, fixed with equal-work hashing, and
  *measured*: over 35 alternating requests the unknown-email median was **69.89 ms** vs wrong-password
  **70.95 ms**, ratio **0.985** (indistinguishable). Pre-fix the unknown branch skipped `scrypt` entirely.
  Write-up: [../security/audit.md](../security/audit.md).
- **The container images never actually built in the clean-checkout path.** `Dockerfile.api`/`Dockerfile.worker`
  ran `npm ci --omit=dev` in the `deps` stage and then called `tsc` in the `build` stage — but `tsc` is a
  devDependency, so `docker compose build` failed with `sh: tsc: not found` (exit 127). The prior phases' host
  path masked this. Fix: `deps` now does a full `npm ci`, and a new **`prod-deps`** stage runs
  `npm prune --omit=dev` *after* compilation so the runtime image still ships only production dependencies.
  Both images now build, and both containers come up **healthy** (see verification).

## Verification

### Acceptance suite (`npm run verify`) — measured on this checkout

```
================ verify summary ================
PASS  build (workspaces)            PASS  unit tests            (90 passed / 13 files)
PASS  typecheck (strict)            PASS  integration tests     (119 passed / 11 files, real PostgreSQL)
PASS  lint                          PASS  boot smoke            (8/8 checks vs built artifact)
verify PASSED
```

The **1 skipped→0** change is the point: this run had a reachable database, so integration (119) and boot-smoke
(8/8) executed instead of `SKIP (no database)`. Unit count is 90 (Phase 6 baseline 89 **+1** = the SEC-1 guard).
Boot-smoke's 8 checks include `POST /auth/token (CUSTOMER) → token`, i.e. the SEC-1-touched login path is
exercised end-to-end on the built artifact.

### The Phase 7 gate — clean-checkout reproduction on a fresh database

Executed against scratch DB `ticketflow_repro7` on host port `:5433` (the container port; a native Postgres
owns `:5432` on this host — see limitations), using only README commands:

```
npm run migrate            -> 9 migrations applied
npm run seed -- --experiment -> flagship fixture "lab-flagship-1000-vs-100", tier capacity 100 (seed 42)
npm run invariants         -> PASS I1 I2 I3 I4 I5 I6 (all hold, quiescent)
npm run build              -> workspaces built (Next.js + tsc)
npm run boot:smoke         -> PASS 8/8 against the built artifact
npm run bench -- --event-slug lab-flagship-1000-vs-100 --users 1000 --concurrency 100 --quantity 1 \
              --outcome success --label repro7-flagship
  confirmed 100 ≤ startAvailable 100   sold_out 900   oversellViolation = false
  reserve p50/p95/p99 = 977 / 3317 / 3963 ms   checkout p50/p95/p99 = 3429 / 3849 / 3890 ms
  throughput 64.81 e2e ops/s (totalOps 1100 in 16.97s)
DB final state             -> 100 confirmed | 0 held | 0 released | 100 sold  (invariant-consistent)
npm run invariants         -> PASS I1…I6, all hold after the burst
```

Raw artifacts: [`artifacts/repro7-flagship-1000-vs-100.json`](../experiments/artifacts/repro7-flagship-1000-vs-100.json)
/ `.csv`. This is the gate: a new engineer reproduces the flagship result from the README with no hidden
manual steps.

### Fail-safe held under real host contention

A second run via the slug selector, executed while the host carried many unrelated Node processes, produced
**56 confirmed, 95 reserve `server_error`, 44 checkout `500`, 805 `sold_out`, `oversellViolation = false`**
([`artifacts/repro7-flagship-slug-under-host-load.json`](../experiments/artifacts/repro7-flagship-slug-under-host-load.json)).
Under saturation the system returns transient 5xx (pool acquisition timeout) and **never oversells** — the
same fail-safe behaviour documented in Phase 6, now reproduced through the README's slug command. The clean
run above is the headline; this run is kept as evidence that the gate's correctness property is robust to
noise, not dependent on a quiet machine.

### Security fix — measured

```
SEC-1 timing parity, 35 alternating requests against the running API:
  unknown-email median  69.89 ms
  wrong-password median 70.95 ms
  ratio (unknown/wrong) 0.985     ← indistinguishable; pre-fix unknown branch skipped scrypt (~ms vs ~70ms)
unit guard: tests/unit/credentials.test.ts → "…dummy hash so the unknown-account login branch costs real scrypt work" (9 tests pass)
```

### Containers build and boot healthy (Dockerfile fix)

```
docker compose build api worker   -> Image ticketflow-lab-api Built ; Image ticketflow-lab-worker Built
docker compose up -d api worker   -> ticketflow-api Up (healthy) ; ticketflow-worker Up (healthy)
curl /health/ready                -> 200 {"database":"ok","cache":"ok"}
worker logs                        -> "queue topology created", "worker metrics endpoint listening :9464",
                                      "worker started" queues:[outbox-dispatch,reservation-expiry]
```

## Limitations & hardening backlog

- **CI is validated, not executed here.** No GitHub runner on this workstation; the flagship gate step's body
  was run manually against a live stack and the YAML parsed with `js-yaml` (17 steps). The first real runner
  execution is the remaining proof.
- **Host port trap is environment-specific.** This machine's native Postgres owns `:5432`, so the container is
  published on `:5433` and `.env` points `DATABASE_URL` there. On a clean checkout with no conflicting
  service, the documented defaults work directly; a stranger hitting the same trap should read the README's
  note. Recorded in [../hardening/limitations-and-backlog.md](../hardening/limitations-and-backlog.md).
- **n = 1 per scenario, one shared machine.** Correctness is well supported (clean run + loaded run + Phase 6's
  three runs, all zero oversell, invariants PASS); latency is indicative of the *shape*, not a ranking. More
  repeats belong to a k6 run where k6 exists (still not installed here; downloads disallowed).
- **SEC-1 was the only defect found by the audit**, not a claim of total absence. The audit's deferred items
  (rate-limiter Redis-side fail-open, no MFA/lockout, local-only secrets) are logged as hardening work, not
  silently dropped.
- **`GIT_SHA` is wired into CI env and the API's experiment attribution path**, but the standalone benchmark
  JSON artifact does not yet stamp `git_sha` itself; running the bench *through* CI is what makes a published
  run revision-attributable. Auto-stamping the harness artifact is a small hardening follow-up.
- **Not committed.** Per standing instruction, all Phase 7 changes are left in the working tree for review.

Full limitations register and the prioritised production backlog (real payments, seat maps, multi-region,
fraud, accessibility, DR, operational completeness) are in
[../hardening/limitations-and-backlog.md](../hardening/limitations-and-backlog.md).

---

Previous: [Phase 6 — Observability and benchmarking](phase6-plan.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md).
This is the final phase; the flagship reproducibility gate is met.
