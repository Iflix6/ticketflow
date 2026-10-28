import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { bootstrapConfig, ConfigError } from '@ticketflow/config';
import { createApp } from './app.js';
import { bindPoolMetrics, createDatabase } from './db/pool.js';
import { createLogger } from './observability/logger.js';
import { makeRedisProbe } from './redis-probe.js';

/**
 * API process entry point.
 *
 * Startup order is a fail-fast chain: validated environment → logger → pool → app → listen.
 * A misconfigured variable must kill the process before it can serve a single request, because
 * half-configured booking behaviour is worse than no booking behaviour.
 *
 * Shutdown: stop accepting connections, drain in-flight requests, then close the pool. The
 * forced-exit timer exists because a hung keep-alive socket must not turn a deploy into a stall.
 */

const SHUTDOWN_TIMEOUT_MS = 10_000;

function main(): void {
  let config;
  try {
    config = bootstrapConfig();
  } catch (error) {
    if (error instanceof ConfigError) process.exitCode = 1; // report already printed
    else throw error;
    return;
  }

  const logger = createLogger(config);
  const db = createDatabase(config);
  const poolMetricsTimer = bindPoolMetrics(db);

  // Redis is advisory for readiness (ADR-0002/0005): the probe reflects reachability without pulling
  // the queue client into the API, and its absence degrades `/health/ready` rather than failing it.
  const app = createApp({ config, db, logger, pingRedis: makeRedisProbe(config.REDIS_URL) });
  const server = http.createServer(app);

  server.listen(config.PORT, config.HOST, () => {
    const address = server.address() as AddressInfo;
    // `environment` is already a logger base binding; repeating it here produced a duplicate key.
    logger.info({ port: address.port, labEnabled: config.LAB_ENABLED }, 'api listening');
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('shutdown exceeded deadline; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    server.close((error) => {
      if (error !== undefined) logger.error({ err: error }, 'error while closing http server');
      clearInterval(poolMetricsTimer);
      void db
        .close()
        .then(() => logger.info('shutdown complete'))
        .catch((closeError: unknown) => {
          logger.error({ err: closeError }, 'error closing pool');
          process.exitCode = 1;
        })
        .finally(() => {
          // Exit explicitly once drained: a lingering handle (a supervisor's IPC channel, a
          // keep-alive socket, a non-unref'd timer) must not keep an already-drained process alive.
          // The forced-exit timer above remains the safety net if close() itself wedges.
          process.exit(process.exitCode ?? 0);
        });
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // An escalated second signal skips the drain: operators need an out when a request is wedged.
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  // IPC shutdown for supervisors and the boot-smoke gate. Windows cannot deliver a graceful signal
  // to a spawned child reliably (SIGTERM maps to TerminateProcess, which skips handlers), so an IPC
  // message is the portable, deterministic way to exercise the drain path. It is inert in production:
  // the handler only fires if a parent opened an IPC channel, which `node server.js` under Docker/CI
  // never does on its own.
  process.on('message', (message: unknown) => {
    if (message === 'graceful-shutdown') shutdown('ipc:graceful-shutdown');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
    process.exitCode = 1;
  });
}

main();
