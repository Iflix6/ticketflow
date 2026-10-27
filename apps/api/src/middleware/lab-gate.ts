import type { RequestHandler } from 'express';
import type { AppConfig } from '@ticketflow/config';
import { AppError } from '../shared/errors.js';

const LAB_ALLOWED_ENVIRONMENTS = new Set<string>(['local', 'test', 'ci']);

/**
 * Lab gate (ADR-0009). Two independent conditions must hold; the router is also *not mounted* at all
 * when they do not, so this middleware is the second lock rather than the only one.
 */
export function isLabEnabled(config: AppConfig): boolean {
  return config.LAB_ENABLED && LAB_ALLOWED_ENVIRONMENTS.has(config.NODE_ENV);
}

export const labGate: RequestHandler = (req, _res, next) => {
  const config = req.app.locals.config as AppConfig;
  if (!isLabEnabled(config)) {
    return next(new AppError('lab_disabled', 'Engineering Lab endpoints are disabled in this deployment'));
  }
  return next();
};
