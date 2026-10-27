import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';

/**
 * Request context: correlation id + scoped logger + timing.
 *
 * Inbound `x-request-id` is honoured only when it looks like a correlation id (8-128 chars of
 * [A-Za-z0-9._-]); otherwise it is replaced. Unbounded, attacker-chosen request ids are a log-injection
 * and cardinality hazard.
 */

const INBOUND_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

export const requestContext: RequestHandler = (req, res, next) => {
  const inbound = req.header('x-request-id');
  const id = inbound && INBOUND_REQUEST_ID.test(inbound) ? inbound : randomUUID();

  req.id = id;
  req.startedAtNs = process.hrtime.bigint();
  res.setHeader('x-request-id', id);
  next();
};

/** Attaches a Pino child logger; kept separate so tests can inject a silent one. */
export function bindLogger(root: Logger): RequestHandler {
  return (req, _res, next) => {
    req.log = root.child({
      requestId: req.id,
      method: req.method,
      path: req.path,
    });
    next();
  };
}

/**
 * Route template for metrics labels. Computed in `finish` because `req.route` only exists after
 * matching, and `req.baseUrl + req.route.path` yields the pattern (`/api/v1/events/:id`) rather than
 * the concrete path — that is what keeps Prometheus cardinality finite.
 */
export function routeTemplate(req: Request): string {
  const mounted = req.baseUrl ?? '';
  // Requests that matched nothing are labelled `unmatched` instead of echoing the attacker-chosen
  // path: a 404 flood against random URLs must not create unbounded metric series.
  const withinRouter = req.route?.path ?? 'unmatched';
  return `${mounted}${withinRouter}`;
}

export function requestDurationSeconds(req: Request): number {
  return Number(process.hrtime.bigint() - req.startedAtNs) / 1e9;
}

/** Wraps a handler so rejections reach the error middleware with the correlation id attached. */
export function asyncHandler<T extends Request = Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as T, res, next).catch(next);
  };
}
