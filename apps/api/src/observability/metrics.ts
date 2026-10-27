import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics.
 *
 * Cardinality rule (spec): labels are bounded enums only — `route` is the Express *template*
 * (`/api/v1/reservations/:id`), never a concrete path, and no metric carries user id, booking id or
 * request id. Unbounded labels turn a dashboard into a memory leak.
 */

const DURATION_BUCKETS_SECONDS = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

export class AppMetrics {
  readonly registry = new Registry();

  readonly httpRequestsTotal = new Counter({
    name: 'ticketflow_http_requests_total',
    help: 'Completed HTTP requests by method, route template and status class.',
    labelNames: ['method', 'route', 'status_class'] as const,
    registers: [this.registry],
  });

  readonly httpRequestDuration = new Histogram({
    name: 'ticketflow_http_request_duration_seconds',
    help: 'End-to-end HTTP request duration.',
    labelNames: ['method', 'route'] as const,
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [this.registry],
  });

  readonly transactionDuration = new Histogram({
    name: 'ticketflow_transaction_duration_seconds',
    help: 'Database transaction duration by logical label and commit outcome.',
    labelNames: ['label', 'outcome'] as const,
    buckets: DURATION_BUCKETS_SECONDS,
    registers: [this.registry],
  });

  readonly retries = new Counter({
    name: 'ticketflow_tx_retries_total',
    help: 'Transient PostgreSQL errors that triggered a bounded retry.',
    labelNames: ['label', 'code'] as const,
    registers: [this.registry],
  });

  readonly retriesExhausted = new Counter({
    name: 'ticketflow_tx_retries_exhausted_total',
    help: 'Operations that failed after consuming the retry budget.',
    labelNames: ['label'] as const,
    registers: [this.registry],
  });

  readonly poolConnections = new Gauge({
    name: 'ticketflow_pg_pool_connections',
    help: 'pg.Pool utilisation sampled every 2s.',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  readonly poolErrors = new Counter({
    name: 'ticketflow_pg_pool_errors_total',
    help: 'Idle-client errors surfaced by the pool.',
    labelNames: ['phase'] as const,
    registers: [this.registry],
  });

  readonly reservationOutcomes = new Counter({
    name: 'ticketflow_reservation_outcomes_total',
    help: 'Reservation attempts by strategy and outcome (application rejections separated from faults).',
    labelNames: ['strategy', 'outcome'] as const,
    registers: [this.registry],
  });

  readonly idempotencyOutcomes = new Counter({
    name: 'ticketflow_idempotency_outcomes_total',
    help: 'Idempotency key acquisitions.',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly outboxUnpublished = new Gauge({
    name: 'ticketflow_outbox_unpublished',
    help: 'Outbox rows awaiting publication (backlog depth).',
    registers: [this.registry],
  });

  readonly outboxOldestAgeSeconds = new Gauge({
    name: 'ticketflow_outbox_oldest_age_seconds',
    help: 'Age of the oldest unpublished outbox event.',
    registers: [this.registry],
  });

  readonly jobRetries = new Counter({
    name: 'ticketflow_worker_job_retries_total',
    help: 'BullMQ job attempts beyond the first.',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });

  readonly invariantViolations = new Gauge({
    name: 'ticketflow_inventory_invariant_violations',
    help: 'Rows returned by each invariant view; must be 0 for safe strategies.',
    labelNames: ['invariant'] as const,
    registers: [this.registry],
  });

  readonly lockWaitsMs = new Histogram({
    name: 'ticketflow_pg_lock_wait_ms',
    help: 'Observed lock waits sampled from pg_stat_activity.',
    labelNames: ['locktype'] as const,
    buckets: [0, 1, 5, 20, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [this.registry],
  });

  readonly experimentRequests = new Counter({
    name: 'ticketflow_experiment_requests_total',
    help: 'Requests generated inside a lab experiment run.',
    labelNames: ['strategy', 'outcome'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      // Node event-loop lag and GC are the two process metrics that actually explain booking tails.
      prefix: 'ticketflow_',
    });
  }

  async metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  /** Tests reset counters so assertions describe the current run only. */
  clear(): void {
    this.registry.clear();
  }
}

/** Process-wide metrics instance; imported by middleware, services, repositories and the worker. */
export const appMetrics = new AppMetrics();
