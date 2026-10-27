# C4 Diagrams and ERD

All diagrams are Mermaid, renderable on GitHub. They describe the implemented system; where Phase 5/6
components are not yet built they are marked *(later phase)*.

## 1. Context

```mermaid
graph TB
    subgraph Humans
        V["Visitor<br/>wants tickets"]
        E["Engineer / SRE<br/>runs experiments"]
    end
    subgraph TicketFlow["TicketFlow Reliability Lab"]
        S["TicketFlow system<br/>Node.js + PostgreSQL"]
    end
    P["Fake payment provider<br/>(deterministic, local, no funds)"]
    M["Prometheus / Grafana<br/>metrics & dashboards"]
    L["k6<br/>load generator"]

    V -->|browse, reserve, fake-pay| S
    E -->|build/run/compare experiments| S
    S -->|simulate success/failure/timeout| P
    S -->|exposes /metrics| M
    L -->|drives HTTP load (local only)| S
    E -->|reads| M
```

## 2. Containers

```mermaid
graph LR
    B["Browser"]
    W["web<br/>Next.js App Router + Tailwind<br/>:3000"]
    A["api<br/>Express 5 + TypeScript (strict)<br/>:4000"]
    K["worker<br/>BullMQ consumer<br/>outbox relay, sweeper, reconciliation"]
    PG[("PostgreSQL 18<br/>authoritative inventory")]
    RD[("Redis 7<br/>cache, rate limit, queues")]
    PR["Prometheus"]
    GR["Grafana"]
    OT["OTel collector<br/>(optional)"]

    B --> W
    W -->|REST /api/v1| A
    A -->|SQL via pg.Pool| PG
    A -->|ioredis| RD
    K -->|SQL| PG
    K -->|queues| RD
    A -->|/metrics| PR
    PR --> GR
    A -.->|traces| OT
    K -.->|traces| OT
```

## 3. Components inside `api`

```mermaid
graph TB
    R["routes/<br/>thin HTTP handlers + Zod parse"]
    MW["middleware/<br/>request-id, auth, rate-limit, lab-gate, errors, metrics"]
    SV["modules/*/service<br/>business rules + state machine + strategy choice"]
    RP["modules/*/repository<br/>parameterized SQL only"]
    DB["db/pool.ts + db/transaction.ts<br/>one client per tx, timeouts, bounded retry"]
    IDP["modules/idempotency<br/>key acquire/replay/conflict"]
    OUT["modules/outbox<br/>event insert (in-tx)"]
    EXP["modules/experiments<br/>lab runs, fixtures, results (gated)"]
    LAB["modules/lab/unsafe<br/>lab.* schema only (gated)"]
    OBS["observability/<br/>pino, prom-client, otel"]

    R --> MW --> SV --> RP --> DB
    SV --> IDP --> DB
    SV --> OUT --> DB
    EXP --> SV
    EXP --> LAB --> DB
    MW --> OBS
    SV --> OBS
```

## 4. ERD (authoritative tables)

```mermaid
erDiagram
    EVENTS ||--o{ TICKET_TIERS : "has"
    TICKET_TIERS ||--|| INVENTORY : "counters"
    APP_USERS ||--o{ RESERVATIONS : "makes"
    APP_USERS ||--o{ SESSIONS : "owns"
    TICKET_TIERS ||--o{ RESERVATIONS : "for"
    RESERVATIONS ||--o| BOOKINGS : "fulfilled by"
    BOOKINGS ||--o{ PAYMENT_ATTEMPTS : "attempted"
    APP_USERS ||--o{ IDEMPOTENCY_RECORDS : "scopes"
    RESERVATIONS ||--o{ OUTBOX_EVENTS : "emits"
    BOOKINGS ||--o{ OUTBOX_EVENTS : "emits"
    EXPERIMENT_RUNS ||--o{ EXPERIMENT_RESULTS : "contains"
    TICKET_TIERS ||--o{ RECONCILIATION_FINDINGS : "flagged"

    INVENTORY {
        uuid tier_id PK
        int capacity
        int available
        int reserved
        int sold
        int version
        timestamptz updated_at
    }
    RESERVATIONS {
        uuid id PK
        uuid user_id FK
        uuid tier_id FK
        int quantity
        string status
        timestamptz expires_at
        uuid idempotency_record_id FK
    }
    IDEMPOTENCY_RECORDS {
        uuid id PK
        uuid scope_user_id
        string scope_endpoint
        string key
        string request_hash
        string state
        int response_status
        jsonb response_body
        timestamptz expires_at
    }
    EXPERIMENT_RUNS {
        uuid id PK
        string strategy
        jsonb configuration
        timestamptz started_at
        timestamptz finished_at
        string git_sha
        string environment
        jsonb outcomes
    }
```

The `lab` schema mirrors `INVENTORY` and `RESERVATIONS` for the unsafe baseline and has no FK to
public tables (ADR-0009).

## 5. Reservation lifecycle (state view)

```mermaid
stateDiagram-v2
    [*] --> PENDING : reserve (available - q, reserved + q)
    PENDING --> CONFIRMED : fake payment success (reserved - q, sold + q)
    PENDING --> CANCELED : user cancel (reserved - q, available + q)
    PENDING --> EXPIRED : TTL elapsed (reserved - q, available + q)
    CONFIRMED --> [*]
    CANCELED --> [*]
    EXPIRED --> [*]
    FAILED --> [*]
    note right of PENDING : terminal states cannot transition; illegal\ntransitions are rejected with 409 invalid_transition
```
