import express, { type Express } from 'express';
import type { AppConfig } from '@ticketflow/config';
import type { Database } from './db/pool.js';
import type { Logger } from './observability/logger.js';
import { appMetrics } from './observability/metrics.js';
import { bindLogger, requestContext } from './middleware/request-context.js';
import { httpMetrics } from './middleware/metrics.js';
import { securityMiddlewares } from './middleware/security.js';
import { createRateLimiter, InMemoryCounterStore } from './middleware/rate-limit.js';
import { authenticate, requireRole } from './middleware/authenticate.js';
import { labGate, isLabEnabled } from './middleware/lab-gate.js';
import { createErrorHandler, notFoundHandler } from './middleware/errors.js';
import { createHealthRouter } from './modules/health/routes.js';
import { createEventsRouter } from './modules/events/routes.js';
import { EventsRepository } from './modules/events/repository.js';
import { EventsService } from './modules/events/service.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createLabRouter } from './modules/experiments/routes.js';
import { LabService } from './modules/experiments/service.js';
import { createReservationsRouter } from './modules/reservations/routes.js';
import { ReservationsService } from './modules/reservations/service.js';
import { createBookingsRouter, createMeBookingsRouter } from './modules/bookings/routes.js';
import { BookingsService } from './modules/bookings/service.js';

/**
 * The Express app, assembled by factory — no module-level singletons — so integration tests can
 * build an isolated instance against a real database without a listening socket (Supertest).
 *
 * Middleware order is load-bearing and deliberately boring:
 *   correlation id + logger → metrics → security (helmet/CORS/body) → routes → 404 → error handler.
 * `/health/*` and `/metrics` sit outside the rate limiter: scrapers and orchestrators must never
 * be throttled into a false outage signal.
 */

export interface AppDependencies {
  config: AppConfig;
  db: Database;
  logger: Logger;
  /** Wired into `/health/ready` once the Redis client lands (Phase 4); absence reports `skipped`. */
  pingRedis?: () => Promise<boolean>;
  version?: string;
}

const API_VERSION = 'v1';

export function createApp(deps: AppDependencies): Express {
  const { config, db, logger } = deps;
  const version = deps.version ?? '0.1.0';

  const app = express();
  app.disable('x-powered-by');
  app.locals.config = config;
  app.set('trust proxy', false); // local lab: never trust spoofable X-Forwarded-* headers

  app.use(requestContext);
  app.use(bindLogger(logger));
  app.use(httpMetrics);
  app.use(securityMiddlewares(config));

  // Liveness answers even when PostgreSQL is down; readiness is the one that gates traffic.
  app.use('/health', createHealthRouter({ db, version, ...(deps.pingRedis ? { pingRedis: deps.pingRedis } : {}) }));

  if (config.METRICS_ENABLED) {
    app.get('/metrics', (_req, res) => {
      res.setHeader('content-type', appMetrics.contentType());
      void appMetrics.metricsText().then((text) => res.end(text));
    });
  }

  // The counter store is process-local until Phase 4 swaps in a Redis-backed implementation;
  // the README states this limitation instead of implying cluster-safe throttling.
  const counterStore = new InMemoryCounterStore();
  app.locals.rateLimitStore = counterStore;

  const api = express.Router();
  api.use(createRateLimiter(config, counterStore));
  api.use(`/${API_VERSION}/events`, createEventsRouter(new EventsService(new EventsRepository(db))));

  // Reservation + booking endpoints are core customer functionality (always mounted, unlike the lab
  // routers), but every one is behind `authenticate` — an unauthenticated caller never reaches the
  // allocation logic. These use concrete sub-prefixes so the `api`-level 404 still answers `/api/v1/*`
  // paths that match nothing here.
  const requireAuth = authenticate(config, true);
  const reservationsService = new ReservationsService(db, config, logger);
  const bookingsService = new BookingsService(db);
  api.use(`/${API_VERSION}/reservations`, requireAuth, createReservationsRouter(reservationsService));
  api.use(`/${API_VERSION}/bookings`, requireAuth, createBookingsRouter(bookingsService));
  api.use(`/${API_VERSION}/me`, requireAuth, createMeBookingsRouter(bookingsService));

  if (isLabEnabled(config)) {
    // Local demo token exchange (spec-sanctioned test tokens); the browser session mechanism
    // replaces it in Phase 5 behind the same `req.user` contract.
    api.use(`/${API_VERSION}/auth`, createAuthRouter(db, config));
    api.use(
      `/${API_VERSION}/lab`,
      authenticate(config, true),
      requireRole('LAB_ADMIN'),
      labGate,
      createLabRouter(new LabService(db, config, logger)),
    );
  }

  app.use('/api', api);

  // 404 inside `/api/v1` also carries the standard envelope, so clients parse one shape everywhere.
  app.use(notFoundHandler);
  app.use(createErrorHandler(config));

  // Anything that reached the app before routing (e.g. malformed URL) still gets a correlation id.
  app.set('etag', false);

  return app;
}
