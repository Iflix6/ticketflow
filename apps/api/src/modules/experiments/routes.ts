import { Router } from 'express';
import { z } from 'zod';
import { createLabRunRequestSchema, fixtureResetRequestSchema, pageQuerySchema } from '@ticketflow/contracts';
import type { AppConfig } from '@ticketflow/config';
import { asyncHandler } from '../../middleware/request-context.js';
import { requireUser } from '../../middleware/authenticate.js';
import { sendJson } from '../../shared/respond.js';
import { parseBody, parseParams, parseQuery, uuidParamSchema } from '../../shared/validation.js';
import { buildPagination } from '../events/service.js';
import { listStrategies } from './strategies.js';
import type { LabService } from './service.js';

/**
 * Engineering Lab routes (local/test only; the whole router is unmounted otherwise, and `labGate` +
 * `requireRole('LAB_ADMIN')` guard it even when mounted — ADR-0009).
 *
 * Phase 3 implements the full local experiment lifecycle: the strategy catalogue, run creation
 * (executed synchronously against the isolated `lab` fixture), run listing/detail/results, and fixture
 * reset. Handlers stay thin — parse, delegate to {@link LabService}, choose the status code.
 */

const resultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

export function createLabRouter(service: LabService): Router {
  const router = Router();

  router.get('/strategies', (req, res) => {
    // `unsafe_lab` appears only when the lab is enabled at all, so a public deployment cannot even
    // discover that the unsafe strategy exists.
    sendJson(res, 200, { data: listStrategies((req.app.locals.config as AppConfig).LAB_ENABLED) }, req.id);
  });

  router.post(
    '/runs',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const { strategy, configuration, label } = parseBody(req, createLabRunRequestSchema);
      const run = await service.createRun(user, strategy, configuration, label ?? null);
      sendJson(res, 201, { data: run }, req.id);
    }),
  );

  router.get(
    '/runs',
    asyncHandler(async (req, res) => {
      const { page, pageSize } = parseQuery(req, pageQuerySchema);
      const { rows, total } = await service.listRuns(page, pageSize);
      sendJson(res, 200, { data: rows, pagination: buildPagination(page, pageSize, total) }, req.id);
    }),
  );

  router.get(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, uuidParamSchema);
      const run = await service.getRunById(id);
      sendJson(res, 200, { data: run }, req.id);
    }),
  );

  router.get(
    '/runs/:id/results',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, uuidParamSchema);
      const { limit } = parseQuery(req, resultsQuerySchema);
      const results = await service.getRunResults(id, limit);
      sendJson(res, 200, { data: results }, req.id);
    }),
  );

  router.post(
    '/fixtures/reset',
    asyncHandler(async (req, res) => {
      // Authentication + LAB_ADMIN role are already enforced by the mount; the reset itself is idempotent.
      requireUser(req);
      const request = parseBody(req, fixtureResetRequestSchema);
      const result = await service.resetFixture(request);
      sendJson(res, 200, { data: result }, req.id);
    }),
  );

  return router;
}
