import cors from 'cors';
import helmet from 'helmet';
import express, { type RequestHandler } from 'express';
import type { AppConfig } from '@ticketflow/config';
import { AppError } from '../shared/errors.js';

/**
 * HTTP hardening for a JSON API.
 *
 * - `helmet` with an explicit CSP (the API serves no HTML; the policy exists so a stray HTML response
 *   cannot execute anything) and `crossOriginResourcePolicy: same-origin`.
 * - CORS is an explicit allowlist from validated config; requests with an unlisted `Origin` simply do
 *   not get CORS headers (the browser blocks them) rather than being reflected.
 * - Body size is capped, and the parser reports `validation_failed` rather than a raw parse error.
 * - `X-Powered-By` is removed; `Server` stays generic.
 */
export function securityMiddlewares(config: AppConfig): RequestHandler[] {
  const allowlist = new Set(config.CORS_ORIGINS);

  const corsMiddleware = cors({
    origin: (origin, callback) => {
      // Same-origin/tooling requests have no Origin header.
      if (origin === undefined || allowlist.has(origin)) return callback(null, true);
      return callback(new AppError('forbidden', `Origin ${origin} is not allowed`));
    },
    credentials: true,
    allowedHeaders: ['content-type', 'idempotency-key', 'authorization', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'idempotent-replay', 'retry-after', 'rate-limit-limit'],
    maxAge: 600,
  });

  const jsonBody = express.json({
    limit: config.BODY_LIMIT,
    // Prevent prototype-pollution style payloads from ever reaching a handler.
    strict: true,
  });

  return [
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts: config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
    (_req, res, next) => {
      res.removeHeader('X-Powered-By');
      next();
    },
    corsMiddleware,
    jsonBody,
  ];
}
