import { Router } from 'express';
import type { Database } from '../../db/pool.js';
import { asyncHandler } from '../../middleware/request-context.js';
import { sendJson } from '../../shared/respond.js';
import { AppError } from '../../shared/errors.js';

/**
 * Health endpoints (spec: liveness and readiness must be distinguishable).
 *
 * - `/health/live` answers without touching any dependency: it means "the process is scheduled and
 *   the event loop is turning", which is what a restart decision needs.
 * - `/health/ready` verifies PostgreSQL with an actual query, because a rolling restart should not
 *   send traffic to a process that cannot book a ticket. Redis is advisory (ADR-0002): its absence
 *   makes readiness `degraded`, not `down`, and is reported separately so the dashboard can alert.
 */

export interface HealthDeps {
  db: Database;
  /** Provided once the worker/queue wiring lands; absence is reported as `skipped`. */
  pingRedis?: () => Promise<boolean>;
  version: string;
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  router.get('/live', (req, res) => {
    sendJson(res, 200, { status: 'ok', component: 'api', version: deps.version }, req.id);
  });

  router.get(
    '/ready',
    asyncHandler(async (req, res) => {
      const checks: Record<string, string> = {};
      let databaseOk = false;

      try {
        const result = await deps.db.query<{ ok: number }>('SELECT 1 AS ok');
        databaseOk = (result.rowCount ?? 0) === 1;
        checks.database = databaseOk ? 'ok' : 'down';
      } catch (error) {
        checks.database = 'down';
        req.log.error({ err: error }, 'readiness database probe failed');
      }

      if (deps.pingRedis) {
        try {
          checks.cache = (await deps.pingRedis()) ? 'ok' : 'degraded';
        } catch (error) {
          // Redis is advisory: a failure degrades, it does not fail readiness.
          checks.cache = 'degraded';
          req.log.warn({ err: error }, 'readiness redis probe failed (advisory dependency)');
        }
      } else {
        checks.cache = 'skipped';
      }

      if (!databaseOk) {
        throw new AppError(
          'dependency_unavailable',
          'Service is not ready to accept booking traffic',
          checks,
        );
      }

      sendJson(res, 200, { status: 'ok', component: 'api', detail: JSON.stringify(checks), version: deps.version }, req.id);
    }),
  );

  return router;
}
