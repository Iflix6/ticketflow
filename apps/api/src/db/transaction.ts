import type { AppConfig } from '@ticketflow/config';
import type { Database, SqlClient } from './pool.js';
import { PostgresTimeouts, applySessionTimeouts } from './pool.js';
import { AppError, isPgError, isTransientRetryableCode } from '../shared/errors.js';
import { appMetrics } from '../observability/metrics.js';

/**
 * Transaction helper (ADR-0003).
 *
 * Rules this file enforces:
 * - exactly one `PoolClient` for the whole transaction (never `pool.query` mid-transaction);
 * - `BEGIN` → work → `COMMIT`, with `ROLLBACK` and `release()` in a `finally`;
 * - per-transaction `SET LOCAL` timeouts;
 * - transient PostgreSQL codes are retried by {@link runWithTransientRetry} only, with bounded
 *   attempts and full jitter, and only for work that is safe to repeat.
 */

export const ISOLATION_LEVELS = {
  readCommitted: 'READ COMMITTED',
  repeatableRead: 'REPEATABLE READ',
  serializable: 'SERIALIZABLE',
} as const;

export type IsolationLevel = (typeof ISOLATION_LEVELS)[keyof typeof ISOLATION_LEVELS];

const ISOLATION_BY_NAME: Readonly<Record<string, IsolationLevel>> = {
  read_committed: ISOLATION_LEVELS.readCommitted,
  repeatable_read: ISOLATION_LEVELS.repeatableRead,
  serializable: ISOLATION_LEVELS.serializable,
};

export function isolationFromName(name: string | undefined): IsolationLevel {
  const level = name === undefined ? undefined : ISOLATION_BY_NAME[name];
  if (level === undefined) {
    throw new AppError('validation_failed', `Unknown isolation level: ${name ?? '(empty)'}`);
  }
  return level;
}

export interface TransactionOptions {
  isolation?: IsolationLevel;
  /** Log/metric label, e.g. `reserve.atomic_update`, so latency can be attributed without PII. */
  label: string;
  timeouts?: PostgresTimeouts;
}

export type TransactionWork<T> = (client: SqlClient) => Promise<T>;

/**
 * Fallback used when a caller does not supply timeouts. Production wiring always passes values from
 * validated configuration; this exists so tests and scripts cannot accidentally run un-timed.
 */
export const DEFAULT_TIMEOUTS = new PostgresTimeouts(5000, 2000, 10_000);

export function timeoutsFrom(config: AppConfig): PostgresTimeouts {
  return new PostgresTimeouts(
    config.STATEMENT_TIMEOUT_MS,
    config.LOCK_TIMEOUT_MS,
    config.IDLE_IN_TRANSACTION_TIMEOUT_MS,
  );
}

export async function withTransaction<T>(
  db: Database,
  options: TransactionOptions,
  work: TransactionWork<T>,
): Promise<T> {
  const timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
  const startedAt = process.hrtime.bigint();
  const client = await db.connect();
  let committed = false;
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${options.isolation ?? ISOLATION_LEVELS.readCommitted}`);
    await applySessionTimeouts(client, timeouts);
    const result = await work(client);
    await client.query('COMMIT');
    committed = true;
    return result;
  } catch (error) {
    // The rollback itself can fail (connection already gone); swallow it but keep the original error.
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    const microseconds = Number(process.hrtime.bigint() - startedAt) / 1000;
    appMetrics.transactionDuration.observe(
      { label: options.label, outcome: committed ? 'commit' : 'rollback' },
      microseconds / 1_000_000,
    );
    client.release();
  }
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  label: string;
}

export function retryPolicyFrom(config: AppConfig): RetryPolicy {
  return {
    maxAttempts: config.TX_MAX_ATTEMPTS,
    baseDelayMs: config.TX_BASE_DELAY_MS,
    maxDelayMs: config.TX_MAX_DELAY_MS,
    label: 'default',
  };
}

/**
 * Full jitter (random between 0 and the exponential ceiling) rather than fixed backoff: under hot-row
 * contention, synchronized retries from many workers produce the same collision they are retrying.
 */
export function delayForAttempt(attempt: number, policy: RetryPolicy, random: () => number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
  return Math.floor(random() * ceiling);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `work` (which must itself be a complete transaction) retrying only transient PostgreSQL codes.
 *
 * `onAttempt` receives the 1-based attempt number so callers can record retry counts in experiment
 * results. Non-retryable errors (check violations, unique violations, invalid transitions, anything
 * unknown) are thrown immediately — a retry would either mask a real bug or duplicate a side effect.
 */
export async function runWithTransientRetry<T>(
  policy: RetryPolicy,
  work: (attempt: number) => Promise<T>,
  options: { random?: () => number; onRetry?: (attempt: number, code: string) => void } = {},
): Promise<T> {
  const random = options.random ?? Math.random;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      lastError = error;
      const code = isPgError(error) ? error.code : undefined;
      const retryable = isTransientRetryableCode(code);

      if (!retryable || attempt === policy.maxAttempts) {
        if (retryable) {
          appMetrics.retriesExhausted.inc({ label: policy.label });
        }
        throw error;
      }

      appMetrics.retries.inc({ label: policy.label, code: code ?? 'unknown' });
      options.onRetry?.(attempt, code ?? 'unknown');
      await sleep(delayForAttempt(attempt, policy, random));
    }
  }

  // Unreachable: the loop either returns or throws. Kept for the type checker's benefit.
  throw lastError instanceof Error ? lastError : new AppError('internal_error', 'Retry loop exhausted');
}
