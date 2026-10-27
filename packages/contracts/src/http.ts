import { z } from 'zod';

/**
 * HTTP contract primitives shared by api, web and tests.
 *
 * The error taxonomy is intentionally closed: clients switch on `error.code`, not on prose or on the
 * status code alone, because several distinct causes share a status (e.g. 409 is used for
 * `sold_out`, `conflict`, `idempotency_key_reuse`, `invalid_transition`).
 */

export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'sold_out',
  'conflict',
  'idempotency_key_missing',
  'idempotency_key_reuse',
  'idempotency_in_progress',
  'invalid_transition',
  'reservation_not_confirmable',
  'rate_limited',
  'lab_disabled',
  'strategy_unavailable',
  'dependency_unavailable',
  'internal_error',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const errorBodySchema = z.object({
  code: errorCodeSchema,
  message: z.string().min(1),
  /** Machine-readable, non-sensitive context (never secrets, never PII). */
  details: z.record(z.string(), z.json()).optional(),
  requestId: z.string().min(1),
  occurredAt: z.string(),
});

export const errorResponseSchema = z.object({ error: errorBodySchema });

export type ErrorBody = z.infer<typeof errorBodySchema>;
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const paginationSchema = z.object({
  page: z.int().min(1),
  pageSize: z.int().min(1).max(200),
  totalItems: z.int().min(0),
  totalPages: z.int().min(0),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const LIST_META_HEADERS = {
  requestId: 'x-request-id',
  rateLimitLimit: 'rate-limit-limit',
  rateLimitRemaining: 'rate-limit-remaining',
  rateLimitReset: 'rate-limit-reset',
  retryAfter: 'retry-after',
  idempotencyKey: 'idempotency-key',
  idempotentReplay: 'idempotent-replay',
  cacheState: 'x-cache-state',
} as const;

/** Status codes this service is allowed to emit; guards against accidental ad-hoc codes. */
export const HTTP_STATUS_CODES = [200, 201, 202, 204, 400, 401, 403, 404, 409, 422, 425, 429, 500, 503] as const;
export type HttpStatusCode = (typeof HTTP_STATUS_CODES)[number];

/** Maps an error code to its canonical HTTP status (single source of truth for handlers and tests). */
export const ERROR_STATUS_MAP: Readonly<Record<ErrorCode, HttpStatusCode>> = Object.freeze({
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  sold_out: 409,
  conflict: 409,
  idempotency_key_missing: 400,
  idempotency_key_reuse: 409,
  idempotency_in_progress: 409,
  invalid_transition: 409,
  reservation_not_confirmable: 409,
  rate_limited: 429,
  lab_disabled: 403,
  strategy_unavailable: 422,
  dependency_unavailable: 503,
  internal_error: 500,
});

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof pageQuerySchema>;
