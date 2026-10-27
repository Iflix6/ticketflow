# Sequence Diagrams

## 1. Reserve (safe strategy A) with idempotency and outbox

```mermaid
sequenceDiagram
    participant C as Client (web / k6)
    participant A as api (Express)
    participant I as idempotency module
    participant R as reservations service
    participant P as pg.Pool
    participant G as PostgreSQL

    C->>A: POST /api/v1/reservations (Idempotency-Key, {tierId, quantity})
    A->>A: Zod parse + authn + rate limit + request id
    A->>P: withTransaction() -> acquire ONE client
    P->>G: BEGIN; SET statement_timeout/lock_timeout
    A->>I: acquire(scope,user,key,hash)
    I->>G: INSERT idempotency_records ... state='IN_PROGRESS' ON CONFLICT DO NOTHING RETURNING
    alt key already COMPLETED, same hash
        I-->>A: replay stored status/body
        A-->>C: 201 (Idempotent-Replay: true)
    else key in progress
        A-->>C: 409 idempotency_in_progress + Retry-After
    else new key
        A->>R: reserve(client, tierId, qty)
        R->>G: UPDATE inventory SET available=available-$q, reserved=reserved+$q, version=version+1<br/>WHERE tier_id=$id AND available>=$q RETURNING ...
        alt zero rows returned
            R-->>A: SOLD_OUT
            A->>G: ROLLBACK (idempotency record discarded with the tx)
            A-->>C: 409 sold_out
        else row updated
            R->>G: INSERT reservations(status='PENDING', expires_at = now()+TTL)
            R->>G: INSERT outbox_events('reservation.pending', payload)
            R->>G: UPDATE idempotency_records SET state='COMPLETED', response_* 
            A->>G: COMMIT
            A-->>C: 201 {reservationId, expiresAt}
        end
    end
    Note over A,P: client released in finally; metrics + pino log with requestId
```

## 2. Confirm (fake checkout) — atomic reserved → sold

```mermaid
sequenceDiagram
    participant C as Client
    participant A as api
    participant F as fake payment provider
    participant G as PostgreSQL

    C->>A: POST /api/v1/reservations/:id/checkout (Idempotency-Key)
    A->>G: BEGIN; SELECT reservation FOR UPDATE? no -> conditional path
    A->>F: charge(bookingIntent)  [outside tx; deterministic outcome]
    F-->>A: SUCCEEDED | FAILED | TIMEOUT
    A->>G: UPDATE reservations SET status='CONFIRMED', confirmed_at=now()<br/>WHERE id=$1 AND status='PENDING' AND expires_at > now()
    alt zero rows (expired or already terminal)
        A->>G: INSERT reconciliation_findings('payment_after_expiry' | 'illegal_transition')
        A->>G: INSERT payment_attempts(status='SUCCEEDED_NOT_FULFILLED')
        A->>G: COMMIT
        A-->>C: 409 reservation_not_confirmable (recorded for refund path)
    else updated
        A->>G: UPDATE inventory SET reserved=reserved-$q, sold=sold+$q, version=version+1 WHERE tier_id=$t
        A->>G: INSERT bookings(reservation_id UNIQUE, status='CONFIRMED')
        A->>G: INSERT payment_attempts(provider_reference UNIQUE, ...)
        A->>G: INSERT outbox_events('booking.confirmed')
        A->>G: COMMIT
        A-->>C: 200 {bookingId}
    end
```

Duplicate / out-of-order callbacks: `payment_attempts.provider_reference` is UNIQUE and booking
fulfilment is guarded by `bookings.reservation_id UNIQUE`, so a replayed success cannot create a second
booking (test `duplicate-callback`).

## 3. Expiry (worker fast path + sweeper correctness path)

```mermaid
sequenceDiagram
    participant W as worker
    participant G as PostgreSQL
    participant Q as BullMQ (Redis)
    W->>Q: delayed job reservation-expire(id) at expiresAt
    W->>G: BEGIN
    W->>G: UPDATE reservations SET status='EXPIRED'<br/>WHERE id=$1 AND status='PENDING' AND expires_at <= now()
    alt zero rows
        G-->>W: no effect (already confirmed/canceled, or clock not yet past deadline)
    else one row
        W->>G: UPDATE inventory SET available=available+$q, reserved=reserved-$q, version=version+1
        W->>G: INSERT outbox_events('reservation.expired')
        W->>G: COMMIT
    end
    Note over W,G: Sweeper repeats this set-based every N seconds using DB now(); correctness does<br/>not depend on the delayed job firing on time or Redis being up
```

## 4. Idempotent replay of a committed request

```mermaid
sequenceDiagram
    participant C as Client (retry)
    participant A as api
    participant G as PostgreSQL
    C->>A: POST /api/v1/reservations (same key, same body)
    A->>G: SELECT idempotency_records WHERE scope+key
    G-->>A: COMPLETED, request_hash matches
    A-->>C: stored status + stored body, header Idempotent-Replay: true
    Note over A,G: zero business writes; no second reservation; no inventory change
```

## 5. Outbox relay and duplicate consumption

```mermaid
sequenceDiagram
    participant G as PostgreSQL
    participant W as worker (relay)
    participant Q as BullMQ
    participant N as consumer (notifications)
    loop every OUTBOX_POLL_MS
        W->>G: SELECT ... FROM outbox_events WHERE published_at IS NULL<br/>ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $n
        W->>Q: add(event.id, payload) (jobId = event.id -> dedup key)
        W->>G: UPDATE outbox_events SET published_at=now(), attempt_count=attempt_count+1
    end
    Q-->>N: deliver (at-least-once; may duplicate after restart)
    N->>G: idempotent action guarded by state (conditional UPDATE / unique insert)
    Note over N,G: duplicate delivery is a no-op; outbox_age_seconds metric exposes backlog
```
