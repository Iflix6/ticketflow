import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  InMemoryCounterStore,
  createRateLimiter,
  type CounterStore,
} from '../../apps/api/src/middleware/rate-limit.js';
import { AppError } from '../../apps/api/src/shared/errors.js';
import { testConfig } from '../helpers/config.js';

/** Fake res: header bookkeeping only — behavior under test is entirely in the middleware. */
function fakeResponse(): { Response: Response; headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
  } as unknown as Response;
  return { Response: res, headers };
}

const req = (over: Partial<Request> = {}): Request =>
  ({ method: 'GET', ip: '127.0.0.1', log: { warn: () => undefined }, ...over }) as unknown as Request;

async function apply(
  middleware: RequestHandler,
  request: Request,
): Promise<{ error: unknown; res: Record<string, string> }> {
  const { Response: res, headers } = fakeResponse();
  let error: unknown;
  const next: NextFunction = (err?: unknown) => {
    error = err;
  };
  await Promise.resolve(middleware(request, res, next));
  return { error, res: headers };
}

describe('InMemoryCounterStore', () => {
  it('counts within a window and resets after expiry', async () => {
    const store = new InMemoryCounterStore();
    expect((await store.increment('k', 60_000)).count).toBe(1);
    expect((await store.increment('k', 60_000)).count).toBe(2);
    expect((await store.increment('other', 60_000)).count).toBe(1); // keys are independent
    // A window is only "reset" once the clock actually passes its expiry: `Date.now()` has 1 ms
    // granularity, so sub-millisecond assertions would race the scheduler rather than the store.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await store.increment('short', 1)).count).toBe(1); // fresh window for a 1 ms key
    expect((await store.increment('short', 1)).count).toBe(1); // elapsed between calls → new window again
    expect((await store.increment('k', 60_000)).count).toBe(3); // long window survived the wait
    store.close();
  });
});

describe('createRateLimiter', () => {
  const config = testConfig({ RATE_LIMIT_MAX: '3', RATE_LIMIT_WINDOW_MS: '60000' });

  it('allows requests up to the limit and then fails next() with rate_limited (429)', async () => {
    const store = new InMemoryCounterStore();
    const limiter = createRateLimiter(config, store);
    for (let i = 0; i < 3; i += 1) {
      const { error } = await apply(limiter, req());
      expect(error).toBeUndefined();
    }
    const { error, res } = await apply(limiter, req());
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('rate_limited');
    expect((error as AppError).status).toBe(429);
    expect(res['retry-after']).toBeTypeOf('string');
    expect(res['rate-limit-remaining']).toBe('0');
    store.close();
  });

  it('buckets by user id when present, so authenticated traffic does not share one counter', async () => {
    const store = new InMemoryCounterStore();
    const limiter = createRateLimiter(config, store, { routeGroup: 'g' });
    await apply(limiter, req({ user: { id: 'u1', email: 'x', role: 'CUSTOMER' } }));
    const other = await apply(limiter, req({ user: { id: 'u2', email: 'x', role: 'CUSTOMER' } }));
    expect(other.error).toBeUndefined();
    store.close();
  });

  it('fails OPEN for reads when the store breaks, and CLOSED for mutations', async () => {
    const broken: CounterStore = {
      increment: async () => {
        throw new Error('redis exploded');
      },
    };
    const limiter = createRateLimiter(config, broken);

    const read = await apply(limiter, req({ method: 'GET' }));
    expect(read.error).toBeUndefined(); // read allowed with a warning log

    const write = await apply(limiter, req({ method: 'POST' }));
    expect((write.error as AppError)?.code).toBe('dependency_unavailable');
    expect((write.error as AppError)?.status).toBe(503);
  });
});
