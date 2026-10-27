import { Router } from 'express';
import type { Response } from 'express';
import { checkoutRequestSchema, createReservationRequestSchema } from '@ticketflow/contracts';
import { asyncHandler } from '../../middleware/request-context.js';
import { requireUser } from '../../middleware/authenticate.js';
import { sendJson } from '../../shared/respond.js';
import { parseBody, parseParams, requireIdempotencyKey, uuidParamSchema } from '../../shared/validation.js';
import type { ReservationsService, ServiceResult } from './service.js';

/**
 * Reservation endpoints (spec §API: create, read, cancel, checkout).
 *
 * Handlers stay thin: authenticate (via the mount), require the idempotency key on every mutation,
 * validate the body, call the service, then emit the service's already-enveloped result. The service
 * decides status codes and bodies (including the committed 409s that must not roll back), so the
 * handler never re-derives business logic. A replayed request sets the `idempotent-replay` header so a
 * client can tell a fresh effect from a re-served one.
 */

function sendResult(res: Response, result: ServiceResult<unknown>, requestId: string): void {
  if (result.replay) res.setHeader('idempotent-replay', 'true');
  sendJson(res, result.status, result.body, requestId);
}

export function createReservationsRouter(service: ReservationsService): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const key = requireIdempotencyKey(req);
      const body = parseBody(req, createReservationRequestSchema);
      const result = await service.createReservation(user, body, key, req.id);
      sendResult(res, result, req.id);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const { id } = parseParams(req, uuidParamSchema);
      const dto = await service.getReservation(user, id);
      sendJson(res, 200, { data: dto }, req.id);
    }),
  );

  router.post(
    '/:id/cancel',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const key = requireIdempotencyKey(req);
      const { id } = parseParams(req, uuidParamSchema);
      const result = await service.cancelReservation(user, id, key, req.id);
      sendResult(res, result, req.id);
    }),
  );

  router.post(
    '/:id/checkout',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const key = requireIdempotencyKey(req);
      const { id } = parseParams(req, uuidParamSchema);
      const body = parseBody(req, checkoutRequestSchema);
      const result = await service.checkout(user, id, body, key, req.id);
      sendResult(res, result, req.id);
    }),
  );

  return router;
}
