import { Router } from 'express';
import type { AppConfig } from '@ticketflow/config';
import { sendJson } from '../../shared/respond.js';
import { AppError } from '../../shared/errors.js';
import { listStrategies } from './strategies.js';

/**
 * Engineering Lab routes (local/test only; the whole router is unmounted otherwise, and
 * `labGate` + `requireRole('LAB_ADMIN')` guard it even when mounted — ADR-0009).
 *
 * Phase 1 implements the strategy catalogue only. Run creation, fixture reset and result
 * queries arrive with their implementations (Phases 3–4); they answer with the standard
 * `internal_error`-free 501 envelope instead of pretending to work.
 */
export function createLabRouter(config: AppConfig): Router {
  const router = Router();

  router.get('/strategies', (req, res) => {
    // `unsafe_lab` appears only when the lab is enabled at all, so a public deployment cannot
    // even discover that the unsafe strategy exists.
    sendJson(res, 200, { data: listStrategies(config.LAB_ENABLED) }, req.id);
  });

  const notImplemented = (feature: string) => (): void => {
    throw new AppError('strategy_unavailable', `${feature} is implemented in a later phase`, { feature });
  };

  router.post('/runs', notImplemented('Experiment run creation (Phase 3)'));
  router.get('/runs', notImplemented('Experiment run listing (Phase 3)'));
  router.get('/runs/:id', notImplemented('Experiment run detail (Phase 3)'));
  router.get('/runs/:id/results', notImplemented('Experiment results (Phase 3)'));
  router.post('/fixtures/reset', notImplemented('Fixture reset (Phase 3)'));

  return router;
}
