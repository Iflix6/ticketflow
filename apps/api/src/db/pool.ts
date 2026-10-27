import pg from 'pg';
import type { AppConfig } from '@ticketflow/config';
import { appMetrics } from '../observability/metrics.js';

const { Pool, types } = pg;

/**
 * PostgreSQL access layer.
 *
 * Two deliberate choices:
 * - `pg.Pool` is created once per process and handed around explicitly (dependency injection), so
 *   tests can build a second pool against the same database and exercise multi-process contention.
 * - numeric (`1700`) is parsed as string, not float. Ticket prices and totals are money-shaped:
 *   float parsing would be a silent rounding bug in reports.
 */
types.setTypeParser(types.builtins.NUMERIC, (value: string | null) => value ?? '0');

/** Integer overflow protection for bigint columns (latency micros, outbox ids). */
types.setTypeParser(types.builtins.INT8, (value: string | null) => (value === null ? null : BigInt(value)));

export type SqlClient = pg.PoolClient;
/** Row shapes accepted by `pg`. Re-exported so repository row types are checked against the same
 *  constraint `pg` itself uses (`Record<string, any>`) — a plain `Record<string, unknown>` constraint
 *  would reject object types without an index signature, which is a tsc artifact, not a safety win. */
export type QueryResultRow = pg.QueryResultRow;
export type QueryResult<T extends QueryResultRow = QueryResultRow> = pg.QueryResult<T>;

export interface Database {
  readonly pool: pg.Pool;
  query<T extends QueryResultRow = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<pg.QueryResult<T>>;
  /** Acquire a dedicated client. Callers MUST release it in a finally block. */
  connect(): Promise<SqlClient>;
  close(): Promise<void>;
  stats(): { totalCount: number; idleCount: number; waitingCount: number };
}

/**
 * Anything that can run a parameterized statement: the pool (autocommit) or a `PoolClient` inside a
 * transaction. Repositories accept either so the same SQL can run inside or outside a transaction.
 */
export type Queryable = Pick<Database, 'query'>;

export function asQueryable(target: SqlClient): Queryable {
  // `pg`'s own `query` overloads are structurally compatible with `Queryable`; the cast only narrows
  // the public surface so repositories cannot reach transaction control statements.
  return target as unknown as Queryable;
}

export class PostgresTimeouts {
  constructor(
    readonly statementTimeoutMs: number,
    readonly lockTimeoutMs: number,
    readonly idleInTransactionTimeoutMs: number,
  ) {}
}

/**
 * Timeouts are applied per transaction with `SET LOCAL` so a misbehaving session cannot hold locks
 * indefinitely. They are sent as three statements on purpose: PostgreSQL's extended protocol (used by
 * `query(text, params)`) rejects multiple statements in one command, so a single
 * `SET LOCAL a; SET LOCAL b;` string would fail at runtime.
 */
export async function applySessionTimeouts(client: SqlClient, timeouts: PostgresTimeouts): Promise<void> {
  await client.query('SET LOCAL statement_timeout = $1', [timeouts.statementTimeoutMs]);
  await client.query('SET LOCAL lock_timeout = $1', [timeouts.lockTimeoutMs]);
  await client.query('SET LOCAL idle_in_transaction_session_timeout = $1', [
    timeouts.idleInTransactionTimeoutMs,
  ]);
}

export function createPool(config: AppConfig): pg.Pool {
  return new Pool({
    connectionString: config.DATABASE_URL,
    max: config.PG_POOL_MAX,
    connectionTimeoutMillis: config.PG_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: config.PG_IDLE_TIMEOUT_MS,
    // Applied to every connection; per-transaction SET LOCAL can tighten further.
    statement_timeout: config.STATEMENT_TIMEOUT_MS,
    query_timeout: config.STATEMENT_TIMEOUT_MS,
    lock_timeout: config.LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: config.IDLE_IN_TRANSACTION_TIMEOUT_MS,
    application_name: `ticketflow-${config.NODE_ENV}`,
  });
}

export function createDatabase(config: AppConfig, pool = createPool(config)): Database {
  pool.on('error', (error) => {
    // An idle client error must never crash the process, but it must never be silent either.
    appMetrics.poolErrors.inc({ phase: 'idle' });
    console.error('[db] idle pool client error', error.message);
  });

  return {
    pool,
    query: <T extends QueryResultRow>(text: string, params?: readonly unknown[]) =>
      pool.query<T>(text, params as unknown[] | undefined),
    connect: () => pool.connect(),
    close: () => pool.end(),
    stats: () => ({
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    }),
  };
}

/** Publishes pool utilisation to Prometheus so a saturation incident is visible, not guessed. */
export function bindPoolMetrics(db: Database): NodeJS.Timeout {
  const timer = setInterval(() => {
    const stats = db.stats();
    appMetrics.poolConnections.set({ state: 'total' }, stats.totalCount);
    appMetrics.poolConnections.set({ state: 'idle' }, stats.idleCount);
    appMetrics.poolConnections.set({ state: 'waiting' }, stats.waitingCount);
  }, 2000);
  timer.unref();
  return timer;
}
