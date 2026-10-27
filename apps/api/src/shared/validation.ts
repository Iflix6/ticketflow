import type { Request } from 'express';
import { z } from 'zod';
import type { ZodType } from 'zod';
import { AppError } from './errors.js';

/**
 * Boundary validation (Zod).
 *
 * Every request payload, query string, route parameter and relevant header passes through one of
 * these helpers before reaching a service. The error is an `AppError('validation_failed')` carrying a
 * field map, so handlers never do their own `if (x == null)` arithmetic.
 */

function parseOrThrow<T>(schema: ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fieldErrors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    fieldErrors[`${source}.${issue.path.join('.') || ''}`.replace(/\.$/, '')] = issue.message;
  }
  throw new AppError('validation_failed', `${source} validation failed`, fieldErrors, result.error);
}

export const parseBody = <T>(req: Request, schema: ZodType<T>): T =>
  parseOrThrow(schema, req.body ?? {}, 'body');

export const parseQuery = <T>(req: Request, schema: ZodType<T>): T =>
  parseOrThrow(schema, req.query, 'query');

export const parseParams = <T>(req: Request, schema: ZodType<T>): T =>
  parseOrThrow(schema, req.params, 'params');

/** UUID route parameter, validated before it can reach a SQL parameter. */
export const uuidParamSchema = z.object({ id: z.uuid() });

export const idempotencyKeyHeaderSchema = z.object({
  'idempotency-key': z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'Idempotency-Key must be URL-safe'),
});

/**
 * Reads the idempotency key from the header map. Express lower-cases header names, so the Zod object
 * uses the lower-cased key on purpose.
 */
export function requireIdempotencyKey(req: Request): string {
  const headers = req.headers as Record<string, string | string[] | undefined>;
  const raw = headers['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) {
    throw new AppError('idempotency_key_missing', 'Idempotency-Key header is required for this mutation');
  }
  return parseOrThrow(idempotencyKeyHeaderSchema, { 'idempotency-key': value }, 'header')[
    'idempotency-key'
  ];
}
