import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { bootstrapConfig, ConfigError, type AppConfig } from '@ticketflow/config';
import pino from 'pino';
import { relayOnce } from './outbox.js';
import { sweepExpiries } from './expiry.js';
import { reconcile, resolveStaleFindings } from './reconciliation.js';
import { BullMQDispatcher, createQueues, redisOptionsFromUrl, startWorkers } from './queues.js';

/**
 * Worker process entry point (Phase 4 — real consumers, replacing the Phase-1 skeleton).
 *
 * Four cooperating loops, each independently safe:
 *  - the outbox RELAY turns unpublished `outbox_events` rows into queue jobs (restart-safe);
 *  - BullMQ WORKERS consume them idempotently (duplicate-safe) and run the expiry fast path;
 *  - the expiry SWEEPER is the correctness path that expires overdue holds regardless of the queue;
 *  - RECONCILIATION surfaces stuck backlog and counter drift as findings, without mutating inventory.
 *
 * PostgreSQL is required (no DB → exit for the supervisor to retry, exactly as before). Redis is
 * ADVISORY: if it is down the relay records dispatch errors and the backlog grows, but the process
 * keeps serving the DB-only paths and the sweeper still enforces expiry (ADR-0005 degradation matrix).
 */

const HEARTBEAT_PATH = process.env.TF_WORKER_HEARTBEAT ?? '/tmp/worker-heartbeat';
const HEARTBEAT_INTERVAL_MS = 10_000;
// An event older than this without publication means the relay is not keeping up (Redis down/backlog).
const OUTBOX_STUCK_THRESHOLD_SECONDS = 60;

function createLogger(config: AppConfig): pino.Logger {
  return pino({
    name: 'ticketflow-worker',
    level: config.LOG_LEVEL,
    base: { environment: config.NODE_ENV },
    redact: { paths: ['DATABASE_URL', 'REDIS_URL', 'AUTH_SECRET'], censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

async function main(): Promise<void> {
  let config;
  try {
    config = bootstrapConfig();
  } catch (error) {
    if (error instanceof ConfigError) process.exitCode = 1;
    else throw error;
    return;
  }

  const log = createLogger(config);
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 5, // the worker is a poller, not a web server: a small pool keeps headroom for the API
    idleTimeoutMillis: config.PG_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
    application_name: `ticketflow-worker-${config.NODE_ENV}`,
  });

  let draining = false;
  const beat = (): void => {
    try {
      writeFileSync(HEARTBEAT_PATH, String(Date.now()));
    } catch (error) {
      log.warn({ err: error, path: HEARTBEAT_PATH }, 'heartbeat write failed');
    }
  };

  try {
    const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    if ((rows[0]?.ok ?? 0) !== 1) throw new Error('database probe returned unexpected shape');
  } catch (error) {
    log.error({ err: error }, 'worker cannot reach PostgreSQL; exiting for the supervisor to retry');
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  // Redis is advisory: build the queue topology, but a connection failure degrades rather than crashes.
  const connection = redisOptionsFromUrl(config.REDIS_URL);
  const queues = createQueues(connection, config.JOB_MAX_ATTEMPTS);
  const dispatcher = new BullMQDispatcher(queues.dispatch);
  const workers = startWorkers(queues, connection, pool, {
    concurrency: config.WORKER_CONCURRENCY,
    maxAttempts: config.JOB_MAX_ATTEMPTS,
    log: (msg, ctx) => log.info(ctx ? { ...ctx } : {}, msg),
  });
  log.info({ redis: config.REDIS_URL.replace(/\/\/.*@/, '//***@') }, 'queue topology created');

  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  const relayTimer = setInterval(() => {
    if (draining) return;
    void relayOnce(pool, dispatcher, { batchSize: config.OUTBOX_BATCH_SIZE })
      .then((result) => {
        if (result.claimed > 0) log.debug(result, 'outbox relay tick');
      })
      .catch((error: unknown) => log.error({ err: error }, 'outbox relay tick failed'));
  }, config.OUTBOX_POLL_MS);

  const sweeperTimer = setInterval(() => {
    if (draining) return;
    void (async () => {
      const expired = await sweepExpiries(pool);
      if (expired > 0) log.info({ expired }, 'sweeper expired overdue holds');
      const findings = await reconcile(pool, { stuckThresholdSeconds: OUTBOX_STUCK_THRESHOLD_SECONDS });
      if (findings.outboxStuck > 0 || findings.counterMismatch > 0) log.warn(findings, 'reconciliation findings');
      await resolveStaleFindings(pool);
    })().catch((error: unknown) => log.error({ err: error }, 'sweeper/reconcile tick failed'));
  }, config.SWEEPER_INTERVAL_MS);

  log.info(
    { queues: ['outbox-dispatch', 'reservation-expiry'], pollMs: config.OUTBOX_POLL_MS, sweepMs: config.SWEEPER_INTERVAL_MS },
    'worker started',
  );

  const shutdown = (signal: string): void => {
    if (draining) return;
    draining = true;
    log.info({ signal }, 'worker draining');
    clearInterval(heartbeatTimer);
    clearInterval(relayTimer);
    clearInterval(sweeperTimer);
    // Close consumers BEFORE queues/pool so no job is claimed after we stop accepting new work; BullMQ
    // `close()` waits for active jobs to finish, so a half-processed job never leaves a stale claim.
    void Promise.all([workers.close(), queues.close()])
      .then(() => pool.end())
      .then(() => log.info('worker shutdown complete'))
      .catch((error: unknown) => {
        log.error({ err: error }, 'error during shutdown');
        process.exitCode = 1;
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

void main();
