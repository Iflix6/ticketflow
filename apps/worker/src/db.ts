import type pg from 'pg';

/**
 * Worker database access. The worker talks to PostgreSQL directly (it is a separate process from the
 * API on purpose — ADR-0001), but it reuses the SAME migration files and the same `app.now()` clock,
 * so its view of the data is identical to the API's. Nothing here imports from `apps/api`: the shared
 * contract is the database schema itself, not TypeScript symbols.
 */

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/**
 * Runs `fn` inside a single transaction on a dedicated client. COMMIT on success, ROLLBACK on any
 * throw, and ALWAYS release the client back to the pool in `finally` — a leaked client is how a
 * poller silently exhausts the pool and the whole recovery loop freezes.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Anything that can run a parameterized query — the pool (autocommit) or a client (in a transaction). */
export type Executor = Pick<Pool, 'query'> | Client;
