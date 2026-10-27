import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { bootstrapConfig, ConfigError, type AppConfig } from '@ticketflow/config';
import pino from 'pino';

/**
 * Worker process entry point (Phase 1 skeleton).
 *
 * The API and the worker are separate processes on purpose: a queue-backlogged or crash-looping
 * consumer must never take the booking HTTP path down with it. Phase 4 replaces the placeholders
 * below with BullMQ consumers (expiration notifications, outbox delivery, fake notifications,
 * reconciliation sweepers) — the contract established now is:
 *
 * - the worker reads the same validated environment as the API;
 * - it touches PostgreSQL only through `pg` with explicit parameterized SQL;
 * - it writes a heartbeat file that the container healthcheck watches (compose: `/tmp/worker-heartbeat`),
 *   so "process alive" and "loop progressing" are distinguishable;
 * - shutdown drains poll loops before closing the pool (no half-processed jobs claimed).
 */

const HEARTBEAT_PATH = process.env.TF_WORKER_HEARTBEAT ?? '/tmp/worker-heartbeat';
const HEARTBEAT_INTERVAL_MS = 10_000;

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
      // Best effort: a failing heartbeat write must not kill the loop, but it must be visible.
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

  beat();
  const heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  log.info(
    { queues: [], note: 'BullMQ consumers arrive in Phase 4; skeleton pings DB and heartbeats only' },
    'worker started',
  );

  const shutdown = (signal: string): void => {
    if (draining) return;
    draining = true;
    log.info({ signal }, 'worker draining');
    clearInterval(heartbeatTimer);
    // Phase 4: stop BullMQ workers here (graceful) and wait for active jobs before closing the pool.
    void pool
      .end()
      .then(() => log.info('worker shutdown complete'))
      .catch((error: unknown) => {
        log.error({ err: error }, 'error closing pool');
        process.exitCode = 1;
      });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

void main();
