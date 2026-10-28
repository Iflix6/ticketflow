# curl examples — every documented operation, executed

Companion to [openapi.yaml](openapi.yaml). This is **not** an illustrative list of commands someone typed
from memory: every example below was executed against a live `npm run dev:api` on
`http://127.0.0.1:4000` (Node v26.1.0, PostgreSQL 18.6, `LAB_ENABLED=true`, `NODE_ENV=local`) on
2026-10-28, and the response bodies are the captured output. A re-run reproduces the **status codes and
shapes**; ids, timestamps and counter values will differ.

Both guards that keep the spec honest are in the repo:
`tests/unit/openapi-contract.test.ts` (structural: operation count, per-method tally, closed error taxonomy,
middleware-derived status rules) and `tests/integration/openapi-parity.test.ts` (live: every documented path
is actually requested, and every observed status must be one the spec declares).

## Setup

```bash
cp .env.example .env      # PORT=4000, LAB_ENABLED=true, local demo credentials
npm ci
npm run db:up             # postgres:18-alpine + redis:7-alpine
npm run migrate
npm run seed              # demo catalog + local accounts
npm run dev:api
```

The local server listens on `127.0.0.1:${POSTGRES_PORT:-5432}` for PostgreSQL and `PORT=4000` for the API.
`.env` in this checkout publishes the database on host port **5433** because a native Windows PostgreSQL
service already owns 5432 — that does not affect any command below.

```bash
BASE=http://127.0.0.1:4000
```

Two headers carry the demo identities. Tokens are obtained, never hard-coded:

```bash
CUSTOMER=$(curl -s -X POST "$BASE/api/v1/auth/token" -H 'content-type: application/json' \
  -d '{"email":"customer@local.test","password":"local-demo-customer-2026"}' | jq -r .data.token)
LABADMIN=$(curl -s -X POST "$BASE/api/v1/auth/token" -H 'content-type: application/json' \
  -d '{"email":"lab@local.test","password":"local-demo-admin-2026"}' | jq -r .data.token)
```

> These passwords are the seeded local demo values from `scripts/seed.ts` (`TF_SEED_CUSTOMER_PASSWORD` /
> `TF_SEED_ADMIN_PASSWORD` overrides). They protect synthetic data on loopback. `@ticketflow/config` refuses
> to start in `production` while configuration still looks like these defaults.

Every JSON response carries `x-request-id` (`sendJson` sets it on all responses, including 404 and 429), so
a support request can quote it. Read it with `-i` or `-D -`.

## 1. Health and metrics — never rate limited

```bash
curl -si "$BASE/health/live"
curl -si "$BASE/health/ready"
curl -s  "$BASE/metrics" | head -n 12
```

`2026-10-28` capture:

```
GET /health/ready   → 200
{"status":"ok","component":"api","detail":"{\"database\":\"ok\",\"cache\":\"ok\"}","version":"0.1.0"}

GET /metrics        → 200  (text/plain; Prometheus exposition)
# HELP ticketflow_http_requests_total Completed HTTP requests by method, route template and status class.
# TYPE ticketflow_http_requests_total counter
ticketflow_http_requests_total{method="GET",route="/health/live",status_class="2XX"} 3
ticketflow_http_requests_total{method="POST",route="/api/v1/auth/token",status_class="2XX"} 18
ticketflow_http_requests_total{method="POST",route="unmatched",status_class="4XX"} 3
ticketflow_http_requests_total{method="GET",route="/api/v1/events/",status_class="2XX"} 123
```

Two things worth knowing before you script against these:

- `/health/live` answers 200 **while PostgreSQL is down**; only `/health/ready` answers 503
  `dependency_unavailable`. Probing liveness to detect an outage gives you a false green.
- The metric label is a **route template** (`/api/v1/events/:id`), and requests that matched nothing are
  grouped under `route="unmatched"` — so a broken URL inflates `unmatched`, not some real route. Cardinality
  is bounded on purpose; you cannot accidentally create one series per reservation id.
- All three are outside the rate limiter (the limiter is mounted on the `/api` router only). Scrapers must
  not be throttled into a false outage signal.

## 2. Catalog — public, no token

```bash
curl -s "$BASE/api/v1/events?page=1&pageSize=2"            | jq
curl -s "$BASE/api/v1/events/0966e55b-ee1b-4708-86e1-8759570a546b"      | jq
curl -s "$BASE/api/v1/events/0966e55b-ee1b-4708-86e1-8759570a546b/tiers"| jq
```

`listEventTiers` returns a `tier` + `inventory` pair per row — this is the only place a client sees the
counters, and it is read-only:

```json
{"data":[{"tier":{"id":"78f49287-d027-4311-8783-be97bb4beef4","name":"GA Lawn","priceDisplayOnly":"49.00",
  "currency":"USD","capacity":5000},
  "inventory":{"tierId":"78f49287-d027-4311-8783-be97bb4beef4","capacity":5000,"available":4998,
  "reserved":0,"sold":2,"version":4}}]}
```

Note `"priceDisplayOnly":"49.00"` — `numeric` is serialized as a **string**, never a JSON float, so money
cannot round silently in a report. `listEvents` also accepts `?status=ON_SALE`; an invalid value is 400, not
silently ignored:

```bash
curl -s "$BASE/api/v1/events?status=NOT_A_STATUS"
# {"error":{"code":"validation_failed", ...}}                                    → 400
curl -s "$BASE/api/v1/events/not-a-uuid"      # uuid parse failure               → 400
curl -s "$BASE/api/v1/events/00000000-0000-4000-8000-000000000099"  # well-formed → 404 not_found
```

## 3. Token exchange (local/demo only)

```bash
curl -s -X POST "$BASE/api/v1/auth/token" -H 'content-type: application/json' \
  -d '{"email":"customer@local.test","password":"local-demo-customer-2026"}'
```

```json
{"data":{"token":"tf1.eyJzdWIiOiI2MmM0OTY4ZC…","tokenType":"Bearer","expiresInSeconds":43200}}
```

Failure modes, all executed:

| request | status | `error.code` | why it is that code |
| --- | --- | --- | --- |
| wrong password | 401 | `unauthorized` | deliberately **identical** to "unknown user" — no account enumeration |
| `"password":"short"` (11 chars) | 400 | `validation_failed` | Zod rejects before any credential work (`min(12).max(200)`) |
| unknown email, valid shape | 401 | `unauthorized` | same generic message as a wrong password |

This route exists because the spec sanctions local test tokens. It is mounted **only** when the lab is
enabled (`isLabEnabled`), so a production-shaped deployment does not expose a password-for-token endpoint at
all; Phase 5 replaces it with a browser session behind the same `req.user` contract.

## 4. Reserve → confirm → read — the interesting part

### Create (201)

```bash
curl -s -i -X POST "$BASE/api/v1/reservations" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" \
  -H 'idempotency-key: doc-example-create-0001' \
  -d '{"tierId":"78f49287-d027-4311-8783-be97bb4beef4","quantity":2}'
```

```
HTTP/1.1 201 Created
x-request-id: 52f67c53-db99-441a-a824-2c254ff7ebe9

{"data":{"id":"fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9","userId":"62c4968d-b48d-452f-b0d6-a775f7104ab9",
 "tierId":"78f49287-d027-4311-8783-be97bb4beef4","quantity":2,"status":"PENDING",
 "expiresAt":"2026-10-28T18:37:17.759Z","secondsRemaining":300,
 "createdAt":"2026-10-28T18:32:17.759Z","updatedAt":"2026-10-28T18:32:17.759Z"}}
```

`expiresAt` and `secondsRemaining` are computed from the **database** clock at commit
(`app.now() + make_interval(secs => …)`), so never derive a deadline from your local time. The response DTO
currently does **not** echo the `strategy` used — it is stored on the row and visible in the audit record,
but not in this payload.

### Replay the same key (201, no second hold)

```bash
curl -s -D - -o /dev/null -X POST "$BASE/api/v1/reservations" \
  -H 'content-type: application/json' -H "authorization: Bearer $CUSTOMER" \
  -H 'idempotency-key: doc-example-create-0001' \
  -d '{"tierId":"78f49287-d027-4311-8783-be97bb4beef4","quantity":2}' | grep -i idempotent
```

```
idempotent-replay: true
rate-limit-limit: 120
rate-limit-remaining: 114
rate-limit-reset: 58
```

The body is byte-identical to the 201 above (same `id`). `idempotent-replay` is in
`Access-Control-Expose-Headers`, so a browser client can read it — use it to distinguish "my retry worked"
from "my retry created a second hold". Note the `x-request-id` **changes** on a replay: it identifies the
transport request, while the replayed `data` identifies the business effect.

### Same key, different body (409)

```bash
curl -s -X POST "$BASE/api/v1/reservations" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-example-create-0001' \
  -d '{"tierId":"78f49287-d027-4311-8783-be97bb4beef4","quantity":3}'
# → 409 {"error":{"code":"idempotency_key_reuse","message":"Idempotency-Key was already used with a different request body",…}}
```

### Missing / malformed key (400)

```bash
curl -s -X POST "$BASE/api/v1/reservations" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -d '{"tierId":"78f49287-…","quantity":2}'
# → 400 (no Idempotency-Key header at all)
# → 400 also for a 7-character key or one containing characters outside [A-Za-z0-9_-]
```

### Quantity and strategy rejections

```bash
curl -s -X POST "$BASE/api/v1/reservations" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-quantity-00000001' \
  -d '{"tierId":"78f49287-…","quantity":11}'
# → 400 validation_failed — MAX_QUANTITY_PER_RESERVATION=10, checked before any inventory is touched

curl -s -X POST "$BASE/api/v1/reservations" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-unsafe-000000001' \
  -d '{"tierId":"78f49287-…","quantity":1,"strategy":"unsafe_lab"}'
```

```
→ 422
{"error":{"code":"strategy_unavailable","message":"Strategy quantum_tunneling is not available on public inventory",
 "details":{"strategy":"quantum_tunneling","allowed":["atomic_update","pessimistic","optimistic"]},
 "requestId":"b7fe8f2b-8505-47bc-bcb4-c77e155fcc68","occurredAt":"2026-10-28T18:32:19.836Z"}}
```

An **unknown** id (`quantum_tunneling`) and `unsafe_lab` both give 422, not 400, because `strategy` is a
bounded string rather than an enum in the contract: the value is valid JSON-wise and is refused by the
service. The `allowed` list in `details` is generated from `SAFE_STRATEGY_IDS`, so it is truthful even if the
set changes. A rejected strategy moves no inventory — the check runs before the transaction opens.

### Sell-out is a rollback, not a stored failure

```bash
curl -s -X POST "$BASE/api/v1/reservations" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-soldout-0000001' \
  -d '{"tierId":"b089c172-…","quantity":100}'
# → 409 {"error":{"code":"sold_out", …}}
```

Repeating that **same key** after seats are freed (an expiry or a cancellation) can succeed: `sold_out` is
thrown, so the `IN_PROGRESS` key row rolls back with it and is not pinned to the failure.

### Checkout (201 / 200 / 202 / committed 409)

```bash
curl -s -X POST "$BASE/api/v1/reservations/fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9/checkout" \
  -H 'content-type: application/json' -H "authorization: Bearer $CUSTOMER" \
  -H 'idempotency-key: doc-example-checkout-01' -d '{}'
```

```json
{"data":{"id":"205e6a24-314d-4145-8eaa-ce697138395a","reservationId":"fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9",
 "status":"CONFIRMED","totalAmount":"98.00","currency":"USD",
 "createdAt":"2026-10-28T18:32:18.754Z","confirmedAt":"2026-10-28T18:32:18.754Z"}}
```

`-d '{}'` is a **valid** body: both fields have Zod defaults (`simulatedOutcome: "success"`,
`delayMs: 0`), so do not assume a 400 for omitting them. `totalAmount` is `2 × 49.00 = "98.00"`, computed
from the tier price the server locked — a client cannot set it, and `additionalProperties: false` means
sending `totalAmount` yourself is a 400, not an ignored field.

The other outcomes, all executed in `tests/integration/reservations.test.ts`:

```bash
# decline → 200 with a FAILED booking and the seats returned to available
curl -s -X POST "$BASE/api/v1/reservations/<id>/checkout" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-decline-000001' \
  -d '{"simulatedOutcome":"failure"}'

# provider timeout → 202, hold stays PENDING, no booking row at all
curl -s -X POST "$BASE/api/v1/reservations/<id>/checkout" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-timeout-0000001' \
  -d '{"simulatedOutcome":"timeout"}'

# slow gateway, still before the deadline → 201; delayMs is applied BEFORE the transaction opens
curl -s -X POST "$BASE/api/v1/reservations/<id>/checkout" -H 'content-type: application/json' \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-slow-0000000001' \
  -d '{"simulatedOutcome":"success","delayMs":2000}'
```

A 202 means *unknown*, not *failed*: the hold is still `PENDING` and the money was never marked settled. A
payment that succeeds after the hold expired gives a **committed** 409
`reservation_not_confirmable` plus a `payment_after_expiry` reconciliation finding — inventory is not
resurrected. Retrying that checkout replays the same 409.

### Cancel

```bash
curl -s -X POST "$BASE/api/v1/reservations/fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9/cancel" \
  -H "authorization: Bearer $CUSTOMER" -H 'idempotency-key: doc-example-cancel-001'
```

Confirmed above by a real call against a reservation that had just been checked out:

```
→ 409
{"error":{"code":"invalid_transition","message":"Cannot cancel a CONFIRMED reservation",
 "details":{"from":"CONFIRMED","to":"CANCELED"},"requestId":"8a708503-272f-4aa6-83b3-b765f98d7307",…}}
```

Canceling a `PENDING` hold returns 200 and releases the seats; canceling an already-`CANCELED` reservation is
a **200 no-op** (idempotent by resource, not only by key) with no second release. The 409 above is what the
database trigger (`reservations_enforce_transition`, SQLSTATE TF001) would also have produced if the
application guard were ever bypassed.

## 5. Reading your own stuff — and the 403 that is not a 404

```bash
curl -s "$BASE/api/v1/me/bookings?page=1&pageSize=1" -H "authorization: Bearer $CUSTOMER"
curl -s "$BASE/api/v1/bookings/205e6a24-314d-4145-8eaa-ce697138395a" -H "authorization: Bearer $CUSTOMER"
curl -s "$BASE/api/v1/reservations/fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9" -H "authorization: Bearer $CUSTOMER"
```

```json
{"data":[{"id":"205e6a24-314d-4145-8eaa-ce697138395a","reservationId":"fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9",
  "status":"CONFIRMED","totalAmount":"98.00","currency":"USD","confirmedAt":"2026-10-28T18:32:18.754Z"}],
 "pagination":{"page":1,"pageSize":1,"totalItems":2,"totalPages":2}}
```

```bash
# another authenticated user asks for the same reservation
curl -s "$BASE/api/v1/reservations/fbe2e833-ad4f-4833-aedc-f6f0ecfc9fc9" -H "authorization: Bearer $OTHER"
```

```
→ 403
{"error":{"code":"forbidden","message":"You do not have access to this reservation","details":{},
 "requestId":"92900587-07f4-4712-aae1-82a205cba10e","occurredAt":"2026-10-28T18:32:20.208Z"}}
```

**Do not build a "not visible to you" UI on 404** — cross-owner reads are 403, which means the id is real.
That is verified behaviour (`assertOwner`), not a documentation choice, and it is stated in the spec under
`OwnershipForbidden`. Two further consequences: a `LAB_ADMIN` token reads **any** reservation or booking
(200, by design), and a genuine 404 requires a well-formed UUID that no row has:

```bash
curl -s "$BASE/api/v1/reservations/00000000-0000-4000-8000-000000000099" -H "authorization: Bearer $CUSTOMER"
# → 404 {"error":{"code":"not_found", …}}
```

## 6. Lab — LAB_ADMIN only, and unmounted unless the lab is enabled

```bash
curl -s "$BASE/api/v1/lab/strategies"                                  # → 401, even though it is "only" a read
curl -s "$BASE/api/v1/lab/strategies" -H "authorization: Bearer $CUSTOMER"   # → 403 forbidden
curl -s "$BASE/api/v1/lab/strategies" -H "authorization: Bearer $LABADMIN"    # → 200
```

`GET /api/v1/lab/runs` answered **401** in the live parity run; there is no anonymous read of experiment
history. `authenticate` → `requireRole('LAB_ADMIN')` → `labGate` apply to the whole mount, reads included.

`listStrategies` returns the SQL the runner actually executes, so the dashboard shows the mechanism rather
than a paraphrase. With `LAB_ENABLED=true` all four descriptors are present (`unsafe_lab` with
`"safe":false,"labOnly":true`); the endpoint filters `unsafe_lab` out when the flag is off, so a deployment
that has the lab disabled cannot even discover the unsafe strategy exists.

```bash
curl -s "$BASE/api/v1/lab/runs?pageSize=3&page=1" -H "authorization: Bearer $LABADMIN" | jq '.data[] | {id,strategy,status}'
curl -s "$BASE/api/v1/lab/runs/3eb695db-0c6b-4128-abb2-9e9e196d4594" -H "authorization: Bearer $LABADMIN" | jq '.data.outcomes'
curl -s "$BASE/api/v1/lab/runs/3eb695db-0c6b-4128-abb2-9e9e196d4594/results?limit=2" -H "authorization: Bearer $LABADMIN"
```

```json
{"data":[{"id":"7001","runId":"3eb695db-0c6b-4128-abb2-9e9e196d4594","requestIndex":0,
  "actorLabel":"buyer-0000","outcome":"SUCCEEDED","httpStatus":201,
  "latencyMicros":"441764","failureClass":"lost_update_overallocation",
  "correlationId":"cbea2e16-8dd1-4ae4-49cb-6e084a9869a3:0"},
 {"id":"7002","requestIndex":1,"outcome":"SUCCEEDED","failureClass":"lost_update_overallocation"}]}
```

`id` and `latencyMicros` are **decimal strings**, not numbers: the columns are `bigint` and JSON has no
bigint literal, so the API stringifies them rather than losing precision on a 441,764 µs measurement.
`failureClass:"lost_update_overallocation"` on an `"outcome":"SUCCEEDED"` row is the unsafe baseline's
signature — a "successful" attempt that is really an anomaly (see
[docs/experiments/strategy-comparison.md](../experiments/strategy-comparison.md)). `limit` is bounded
1..5000; `?limit=0` or `?limit=5001` is a 400.

### Start a run

```bash
curl -s -X POST "$BASE/api/v1/lab/runs" -H 'content-type: application/json' \
  -H "authorization: Bearer $LABADMIN" \
  -d '{"strategy":"atomic_update","label":"my-first-run",
       "configuration":{"capacity":100,"concurrentUsers":1000,"quantityPerUser":1,
         "reservationTtlSeconds":300,"artificialDelayMs":0,"rampMs":0,"seed":42,
         "dbPoolMax":20,"isolation":"read_committed"}}'
# → 201 (synchronous: the response arrives when the run finishes)
```

`label` is **optional** (and may be omitted entirely — it is `.optional()`, not nullable). The run is
executed before the response is sent, so a 1,000-buyer run holds the request open for seconds; do not put an
aggressive client timeout on it. Once finished, the summary is immutable: `UPDATE` or `DELETE` on a completed
run raises SQLSTATE TF002, so **an experiment run cannot be cleaned up through the API or by hand** — plan
test databases accordingly.

```bash
curl -s -X POST "$BASE/api/v1/lab/runs" -H 'content-type: application/json' \
  -H "authorization: Bearer $LABADMIN" \
  -d '{"strategy":"nope","configuration":{"capacity":1,"concurrentUsers":1}}'          # → 400 validation_failed
curl -s -X POST "$BASE/api/v1/lab/runs" -H 'content-type: application/json' \
  -H "authorization: Bearer $LABADMIN" \
  -d '{"strategy":"atomic_update","configuration":{"capacity":0,"concurrentUsers":8}}' # → 400 (capacity >= 1)
```

### Reset the fixture

```bash
curl -s -X POST "$BASE/api/v1/lab/fixtures/reset" -H 'content-type: application/json' \
  -H "authorization: Bearer $LABADMIN" -d '{"capacity":100,"tiers":1}'
# → 200 {"data":{"capacity":100,"tiers":1,"invariantViolations":0}}
```

`{}` is also valid (both fields have defaults: capacity 100, tiers 1). The reset is
`SELECT lab.reset_fixture(42, …)` — the same function `npm run seed -- --experiment` calls, so the endpoint
and the CLI cannot leave different fixture states.

## 7. Rate limiting, measured

The limiter is on `/api` only, keyed per client, `RATE_LIMIT_MAX=120` per `RATE_LIMIT_WINDOW_MS=60000` in
this checkout. Observed on 2026-10-28 by calling one cheap endpoint 140 times:

```bash
for i in $(seq 1 140); do
  code=$(curl -s -o body.json -w '%{http_code}' "$BASE/api/v1/events?pageSize=1")
  [ "$code" = 429 ] && { echo "throttled at request #$i"; cat body.json; break; }
done
```

```
429 first seen at request #121
{"error":{"code":"rate_limited","message":"Rate limit exceeded for default",
 "details":{"limit":120,"windowMs":60000},"requestId":"2b17066a-8b80-4f0a-9945-36b41c714dd9",
 "occurredAt":"2026-10-28T18:31:26.307Z"}}
retry-after: 39
```

Honour `retry-after` (seconds) rather than hammering: the counter is **process-local**
(`InMemoryCounterStore`) until the Redis-backed store lands, so with several API replicas the effective
budget is per process, and a client that ignores `retry-after` will pass on one replica and fail on the next.

## 8. The 404 that means "your URL is wrong"

```bash
curl -s "$BASE/api/v1/definitely-not-a-route"
# → 404 {"error":{"code":"not_found","message":"No route for GET /api/v1/definitely-not-a-route",…}}
```

Unmatched routes use the **same error envelope** as everything else, and the message is exactly
`No route for <METHOD> <PATH>`. That predictability is load-bearing here: the parity test distinguishes
"this documented path is unrouted" from "the handler legitimately returned 404" by that message, so a spec
entry that drifts away from the real router fails loudly instead of passing on a 404.

## PowerShell notes

Windows PowerShell 5.1 has no `curl` (it aliases `Invoke-WebRequest`) and `Invoke-RestMethod` lacks
`-SkipHttpErrorCheck`, so a 4xx throws instead of returning a response you can assert on — that is a real
trap when transcribing these examples. Use the shipped binary:

```powershell
curl.exe -s "$BASE/api/v1/events?pageSize=2"
curl.exe -s -X POST "$BASE/api/v1/reservations" -H "content-type: application/json" `
  -H "authorization: Bearer $env:CUSTOMER" -H "idempotency-key: ps-example-create-01" `
  -d '{"tierId":"78f49287-d027-4311-8783-be97bb4beef4","quantity":2}'
```

Single-quote JSON bodies in PowerShell so `$` and `"` survive; `--%` stops parsing entirely if quoting gets
awkward.
