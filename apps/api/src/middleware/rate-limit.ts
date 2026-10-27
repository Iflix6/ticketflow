import type { RequestHandler } from 'express';
import type { AppConfig } from '@ticketflow/config';
import { AppError } from '../shared/errors.js';

/**
 * Fixed-window rate limiting with a pluggable counter store.
 *
 * The store interface exists because Phase 4 swaps the in-process map for a Redis-backed counter:
 * per-process limits are meaningless under multiple API replicas, and pretending otherwise is how
 * "we had a rate limiter" incidents happen. Until then, the in-memory store is honest about being
 * process-local and the README says so.
 *
 * Failure policy (ADR-0005): if the store throws, read-only requests are allowed through with a
 * warning log, mutations are rejected with `dependency_unavailable`. A lab load experiment must not
 * be silently unthrottled on a write path.
 */

export interface CounterStore {
  /** Increments and returns the count for `key` in the current window. */
  increment(key: string, windowMs: number): Promise<{ count: number; resetAfterMs: number }>;
}

export class InMemoryCounterStore implements CounterStore {
  #entries = new Map<string, { count: number; expiresAt: number }>();
  #sweeper: NodeJS.Timeout;

  constructor() {
    // Sweep expired windows instead of growing without bound; unref keeps process exit clean.
    this.#sweeper = setInterval(() => this.#sweep(), 30_000);
    this.#sweeper.unref();
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAfterMs: number }> {
    const now = Date.now();
    const existing = this.#entries.get(key);

    if (existing === undefined || existing.expiresAt <= now) {
      this.#entries.set(key, { count: 1, expiresAt: now + windowMs });
      return { count: 1, resetAfterMs: windowMs };
    }

    existing.count += 1;
    return { count: existing.count, resetAfterMs: Math.max(0, existing.expiresAt - now) };
  }

  #sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
  }

  close(): void {
    clearInterval(this.#sweeper);
    this.#entries.clear();
  }
}

/** Bucket key: caller identity + route group. Never the full URL (cardinality) and never a secret. */
function bucketKey(req: { user?: { id: string }; ip: string | undefined }, routeGroup: string): string {
  const actor = req.user?.id ?? req.ip ?? 'anonymous';
  return `${routeGroup}:${actor}`;
}

export interface RateLimitOptions {
  routeGroup?: string;
  /** Overrides for the lab endpoints, which are bursty by design but still must be bounded. */
  max?: number;
}

export function createRateLimiter(
  config: AppConfig,
  store: CounterStore,
  options: RateLimitOptions = {},
): RequestHandler {
  const routeGroup = options.routeGroup ?? 'default';
  const limit = options.max ?? config.RATE_LIMIT_MAX;
  const windowMs = config.RATE_LIMIT_WINDOW_MS;

  return async (req, res, next) => {
    const isReadOnly = req.method === 'GET' || req.method === 'HEAD';

    try {
      const { count, resetAfterMs } = await store.increment(bucketKey(req, routeGroup), windowMs);
      res.setHeader('rate-limit-limit', String(limit));
      res.setHeader('rate-limit-remaining', String(Math.max(0, limit - count)));
      res.setHeader('rate-limit-reset', String(Math.ceil(resetAfterMs / 1000)));

      if (count > limit) {
        res.setHeader('retry-after', String(Math.max(1, Math.ceil(resetAfterMs / 1000))));
        return next(
          new AppError('rate_limited', `Rate limit exceeded for ${routeGroup}`, {
            limit,
            windowMs,
          }),
        );
      }
      return next();
    } catch (error) {
      if (isReadOnly) {
        req.log.warn({ err: error, routeGroup }, 'rate limit store unavailable, allowing read');
        return next();
      }
      return next(
        new AppError('dependency_unavailable', 'Rate limiting is unavailable', { routeGroup }, error),
      );
    }
  };
}
