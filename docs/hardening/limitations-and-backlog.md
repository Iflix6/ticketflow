# Limitations and production-hardening backlog

Phase 7 deliverable (requirements pack: "Clear architecture limitations and a production-hardening
backlog — multi-region, real payments, seat maps, fraud prevention, accessibility, disaster recovery").

This is the honest "what this lab is **not**" document. Nothing here is a hidden TODO: each item states the
current fact, the first concrete step, and the risk if it ships as-is. Security-specific deferrals live in
[`docs/security/audit.md`](../security/audit.md); ADRs carry the accepted trade-offs.

## 1. Architecture limitations (true today)

| # | Limitation | Why it is acceptable for the lab | Risk if taken to production as-is |
| --- | --- | --- | --- |
| L-1 | **Single PostgreSQL primary, single region.** All allocation truth is one ACID database (ADR-0002 *PostgreSQL as source of truth*). | The correctness story needs exactly one authority; replication would muddy the invariants. | Regional outage takes down booking; no write locality. |
| L-2 | **Redis is advisory, never the allocator.** Cache/rate-limit/queue only; because ADR-0002 makes the DB the allocator, a Redis outage cannot cause an oversell. | Keeps a Redis outage from corrupting inventory. | Redis down fails **reads** open and **writes** closed (intentional), so a Redis outage throttles bookings rather than corrupting them. |
| L-3 | **Rate limiter is process-local** (`InMemoryCounterStore`). The `CounterStore` seam is Redis-backed. | Single replica in the lab; the abstraction is proven by unit tests. | Multiple API replicas each get their own budget → effective limit is `limit × replicas`. Needs the Redis store before horizontal scaling. |
| L-4 | **Payments are a simulated provider** (`modules/payments/fake-provider.ts`), outcome passed in. | No card data, no PCI surface — a stated non-goal. | Zero real settlement logic; not a payment system. |
| L-5 | **Reservation expiry is sweeper-based**, `SWEEPER_INTERVAL_MS=15000` + outbox poll `1000 ms`; release is eventually-consistent on the DB clock. | TTL release does not need to be instant; the outbox guarantees it eventually happens exactly-once. | A seat is "held" up to one sweep interval past its TTL; fine for tickets, not for sub-second inventory. |
| L-6 | **Benchmark sample size is 1 (HTTP) / 2 (lab).** | The **correctness** claim (never exceed capacity) held across every single run and needs no more samples. | Any **speed ranking** between strategies is unsupported — intra-strategy spread was ~36% on identical config. Do not quote req/s as a spec. |
| L-7 | **k6 scenarios are shipped as code, not executed here.** `load-tests/flagship-booking.js` is present; no k6 binary was installed and downloads were disallowed. | The Node HTTP harness (`npm run bench`) produced the real numbers instead. | The k6 path is unvalidated by a live run in this environment. |
| L-8 | **`GIT_SHA` was null for the Phase 3/6 lab runs.** Now set in CI (`ci.yml`), and this session's runs are attributable. | Runs are still comparable by `seed=42` + stored configuration. | Historical Phase 3 rows (`experiment_runs`) are attributed by config, not revision — permanently, because they are immutable. |
| L-9 | **PostgreSQL 18 removed `pg_stat_activity.wait_time`** (SQLSTATE 42703). The worker derives lock-wait age from `clock_timestamp() - state_change`. | Matches the PG18 catalog; produced the measured 253 tuple + 14 transactionid waits. | On a pre-18 server the sampler's column assumption differs — it is written for 18. |
| L-10 | **Experiment history is append-only.** `experiment_runs`/`experiment_results` reject UPDATE/DELETE once completed (trigger, SQLSTATE TF002). | That immutability is the reason the report numbers are durable, not re-generated claims. | `npm run seed -- --reset` **fails by design** on a populated database; use `--experiment` (idempotent fixture reset) or a fresh DB. |
| L-11 | **No `report_paths` artifacts from the lab runner** (summary lives in the DB). | The Node HTTP harness writes JSON/CSV artifacts to `docs/experiments/artifacts/`. | The direct-pg lab has no file report; the markdown is its human carrier. |
| L-12 | **Worker metrics sample cadence** `METRICS_SAMPLE_MS` (default 5000 ms, overridable; this session used 200 ms to catch contention). | Averages/short bursts are invisible between samples. | A very brief lock convoy or backlog spike can fall between samples. |

## 2. Production-hardening backlog

Ordered roughly by (risk × reach). "First step" is deliberately small and testable.

### 2.1 Real payments
- **Why:** the fake provider is the single largest "lab vs product" gap.
- **First step:** introduce a `PaymentProvider` port; implement one real PSP behind a **webhook + idempotent
  reconciliation** path; keep the outbox as the source of post-commit truth. Persist a provider reference,
  never card PANs (drive PCI scope to the PSP via hosted fields).
- **Add:** settlement/authorization/void state machine distinct from the reservation lifecycle; refunds;
  dispute/chargeback handling that can *re-open* an allocation decision safely.

### 2.2 Seat maps / assigned seating
- **Why:** today inventory is a **counter per tier**, not individual seats — the model cannot express
  "aisle A row 12 seat 4".
- **First step:** add a `seats` table with `(event_id, section, row, seat)` and a hold that locks specific
  rows; keep the counter invariants as an aggregate check *on top* of per-seat truth.
- **Add:** seat-map rendering, adjacent-seat selection, accessibility seats, per-seat price override.

### 2.3 Multi-region writes
- **Why:** one primary is a single point of failure and a latency cliff for global on-sales.
- **First step:** make the allocation authority region-shardable (partition inventory by event/region so two
  regions never contend on the same row), then evaluate CRDT/last-writer strategies *only* where the
  invariant permits it. **Do not** relax `I1`/`I4` to get write locality — the whole point is no oversell.
- **Add:** conflict-free reservation claiming, regional failover runbook (extends `docs/runbooks/rollback.md`).

### 2.4 Fraud and abuse prevention
- **Why:** bots scalping a 100-ticket on-sale is the realistic adversary; the current limiter is not designed
  for it.
- **First step:** move rate limiting to the Redis `CounterStore` (unblocks L-3 too); add per-account,
  per-device, and per-payment-instrument velocity rules; queue suspicious reservations for async review.
- **Add:** bot mitigation at the edge (proof-of-work / managed challenge), purchase caps that survive
  multi-account, and a signal pipeline. The security audit's "no lockout / single-factor" deferral belongs
  here too.

### 2.5 Accessibility
- **Why:** a public booking flow is legally and morally required to be accessible; the lab only spot-checks.
- **First step:** expand the existing axe-core e2e (`@axe-core/playwright` is already a dependency) into a
  WCAG 2.2 AA gate over every user-facing screen, not just the happy path.
- **Add:** keyboard-only booking + live-region status announcements for `429/409/503` (already a README
  requirement), reduced-motion, screen-reader-accurate sold-out/expiry messaging, and a documented VPAT.

### 2.6 Disaster recovery
- **Why:** the DB is the sole allocation truth; losing it is losing the business.
- **First step:** PITR / automated base backups + WAL archiving, with a **tested restore drill** recorded in
  a runbook (a backup never restored is a rumor).
- **Add:** RPO/RTO targets, replica promotion runbook, the Redis-store rebuild path, and a
  reconciliation-from-source runbook that leans on the invariant views to prove post-restore correctness.

### 2.7 Operational completeness (cross-cutting)
- **Distributed tracing:** `OTEL_ENABLED=false` by default; the collector is present (`infra/otel`) but not
  exercised end-to-end in these runs. Wire a trace across API→queue→worker and show it in Grafana.
- **Secrets management:** `AUTH_SECRET` from `.env`; production needs a secrets manager + rotation, and the
  `__Host-`/double-submit CSRF cookie posture from the audit.
- **CI hardening:** dependency audit is report-only until the advisory baseline is triaged; make it a real
  gate once curated. Add a scheduled job that runs the flagship experiment even with no code change.
- **Autoscaling / backpressure:** none in the lab; production needs pool/queue sizing tied to the
  `PG_POOL_MAX` and worker concurrency so saturation degrades predictably (the fail-safe 500 path we
  measured is the behaviour to design around, e.g. shed load earlier with `Retry-After`).

## 3. Definition-of-done delta

The pack's Definition of Done is met for the **lab** (clean clone boots; 1,000/100 reproducible and
measured; safe strategies preserve inventory+idempotency under concurrency; unsafe baseline isolated and
instructive; lifecycle + recovery work; monitoring shows real data; CI verifies key guarantees; docs and
video plans complete). Every item above in §1–§2 is a **production** concern that is explicitly out of the
lab's scope and is here so it is *named*, not silently claimed as finished.
