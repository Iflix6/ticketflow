import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type pg from 'pg';

/**
 * Worker Prometheus metrics (Phase 6).
 *
 * The worker is a SEPARATE process from the API (ADR-0001), and it owns the metrics whose data only it
 * can observe: outbox backlog/age (it runs the relay), BullMQ job retries (it hosts the consumers) and
 * database lock waits (sampled DB-wide from `pg_stat_activity`). The API already exports its own
 * `/metrics`; Prometheus scrapes both targets and the two registries never overlap.
 *
 * Cardinality rule, identical to the API's: labels are bounded enums only — a queue lane, a lock type,
 * a pool state. Never a job id, reservation id or outbox id: those turn a dashboard into a memory leak.
 */

export class WorkerMetrics {
  readonly registry = new Registry();

  readonly outboxUnpublished = new Gauge({
    name: 'ticketflow_outbox_unpublished',
    help: 'Outbox rows awaiting publication (relay backlog depth).',
    registers: [this.registry],
  });

  readonly outboxOldestAgeSeconds = new Gauge({
    name: 'ticketflow_outbox_oldest_age_seconds',
    help: 'Age in seconds of the oldest unpublished outbox event, on the DB clock.',
    registers: [this.registry],
  });

  readonly jobRetries = new Counter({
    name: 'ticketflow_worker_job_retries_total',
    help: 'BullMQ job failures that will be retried (attempts beyond the first), by queue lane.',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });

  readonly deadLetters = new Counter({
    name: 'ticketflow_worker_dead_letters_total',
    help: 'Jobs that exhausted the retry budget and were parked on a dead queue, by lane.',
    labelNames: ['queue'] as const,
    registers: [this.registry],
  });

  readonly lockWaitsMs = new Histogram({
    name: 'ticketflow_pg_lock_wait_ms',
    help: 'Observed lock waits sampled from pg_stat_activity.',
    labelNames: ['locktype'] as const,
    buckets: [0, 1, 5, 20, 50, 100, 250, 500, 1000, 2500, 5000],
    registers: [this.registry],
  });

  readonly poolConnections = new Gauge({
    name: 'ticketflow_worker_pg_pool_connections',
    help: 'Worker pg.Pool utilisation sampled alongside the relay tick.',
    labelNames: ['state'] as const,
    registers: [this.registry],
  });

  readonly ticks = new Counter({
    name: 'ticketflow_worker_ticks_total',
    help: 'Relay/sweep sampling ticks and their outcome, so a stalled loop is visible as a rate of zero.',
    labelNames: ['loop', 'outcome'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'ticketflow_worker_',
    });
  }

  metricsText(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}

export const workerMetrics = new WorkerMetrics();

/**
 * Sample DB-wide lock waits from `pg_stat_activity`. PostgreSQL 18 dropped the old `wait_time` column,
 * so the wait duration is derived from `state_change`: a backend with `wait_event_type = 'Lock'` has been
 * in its current (waiting) state since `state_change`, so `clock_timestamp() - state_change` is the elapsed
 * lock wait. This is an approximation (it measures time in the current wait state, which is exactly the
 * interval a lock convoy is stuck in), and it is labelled per lock type. Backends waiting on something
 * other than a lock are not lock contention, so they are excluded — a dashboard that counts client reads
 * as "lock waits" lies.
 */
export async function sampleLockWaits(pool: pg.Pool): Promise<void> {
  const result = await pool.query<{ locktype: string; wait_time_ms: number | null }>(
    `SELECT l.locktype,
            FLOOR(EXTRACT(EPOCH FROM (clock_timestamp() - a.state_change)) * 1000)::int AS wait_time_ms
       FROM pg_stat_activity a
       JOIN pg_locks l ON l.pid = a.pid AND NOT l.granted
      WHERE a.wait_event_type = 'Lock'`,
  );
  for (const row of result.rows) {
    if (row.wait_time_ms === null) continue;
    workerMetrics.lockWaitsMs.observe({ locktype: row.locktype }, row.wait_time_ms);
  }
}
