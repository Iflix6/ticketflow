import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { bootstrapConfig, ConfigError } from '@ticketflow/config';
import { createApp } from './app.js';
import { bindPoolMetrics, createDatabase } from './db/pool.js';
import { createLogger } from './observability/logger.js';

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

  const app = createApp({ config, db, logger });
  const server = http.createServer(app);

  server.listen(config.PORT, config.HOST, () => {
    const address = server.address() as AddressInfo;
    logger.info(
      { port: address.port, environment: config.NODE_ENV, labEnabled: config.LAB_ENABLED },
      'api listening',
    );
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
        });
    });
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // An escalated second signal skips the drain: operators need an out when a request is wedged.
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'unhandled rejection');
    process.exitCode = 1;
  });
}

main();
