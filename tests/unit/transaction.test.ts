import { describe, expect, it } from 'vitest';
import type { Database, QueryResult, QueryResultRow, SqlClient } from '../../apps/api/src/db/pool.js';
import {
  DEFAULT_TIMEOUTS,
  ISOLATION_LEVELS,
  delayForAttempt,
  isolationFromName,
  runWithTransientRetry,
  withTransaction,
  type RetryPolicy,
} from '../../apps/api/src/db/transaction.js';
import { AppError } from '../../apps/api/src/shared/errors.js';

/**
 * Transaction-helper unit tests with a scripted fake client: what is verified here is the helper's
 * own protocol (BEGIN/COMMIT/ROLLBACK/release ordering, retry classification, jitter math) — the
 * real SQL semantics run against actual PostgreSQL in the integration suite.
 */

interface FakeCall {
  text: string;
  params?: readonly unknown[] | undefined;
}

class FakeClient {
  calls: FakeCall[] = [];
  failOn: { match: (text: string) => boolean; error: unknown } | undefined;

  async query<T>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ text, params });
    if (this.failOn?.match(text)) throw this.failOn.error;
    return { rows: [] };
  }
  release(): void {
    this.calls.push({ text: '<released>' });
  }
  get released(): boolean {
    return this.calls.some((c) => c.text === '<released>');
  }
}

function fakeDatabase(client: FakeClient): { db: Database; connectCount: () => number } {
  let connects = 0;
  const db = {
    pool: undefined as unknown as Database['pool'],
    // A structurally complete `pg.QueryResult`: the helper only ever reads `rows`/`rowCount`, but the
    // fake must satisfy the real interface or the test would not compile against production types.
    query: async <T extends QueryResultRow>(): Promise<QueryResult<T>> => ({
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      oid: 0,
      fields: [],
    }),
    connect: async () => {
      connects += 1;
      return client as unknown as SqlClient;
    },
    close: async () => undefined,
    stats: () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 }),
  } satisfies Database;
  return { db, connectCount: () => connects };
}

const pgError = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

describe('withTransaction', () => {
  it('runs BEGIN → timeouts → work → COMMIT and releases the client', async () => {
    const client = new FakeClient();
    const { db } = fakeDatabase(client);

    await withTransaction(db, { label: 'test.work' }, async (c) => {
      await c.query('SELECT 1');
    });

    const statements = client.calls.map((c) => c.text);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED');
    // Timeouts go through set_config (transaction-local), never a parameterized `SET` (42601).
    const setConfig = client.calls.filter((c) => c.text === 'SELECT set_config($1, $2, true)');
    expect(setConfig.map((c) => c.params?.[0])).toEqual([
      'statement_timeout',
      'lock_timeout',
      'idle_in_transaction_session_timeout',
    ]);
    expect(statements).toContain('SELECT 1');
    expect(statements).toContain('COMMIT');
    expect(client.released).toBe(true);
  });

  it('rolls back and still releases when the work throws', async () => {
    const client = new FakeClient();
    client.failOn = { match: (t) => t === 'SELECT boom', error: new Error('work failed') };
    const { db } = fakeDatabase(client);

    await expect(
      withTransaction(db, { label: 'test.fail' }, async (c) => c.query('SELECT boom')),
    ).rejects.toThrow('work failed');

    const statements = client.calls.map((c) => c.text);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(client.released).toBe(true);
  });

  it('uses exactly one client per transaction (never pool.query mid-transaction)', async () => {
    const client = new FakeClient();
    const { db, connectCount } = fakeDatabase(client);
    await withTransaction(db, { label: 'test.single' }, async () => undefined);
    expect(connectCount()).toBe(1);
  });

  it('honours an explicit isolation level', async () => {
    const client = new FakeClient();
    const { db } = fakeDatabase(client);
    await withTransaction(
      db,
      { label: 'test.serializable', isolation: ISOLATION_LEVELS.serializable },
      async () => undefined,
    );
    expect(client.calls[0]?.text).toBe('BEGIN ISOLATION LEVEL SERIALIZABLE');
  });

  it('applies default timeouts when the caller supplies none', async () => {
    const client = new FakeClient();
    const { db } = fakeDatabase(client);
    await withTransaction(db, { label: 'test.defaults' }, async () => undefined);
    const statementTimeout = client.calls.find((c) => c.params?.[0] === 'statement_timeout');
    expect(statementTimeout?.params).toEqual(['statement_timeout', String(DEFAULT_TIMEOUTS.statementTimeoutMs)]);
  });
});

describe('runWithTransientRetry', () => {
  const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 4, label: 'test' };
  const noSleepRandom = () => 0;

  it('retries serialization failures (40001) and deadlocks (40P01) up to the bound', async () => {
    let attempts = 0;
    const result = await runWithTransientRetry(
      policy,
      async () => {
        attempts += 1;
        if (attempts < 3) throw pgError(attempts === 1 ? '40001' : '40P01');
        return 'committed';
      },
      { random: noSleepRandom },
    );
    expect(result).toBe('committed');
    expect(attempts).toBe(3);
  });

  it('does NOT retry check violations, unique violations or unknown errors', async () => {
    for (const code of ['23514', '23505', 'XX000']) {
      let attempts = 0;
      await expect(
        runWithTransientRetry(
          policy,
          async () => {
            attempts += 1;
            throw pgError(code);
          },
          { random: noSleepRandom },
        ),
      ).rejects.toThrow();
      expect(attempts).toBe(1);
    }
  });

  it('gives up after maxAttempts on persistent transient failures and surfaces the original error', async () => {
    let attempts = 0;
    await expect(
      runWithTransientRetry(
        policy,
        async () => {
          attempts += 1;
          throw pgError('40001');
        },
        { random: noSleepRandom },
      ),
    ).rejects.toThrow('pg 40001');
    expect(attempts).toBe(policy.maxAttempts);
  });

  it('computes full-jitter delays bounded by the exponential ceiling', () => {
    const p: RetryPolicy = { maxAttempts: 5, baseDelayMs: 10, maxDelayMs: 100, label: 'jitter' };
    expect(delayForAttempt(0, p, () => 1)).toBe(10); // ceil = min(100, 10*2^0) = 10
    expect(delayForAttempt(3, p, () => 1)).toBe(80); // ceil = min(100, 10*2^3) = 80
    expect(delayForAttempt(10, p, () => 1)).toBe(100); // clamped by maxDelayMs
    expect(delayForAttempt(2, p, () => 0)).toBe(0); // full jitter can sample zero
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = delayForAttempt(attempt, p, Math.random);
      const ceiling = Math.min(100, 10 * 2 ** attempt);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe('isolationFromName', () => {
  it('maps documented names and rejects anything else with a 400-classified error', () => {
    expect(isolationFromName('serializable')).toBe(ISOLATION_LEVELS.serializable);
    expect(() => isolationFromName('read_uncommitted')).toThrow(AppError);
    try {
      isolationFromName('nope');
    } catch (error) {
      expect((error as AppError).status).toBe(400);
    }
  });
});
