import { Router } from 'express';
import { pageQuerySchema } from '@ticketflow/contracts';
import { asyncHandler } from '../../middleware/request-context.js';
import { requireUser } from '../../middleware/authenticate.js';
import { sendJson } from '../../shared/respond.js';
import { parseParams, parseQuery, uuidParamSchema } from '../../shared/validation.js';
import { buildPagination } from '../events/service.js';
import type { BookingsService } from './service.js';

/**
 * Booking reads. Two separate routers because the API exposes `/bookings/:id` and `/me/bookings`
 * under different prefixes; both are mounted behind `authenticate` so `req.user` is always present.
 * Reads never need an idempotency key (no side effects).
 */
export function createBookingsRouter(service: BookingsService): Router {
  const router = Router();

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const { id } = parseParams(req, uuidParamSchema);
      const booking = await service.getBooking(user, id);
      sendJson(res, 200, { data: booking }, req.id);
    }),
  );

  return router;
}

export function createMeBookingsRouter(service: BookingsService): Router {
  const router = Router();

  router.get(
    '/bookings',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const { page, pageSize } = parseQuery(req, pageQuerySchema);
      const { bookings, total } = await service.listMine(user, page, pageSize);
      sendJson(res, 200, { data: bookings, pagination: buildPagination(page, pageSize, total) }, req.id);
    }),
  );

  return router;
}
