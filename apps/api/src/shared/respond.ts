import type { Response } from 'express';
import type { ErrorCode, ErrorBody } from '@ticketflow/contracts';
import { AppError, type PgErrorLike, describeError, isPgError } from './errors.js';

/**
 * Response helpers.
 *
 * One place decides the envelope, timestamp format and header names, so every endpoint (and the
 * generated OpenAPI document) stays consistent.
 */

export interface RequestContextInfo {
  requestId: string;
}

export function errorBody(
  code: ErrorCode,
  message: string,
  requestId: string,
  /** Contract-visible subset: JSON-representable values only (see `errorBodySchema`). */
  details?: ErrorBody['details'],
): ErrorBody {
  return {
    code,
    message,
    ...(details ? { details } : {}),
    requestId,
    occurredAt: new Date().toISOString(),
  };
}

/**
 * Serializes an unknown thrown value into the client-visible error.
 *
 * `internal_error` responses never carry the underlying message: driver/OS text leaks schema names,
 * constraint details and sometimes connection strings. The full error goes to the log instead.
 * `exposeDebug` is set from validated configuration (`NODE_ENV !== 'production'`) by the caller —
 * this module never reads `process.env` itself.
 */
export function toErrorBody(
  error: unknown,
  requestId: string,
  exposeDebug = false,
): { status: number; body: ErrorBody } {
  const appError =
    error instanceof AppError ? error : new AppError('internal_error', 'Internal server error', undefined, error);
  // SQLSTATE comes from the *underlying* pg error (repositories wrap it as `cause`); a bare pg-shaped
  // throw is itself the pg error. An `AppError` must never be read this way: its `code` is an
  // application ErrorCode, and reporting `sqlstate: "forbidden"` would be actively misleading.
  const pgSource =
    appError.cause !== undefined && appError.cause !== null && isPgError(appError.cause)
      ? appError.cause
      : !(error instanceof AppError) && isPgError(error)
        ? error
        : undefined;
  const pg = pgSource as PgErrorLike | undefined;
  return {
    status: appError.status,
    body: errorBody(
      appError.code,
      appError.code === 'internal_error' ? 'Internal server error' : appError.message,
      requestId,
      {
        ...(appError.details ?? {}),
        ...(pg?.code ? { sqlstate: pg.code } : {}),
        ...(appError.code === 'internal_error' && exposeDebug
          ? { debugCause: describeError(appError.cause ?? appError) }
          : {}),
      } as ErrorBody['details'],
    ),
  };
}

export function sendError(
  res: Response,
  requestId: string,
  error: unknown,
  exposeDebug = false,
): void {
  const { status, body } = toErrorBody(error, requestId, exposeDebug);
  res.status(status).setHeader('x-request-id', requestId).json({ error: body });
}

export function sendJson<T>(res: Response, status: number, payload: T, requestId: string): void {
  res.status(status).setHeader('x-request-id', requestId).json(payload);
}
