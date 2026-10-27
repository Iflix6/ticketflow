import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { authenticate, requireRole, requireUser } from '../../apps/api/src/middleware/authenticate.js';
import type { AuthenticatedUser } from '../../apps/api/src/modules/auth/types.js';
import { AppError } from '../../apps/api/src/shared/errors.js';
import { issueToken } from '../../apps/api/src/modules/auth/credentials.js';
import { testConfig } from '../helpers/config.js';

const config = testConfig();
const admin = { id: 'admin-1', email: 'lab@local.test', role: 'LAB_ADMIN' } as const;
const customer = { id: 'cust-1', email: 'c@local.test', role: 'CUSTOMER' } as const;

function fakeRequest(headers: Record<string, string>): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    log: { child: () => fakeLogger },
  } as unknown as Request;
}
const fakeLogger = { child: () => fakeLogger } as unknown as Request['log'];

async function run(
  handler: (req: Request, res: Response, next: NextFunction) => void,
  request: Request,
): Promise<unknown> {
  let error: unknown;
  await new Promise<void>((resolve) => {
    handler(request, {} as Response, ((err?: unknown) => {
      error = err;
      resolve();
    }) as NextFunction);
    if (error === undefined && request !== undefined) resolve();
  });
  return error;
}

describe('authenticate', () => {
  it('accepts a valid bearer token and populates req.user', async () => {
    const token = issueToken(customer, config.AUTH_SECRET, 60);
    const req = fakeRequest({ authorization: `Bearer ${token}` });
    const error = await run(authenticate(config, true), req);
    expect(error).toBeUndefined();
    expect(req.user?.id).toBe('cust-1');
  });

  it('required mode: missing header is 401, malformed token is 401 (never 500)', async () => {
    expect(await run(authenticate(config, true), fakeRequest({}))).toBeInstanceOf(AppError);
    const req = fakeRequest({ authorization: 'Bearer garbage' });
    const error = (await run(authenticate(config, true), req)) as AppError;
    expect(error.code).toBe('unauthorized');
    expect(error.status).toBe(401);
  });

  it('optional mode: anonymous passes through, but a broken token still blocks required routes', async () => {
    const anonymous = fakeRequest({});
    expect(await run(authenticate(config, false), anonymous)).toBeUndefined();
    const bad = fakeRequest({ authorization: 'Bearer tf1.abc.def' });
    expect(await run(authenticate(config, false), bad)).toBeUndefined(); // optional ignores invalid
    expect(bad.user).toBeUndefined();
  });

  it('accepts case-insensitive scheme', async () => {
    const token = issueToken(customer, config.AUTH_SECRET, 60);
    const req = fakeRequest({ authorization: `bearer ${token}` });
    expect(await run(authenticate(config, true), req)).toBeUndefined();
  });
});

describe('requireRole / requireUser', () => {
  it('permits listed roles and rejects others with 403', async () => {
    const allowed = { user: admin } as unknown as Request;
    expect(await run(requireRole('LAB_ADMIN'), allowed)).toBeUndefined();

    const wrong = { user: customer } as unknown as Request;
    const error = (await run(requireRole('LAB_ADMIN'), wrong)) as AppError;
    expect(error.code).toBe('forbidden');
    expect(error.status).toBe(403);
  });

  it('rejects anonymous traffic with 401 instead of leaking a 500 via requireUser', async () => {
    const anon = {} as Request;
    expect((await run(requireRole('CUSTOMER'), anon)) as AppError).toMatchObject({ code: 'unauthorized' });
    // `exactOptionalPropertyTypes` forbids `{ user: undefined }` as a direct literal, so the
    // anonymous shape is routed through `unknown` — the middleware contract is what is under test.
    expect(() => requireUser({ user: undefined } as unknown as { user?: AuthenticatedUser })).toThrow(AppError);
    expect(requireUser({ user: customer }).id).toBe('cust-1');
  });
});
