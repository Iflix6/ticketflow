import type { RequestHandler } from 'express';
import { appMetrics } from '../observability/metrics.js';
import { requestDurationSeconds, routeTemplate } from './request-context.js';

/**
 * HTTP metrics. Recorded on `finish` (not in the handler) so abandoned/reset connections are still
 * counted, and labelled by route template only.
 */
export const httpMetrics: RequestHandler = (req, res, next) => {
  res.on('finish', () => {
    const route = routeTemplate(req);
    const statusClass = `${Math.floor(res.statusCode / 100)}XX`;
    const seconds = requestDurationSeconds(req);

    appMetrics.httpRequestsTotal.inc({ method: req.method, route, status_class: statusClass });
    appMetrics.httpRequestDuration.observe({ method: req.method, route }, seconds);

    req.log.info(
      {
        statusCode: res.statusCode,
        durationMs: Math.round(seconds * 1000),
        route,
      },
      'request completed',
    );
  });

  next();
};
