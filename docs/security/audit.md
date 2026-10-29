# Security review — TicketFlow Reliability Lab (Phase 7)

Status: **complete**. This is a code-grounded review, not a checklist: every claim below cites the
specific file and, for the one defect found and fixed, records a measured before/after.

Scope of the read: `apps/api/src/middleware/{security,rate-limit,authenticate,lab-gate,errors}.ts`,
`apps/api/src/modules/auth/{credentials,sessions,routes}.ts`, `apps/api/src/shared/{crypto,validation,respond,errors}.ts`,
`apps/api/src/modules/reservations/{routes,service}.ts`, `packages/config/src/index.ts`, and the
`.env` / `.env.example` / `compose.yaml` secret handling.

## Threat posture that is already correct (verified by reading, some by the boot-smoke assertions)

| Area | File | What it does right |
| --- | --- | --- |
| Transport hardening | `middleware/security.ts` | `helmet` with an explicit `default-src 'none'` CSP, `frame-ancestors 'none'`, CORP `same-origin`, `no-referrer`, HSTS only in production; `X-Powered-By` removed. |
| CORS | `middleware/security.ts` | Allowlist from validated config; an unlisted `Origin` gets **no** CORS header (browser blocks) rather than a reflection. `credentials: true` only pairs with that allowlist. |
| Body parsing | `middleware/security.ts` | `express.json({ strict: true, limit: BODY_LIMIT })` — arrays-only top level rejected, size capped, prototype-pollution payloads never reach a handler. |
| Config validation | `packages/config/src/index.ts` | One frozen Zod parse at boot; `NODE_ENV=production` **refuses to start** if `AUTH_SECRET`/`DATABASE_URL` still contain a committed local default, and if `LAB_ENABLED` is on. Booleans parsed from an explicit string enum (never `Boolean("false")`). |
| Password hashing | `modules/auth/credentials.ts` | `scrypt` (N=16384,r=8,p=1) with a per-password random salt, parameters embedded in the stored string, `timingSafeEqual` on comparison. |
| Tokens | `modules/auth/credentials.ts` | HMAC-SHA256, short-lived; signature verified with `timingSafeEqual` **before** the payload is parsed; expiry and role re-checked on every request. |
| Sessions | `modules/auth/sessions.ts` | 32 random bytes to the client, only its SHA-256 stored (a DB dump yields no usable token); absolute expiry on the database clock; explicit atomic rotation keyed by the old hash; revocation keeps the row for audit; `HttpOnly`/`SameSite=Lax`, `Secure` in production. |
| Authz | `middleware/authenticate.ts`, `modules/reservations/service.ts` | Bearer token deliberately wins over an ambient cookie; `requireRole`; and `assertOwner` (service.ts) enforces `reservation.user_id == caller` (unless `LAB_ADMIN`) on **read, cancel and checkout** — so one user cannot act on another's reservation. |
| Idempotency isolation | `modules/reservations/service.ts` | `acquireIdempotency` is scoped by `scopeUserId` **and** endpoint, so a replayed key from a different user can neither collide with nor read another user's cached response. |
| Lab isolation | `middleware/lab-gate.ts` | Two independent locks (env allowlist `local/test/ci` + `LAB_ENABLED`) and the router is not mounted at all otherwise. Boot-smoke asserts a `CUSTOMER` on `/lab/strategies` gets **403 with no `sqlstate` leak**. |
| Rate limiting | `middleware/rate-limit.ts` | Fixed window keyed on identity+route-group (never full URL — no label-cardinality blowup, never a secret). Failure policy is asymmetric and explicit: reads fail-open, **writes fail-closed** (`dependency_unavailable`) so a throttled-lab write path is never silently unthrottled. |
| Error hygiene | `shared/respond.ts` | `internal_error` responses never carry the driver message (which leaks table/constraint/connection details); the raw cause goes to the log; `debugCause` is only attached when `NODE_ENV !== 'production'`. |

## Finding SEC-1 (Medium) — login timing side-channel enabled username enumeration — FIXED

**Class.** The demo token and session login paths returned a single generic `"Credentials are not
valid"` for both an unknown email and a wrong password (no *message*-level enumeration), **but** the
code only ran the expensive `scrypt` verification when the account existed *and* had a password hash:

```ts
// before
const presented =
  user !== undefined && user.password_hash !== null
    ? await verifyPassword(password, user.password_hash)
    : false;                       // <-- unknown email / token-only identity: ZERO scrypt work
```

An unknown email therefore answered in a few milliseconds while a real account with a wrong password
took ~70 ms of `scrypt`. That gap is a textbook enumeration oracle — it defeats the very guarantee the
surrounding comment claims, and the integration test is even titled *"without enabling enumeration"*.

**Fix.** Always perform equal `scrypt` work by verifying against a constant, correctly formatted dummy
hash (`DUMMY_PASSWORD_HASH`, built once at module load from a throwaway random value — it is never a
valid login) whenever no live password row is present:

```ts
// after
const storedHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
const presented = await verifyPassword(password, storedHash);
if (user === undefined || user.password_hash === null || !presented) {
  throw new AppError('unauthorized', 'Credentials are not valid');
}
```

Files changed: `apps/api/src/modules/auth/credentials.ts` (adds `DUMMY_PASSWORD_HASH`),
`apps/api/src/modules/auth/routes.ts` (`authenticateCredentials`).

**Measured evidence (post-fix).** 35 interleaved failed logins against the compiled artifact over HTTP,
medians (each branch now pays full `scrypt`):

```json
{
  "iterations": 35,
  "unknownEmailMedianMs": 69.89,
  "wrongPasswordMedianMs": 70.95,
  "ratioUnknownToWrongPw": 0.985
}
```

A 0.985 ratio is indistinguishable; pre-fix the unknown-email branch skipped `scrypt` entirely and
returned in a small fraction of that time. Correctness is unchanged: both branches still yield 401 with
the identical message, and a sub-12-character password is still rejected as 400 at the Zod body schema
*before* any hashing (so the equal-work path is never triggered by schema-invalid input).

**How to re-verify.** Rebuild, start the API, and drive `POST /api/v1/auth/token` with (a) a nonexistent
email and (b) a real email with a wrong password, timing both; the medians must be within noise. The
in-suite guard for message-level equality is `tests/integration/api.test.ts` → *"…without enabling
enumeration"*.

## Observations deferred to the hardening backlog (correct for a local lab, not for production)

These are deliberate, documented lab limits — recorded in [docs/hardening/limitations-and-backlog.md](../hardening/limitations-and-backlog.md):

- **Single-factor, no lockout.** No rate-limit-coupled account lockout or MFA on the password path
  (noted in `modules/auth/routes.ts`). Synthetic local data only.
- **`scrypt` vs Argon2id + a secrets manager.** Adequate built-in KDF; production would tune Argon2id
  and move `AUTH_SECRET` out of `.env` into a managed secret store.
- **CSRF posture.** `SameSite=Lax` + POST-only mutations is enough for the lab; a production browser
  flow would add a double-submit/`__Host-` prefixed cookie (see `modules/auth/sessions.ts`).
- **Raw SQLSTATE on wrapped errors.** `shared/respond.ts` surfaces `details.sqlstate` (e.g. `23505`)
  for non-internal errors even in production. The value is a standardized code, not a message, and the
  boot-smoke proves the authz path leaks nothing — but gating `sqlstate` behind `exposeDebug` too is a
  reasonable production tightening.
- **Rate limiter is per-process.** Correctly labelled `InMemoryCounterStore`; the `CounterStore` seam
  is Redis-backed for multi-replica deployments. A single replica has no distributed throttle today.
- **Dependency audit is report-only** in CI until the advisory baseline is triaged (documented in
  `docs/runbooks/`).
