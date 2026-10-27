import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { AppConfig } from '@ticketflow/config';
import { AppError } from '../shared/errors.js';
import { sendError } from '../shared/respond.js';

/** Every unmatched route returns the standard error envelope, not Express's HTML 404 page. */
export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(
    res,
    req.id,
    new AppError('not_found', `No route for ${req.method} ${req.path}`),
    false,
  );
};

/**
 * Terminal error handler.
 *
 * - Zod validation failures become `validation_failed` with a field-level detail map (safe to expose).
 * - Body-parser failures become `validation_failed` too (a malformed JSON body is a client error).
 * - Everything else is mapped by {@link sendError}; internal messages stay in the log.
 */
export function createErrorHandler(config: AppConfig): ErrorRequestHandler {
  const exposeDebug = config.NODE_ENV !== 'production';

  return (error, req, res, _next) => {
    const appError = normalize(error);

    if (appError.status >= 500) {
      req.log.error({ err: appError.cause ?? appError, code: appError.code }, 'request failed');
    } else {
      req.log.warn({ code: appError.code, status: appError.status }, 'request rejected');
    }

    sendError(res, req.id ?? 'unknown', appError, exposeDebug);
  };
}

function normalize(error: unknown): AppError {
  if (error instanceof ZodError) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of error.issues) {
      fieldErrors[issue.path.join('.') || '(root)'] = issue.message;
    }
    return new AppError('validation_failed', 'Request validation failed', { fieldErrors }, error);
  }

  if (error instanceof AppError) return error;

  // body-parser / express json errors carry `type` and a 4xx status.
  const candidate = error as { status?: number; statusCode?: number; type?: string; message?: string };
  const type = candidate?.type;
  if (type === 'entity.parse.failed' || type === 'entity.too.large') {
    return new AppError(
      'validation_failed',
      type === 'entity.too.large' ? 'Request body too large' : 'Request body is not valid JSON',
      { reason: type },
      error,
    );
  }

  if (isNotFoundLike(candidate)) {
    return new AppError('not_found', 'Resource not found', undefined, error);
  }

  // Unknown error shape: treat as internal (never trust a random thrown value's message).
  return new AppError('internal_error', 'Internal server error', undefined, error);
}

function isNotFoundLike(candidate: { status?: number; statusCode?: number } | undefined): boolean {
  const status = candidate?.status ?? candidate?.statusCode;
  return status === 404;
}
