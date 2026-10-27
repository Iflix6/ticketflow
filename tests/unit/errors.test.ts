import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppError } from '../../apps/api/src/shared/errors.js';
import { toErrorBody } from '../../apps/api/src/shared/respond.js';

/**
 * Error taxonomy invariants (the contract clients switch on):
 * - status derives from the code, never from the throw site;
 * - internal messages never reach the client body;
 * - unknown thrown values are treated as internal, not echoed.
 */

const REQUEST_ID = 'test-request-id';

describe('toErrorBody', () => {
  it('maps AppError codes onto their canonical statuses', () => {
    const cases: Array<[string, number]> = [
      ['validation_failed', 400],
      ['unauthorized', 401],
      ['forbidden', 403],
      ['not_found', 404],
      ['sold_out', 409],
      ['idempotency_key_reuse', 409],
      ['rate_limited', 429],
      ['lab_disabled', 403],
      ['dependency_unavailable', 503],
      ['internal_error', 500],
    ];
    for (const [code, status] of cases) {
      const body = toErrorBody(new AppError(code as never, 'x'), REQUEST_ID);
      expect(body.status).toBe(status);
      expect(body.body.code).toBe(code);
    }
  });

  it('strips the real message from internal_error but keeps it available to logs via cause', () => {
    const leaky = new AppError('internal_error', 'connection string was postgres://user:pw@host', undefined, {
      secret: 'do-not-send',
    });
    const { body } = toErrorBody(leaky, REQUEST_ID);
    expect(body.message).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('user:pw');
    expect(JSON.stringify(body)).not.toContain('do-not-send');
  });

  it('exposes debugCause only when the caller opted in (non-production)', () => {
    const error = new AppError('internal_error', 'boom', undefined, new Error('underlying detail'));
    expect(JSON.stringify(toErrorBody(error, REQUEST_ID, true).body)).toContain('underlying detail');
    expect(JSON.stringify(toErrorBody(error, REQUEST_ID, false).body)).not.toContain('underlying detail');
  });

  it('converts non-AppError throws into a generic internal error', () => {
    for (const thrown of ['string error', { message: 'object' }, new TypeError('db exploded')]) {
      const { status, body } = toErrorBody(thrown, REQUEST_ID);
      expect(status).toBe(500);
      expect(body.code).toBe('internal_error');
    }
  });

  it('surfaces SQLSTATE for pg-shaped errors (operators need the class, not the payload)', () => {
    const pgError = Object.assign(new Error('duplicate key'), { code: '23505' });
    const { body } = toErrorBody(new AppError('conflict', 'unique', undefined, pgError), REQUEST_ID);
    expect(body.details?.['sqlstate']).toBe('23505');
  });

  it('attaches field-level details from a ZodError via AppError construction', () => {
    const schema = z.object({ quantity: z.number().int().min(1) });
    const parsed = schema.safeParse({ quantity: 0 });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) fieldErrors[issue.path.join('.')] = issue.message;
    const { status, body } = toErrorBody(new AppError('validation_failed', 'Request validation failed', fieldErrors), REQUEST_ID);
    expect(status).toBe(400);
    expect(body.details?.['quantity']).toBeTypeOf('string');
  });

  it('honours status overrides only for legitimately multi-status codes', () => {
    const tooEarly = new AppError('idempotency_in_progress', 'try again later', undefined, undefined, 425);
    expect(toErrorBody(tooEarly, REQUEST_ID).status).toBe(425);
  });
});
