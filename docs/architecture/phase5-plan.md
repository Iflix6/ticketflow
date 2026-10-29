# Phase 5 — UI and lab

Status: **done**. Implements the pack's Phase 5 (lines 165): *"public booking experience and
restricted experiment dashboard. Gate: end-to-end flows, accessibility, real results."* The web app
is a Next.js 16 (App Router) + Tailwind workspace (`apps/web`) that speaks to the already-shipped
API — it invents no data and re-implements no business rule.

Gate evidence at the bottom is measured on this checkout. Every claim above it maps to a file or a
command that can be re-run.

## Boundaries (what we deliberately do NOT change)

- **The API stays the source of truth.** The web app is a BFF-less proxy: Server Components forward
  the visitor's `Cookie` header to `API_BASE_URL` (`lib/server-api.ts`), client components call the
  same-origin `/api/v1/*` rewrite (`next.config.ts`). No token is minted in the UI — the
  `tf_session` HttpOnly/Lax cookie issued by the auth routes *is* the credential, and because the
  API is proxied onto the web origin it is first-party (no CORS, no `SameSite=None`).
- **No new business logic in the UI.** Reservation/checkout/expiry semantics, the strategy set and
  the lab invariants all live in `apps/api`; the UI reuses their zod contracts from
  `@ticketflow/contracts` (`createLabRunRequestSchema`, `labRunConfigurationSchema`) so a client
  submission is validated by the *same* schema the server will apply.
- **No fabricated chart ever.** Every number rendered on a lab page is read from a completed run's
  `outcomes`/results. The charts are hand-rolled SVG (`components/GroupedBars.tsx`) rather than a
  charting dependency — fewer libraries (a pack constraint) and nothing that could draw a series the
  API did not return.
- **`unsafe_lab` never leaves the isolated fixture.** The public booking path only offers the three
  safe strategies; the scenario builder can launch `unsafe_lab` but that runs exclusively against
  `lab.inventory` (runner.ts), so no UI action can oversell real capacity.

## Mechanism

1. **Session model (BFF-free).** `POST /auth/session` sets the cookie; the web app needs no separate
   login/token dance. `lib/session.ts` reads `res.data.user` (the `{data:{user}}` envelope) to decide
   what each server-rendered page shows. This unwrap was an actual Phase-5 bug: reading `res.user`
   made `/bookings` redirect even with a valid cookie — the fix and its test are noted below.
2. **Public booking flow** (`app/events`, `app/events/[id]`, `components/BookingPanel.tsx`,
   `app/bookings`): catalog → tier detail → hold seats → live countdown → fake checkout → status.
   The "no misleading success" rule is encoded literally: a hold is shown only after the `201`, a
   booking only after the checkout response, and checkout **branches on the HTTP status the server
   chose** — `201` CONFIRMED, `200` FAILED (seats released), `202` still PENDING ("unknown, not
   failed"). The countdown renders the server's `secondsRemaining`; hitting zero re-reads the
   reservation instead of declaring expiry client-side.
3. **Lab dashboard** (`app/lab/*`), gated on role. The layout is an honest guard, not a redirect
   maze: anonymous → sign-in prompt; `CUSTOMER` → a visible notice that lab routes answer `403`;
   `LAB_ADMIN` → tab nav. Pages: runs list, scenario builder (`components/ScenarioForm.tsx`), run
   detail with outcomes/percentiles/invariant violations + failure explorer
   (`components/ResultsTable.tsx`), compare two runs (`GroupedBars`), strategies & verbatim SQL
   (`app/lab/strategies`), and a CSV export route handler (`app/lab/runs/[id]/export`).
   `POST /lab/runs` is synchronous, so the builder shows busy state for the run's whole duration and
   navigates to the result **only on `201`**.

## Verification

### Acceptance suite (`npm run verify`) — measured on this checkout

```
================ verify summary ================
PASS  build (workspaces)                 PASS  unit tests            (89 passed / 13 files)
PASS  typecheck (strict)                 PASS  integration tests     (119 passed / 11 files, real PostgreSQL)
PASS  lint                               PASS  boot smoke            (8/8 checks vs built artifact)
verify PASSED
```

`build (workspaces)` compiles `apps/web` too. The web production build emits **12 routes**
(`/`, `/_not-found`, `/bookings`, `/events`, `/events/[id]`, `/lab`, `/lab/runs/[id]`,
`/lab/runs/[id]/export`, `/lab/runs/compare`, `/lab/scenario`, `/lab/strategies`, `/login`), all
dynamic (server-rendered on demand), TypeScript clean.

### End-to-end + accessibility (`npm run test:e2e`, Playwright on the installed `msedge` channel)

```
Running 8 tests using 1 worker
  ok 1 a11y.spec.ts      public pages have no critical/serious axe violations
  ok 2 a11y.spec.ts      signed-in booking surface and lab dashboard have no critical/serious axe violations
  ok 3 a11y.spec.ts      skip link moves focus past the navigation
  ok 4 booking.spec.ts   customer signs in through the UI and books two seats end-to-end
  ok 5 booking.spec.ts   anonymous visitors get the sign-in prompt on protected surfaces
  ok 6 booking.spec.ts   a signed-in customer sees an honest 403 notice on the lab, not mock data
  ok 7 lab.spec.ts       admin launches an atomic_update run and lands on its real results
  ok 8 lab.spec.ts       CSV export serves the run rows from the web route handler
  8 passed (1.3m)
```

axe scans each page for `wcag2a/aa/21a/21aa` and asserts on rule IDs at `critical`/`serious`
impact. Fixing it caught two real colour-contrast defects (slate body text on amber/slate badges in
`app/layout.tsx`). Test 4 exercises the client `BookingPanel` done-state, which surfaced a genuine
envelope bug: `browserApiRaw` returns the full `{data: BookingDto}` body, and the checkout handler
cast it straight to `BookingDto`, so `booking.id.slice(...)` threw on `undefined`. The fix unwraps
`res.json.data` — the same way `holdSeats`/`refreshReservation` already did.

### Live booking flow (real API + `tf_session` cookie) — measured

```
GET  /events                         -> 200, event[0] = "Lab Fixture — 1,000 Buyers vs 100 Tickets"
GET  /events/:id/tiers               -> 200, tier "Single Seat" price USD 25.00, available 90/100
POST /reservations   (Idempotency-Key)-> 201 PENDING secondsRemaining=300
POST /reservations/:id/checkout      -> 201 CONFIRMED total = USD 50.00   (2 × 25.00, server decimal)
GET  /me/bookings                     -> 200, includes the confirmed booking: true
```

### Lab runs (real, isolated `lab` schema) — measured, seed 20261028, capacity 10, 40 concurrent buyers

```
POST /lab/runs unsafe_lab    -> 201  attempted=40 succeeded=40 invariantViolations=1
                               p50=462.515 p95=1123.057 p99=1159.247 throughput=34.46/s duration=1161ms
POST /lab/runs atomic_update -> 201  attempted=40 succeeded=10 soldOut=30 invariantViolations=0
                               p50=135.007 p95=388.864 p99=404.772 throughput=98.78/s duration=405ms
GET  /lab/runs/:id/results?limit=5000 -> 200, rows=40
```

The unsafe baseline oversold 10 capacity to 40 and its `invariantViolations=1` is what the run-detail
page lists verbatim; the atomic control sold exactly 10 and reported 0. These are the numbers the
compare view and `GroupedBars` chart render — copied from the API response, not authored in the UI.

### Honest guards (measured via rendered HTML)

Anonymous `/lab` renders the sign-in prompt; a signed-in `CUSTOMER` `/lab` renders the amber 403
notice (no mock data); both are asserted in `booking.spec.ts` tests 5 and 6.

---

Previous: [Phase 4 — Async processing, outbox relay, recovery](phase4-plan.md) ·
Next: [Phase 6 — Observability and benchmarking](phase6-plan.md) ·
Source of truth: [Ticketflow-Requirements-Prompt-Pack.md](../../Ticketflow-Requirements-Prompt-Pack.md)
