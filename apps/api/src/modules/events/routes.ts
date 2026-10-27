import { Router } from 'express';
import { z } from 'zod';
import { pageQuerySchema } from '@ticketflow/contracts';
import { asyncHandler } from '../../middleware/request-context.js';
import { sendJson } from '../../shared/respond.js';
import { parseParams, parseQuery } from '../../shared/validation.js';
import type { EventsService } from './service.js';

const eventParamsSchema = z.object({ id: z.uuid() });

const listQuerySchema = pageQuerySchema.extend({
  status: z.enum(['DRAFT', 'ON_SALE', 'SOLD_OUT', 'CANCELED', 'FINISHED']).optional(),
});

/** Thin handlers: validate, call the service, choose the status code. No business rules here. */
export function createEventsRouter(service: EventsService): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const { page, pageSize, status } = parseQuery(req, listQuerySchema);
      const { events, pagination } = await service.listEvents(page, pageSize, status);
      sendJson(res, 200, { data: events, pagination }, req.id);
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, eventParamsSchema);
      const event = await service.requireEvent(id);
      sendJson(res, 200, { data: event }, req.id);
    }),
  );

  router.get(
    '/:id/tiers',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, eventParamsSchema);
      const tiers = await service.tiersForEvent(id);
      sendJson(res, 200, { data: tiers }, req.id);
    }),
  );

  return router;
}
