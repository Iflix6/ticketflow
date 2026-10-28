import type { Client, Executor, Pool } from './db.js';
import { withTransaction } from './db.js';

/**
 * Transactional outbox relay (ADR-0005). Business transactions only ever INSERT into `outbox_events`;
 * this relay is the single component that turns those rows into queue jobs. It is the piece that makes
 * "the DB committed AND the event will be delivered" a restart-safe, duplicate-safe guarantee.
 */

/** The payload a relayed outbox row becomes as a queue job. `outboxId` is the dedup key everywhere. */
export type OutboxJobData = {
  outboxId: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

/**
 * Transport seam. The production implementation adds to a BullMQ queue keyed by a deterministic job id
 * derived from `outboxId`; tests inject an in-memory spy that keeps its own list under the same rule.
 * The contract is: dispatching the same `outboxId` twice MUST NOT create a second unit of work while
 * the transport still knows about the first, and it must throw if the transport is unreachable (so the
 * row stays unpublished). It deliberately does NOT report "added vs deduped": BullMQ v6 resolves `add`
 * to the pre-existing job either way, so that distinction is not observable from here without racing
 * extra round trips — and no correctness property or metric depends on it, because the consumer's dedup
 * marker is what actually makes delivery duplicate-safe.
 */
export interface Dispatcher {
  dispatch(job: OutboxJobData): Promise<void>;
}

type ClaimedRow = { id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload: Record<string, unknown> };

export interface RelayResult {
  claimed: number;
  /** Rows whose dispatch succeeded, and which are now marked published. */
  published: number;
  failed: number;
}

/**
 * One relay tick. Inside a SINGLE transaction holding `FOR UPDATE SKIP LOCKED` row locks:
 *   1. claim the oldest unpublished rows (never deletes — marks),
 *   2. dispatch each to the transport (a side effect OUTSIDE the DB transaction),
 *   3. mark exactly the successfully-dispatched ids published.
 * A crash between (2) and (3) rolls the transaction back, so the rows stay unpublished and the NEXT
 * tick re-dispatches with the SAME job id — while the transport still holds the record it refuses to
 * duplicate the work, and the consumer's `consumed_events` marker absorbs any delivery that arrives
 * after the retention window has already pruned that record. `fault.beforeMark` throws at precisely
 * that window to let a test prove this, not assume it.
 */
export async function relayOnce(
  pool: Pool,
  dispatcher: Dispatcher,
  options: { batchSize: number; fault?: { beforeMark?: () => void } },
): Promise<RelayResult> {
  const client = await pool.connect();
  const summary: RelayResult = { claimed: 0, published: 0, failed: 0 };
  try {
    await client.query('BEGIN');
    const claimed = await claimUnpublished(client, options.batchSize);
    summary.claimed = claimed.length;
    if (claimed.length === 0) {
      await client.query('COMMIT');
      return summary;
    }

    const publishedIds: string[] = [];
    for (const row of claimed) {
      const job: OutboxJobData = {
        outboxId: row.id,
        eventType: row.event_type,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: row.payload,
      };
      try {
        await dispatcher.dispatch(job);
        summary.published += 1;
        publishedIds.push(row.id);
      } catch (error) {
        // Transport failure (e.g. Redis down): keep the row unpublished, record why, retry next tick.
        summary.failed += 1;
        await recordDispatchError(client, row.id, error);
      }
    }

    options.fault?.beforeMark?.();

    if (publishedIds.length > 0) {
      await markPublished(client, publishedIds);
    }
    await client.query('COMMIT');
    return summary;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Claims the oldest unpublished rows and locks them against a concurrent relay (SKIP LOCKED = no waits). */
async function claimUnpublished(client: Client, limit: number): Promise<ClaimedRow[]> {
  // `id::text` keeps the value parser-independent (the API process installs an INT8→BigInt pg parser
  // globally; the worker must read the same rows as plain text so ids never drift between the two).
  const result = await client.query<ClaimedRow>(
    `SELECT id::text AS id, event_type, aggregate_type, aggregate_id::text AS aggregate_id, payload
       FROM outbox_events
      WHERE published_at IS NULL
      ORDER BY id
      LIMIT $1
      FOR UPDATE SKIP LOCKED`,
    [limit],
  );
  return result.rows;
}

async function markPublished(client: Client, ids: readonly string[]): Promise<void> {
  // ids are text; cast back to bigint for the comparison so we do not depend on an implicit coercion.
  await client.query(
    `UPDATE outbox_events
        SET published_at = app.now(), attempt_count = attempt_count + 1
      WHERE id = ANY(SELECT (unnest($1::text[]))::bigint)`,
    [ids],
  );
}

async function recordDispatchError(client: Client, id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await client.query(
    `UPDATE outbox_events
        SET attempt_count = attempt_count + 1, last_error = $2
      WHERE id = $1::bigint`,
    [id, message.slice(0, 500)],
  );
}

/**
 * Backlog snapshot used by the relay's own logging, the reconciliation sweeper and the readiness probe.
 * `oldestAgeSeconds` is exactly the ADR's `outbox_age_seconds` alert signal, measured from the DB clock.
 */
export async function outboxBacklog(executor: Executor): Promise<{ unpublished: number; oldestAgeSeconds: number | null }> {
  const result = await executor.query<{ unpublished: string; oldest_age: number | null }>(
    `SELECT COUNT(*)::text AS unpublished,
            FLOOR(EXTRACT(EPOCH FROM (app.now() - MIN(created_at))))::int AS oldest_age
       FROM outbox_events
      WHERE published_at IS NULL`,
  );
  const row = result.rows[0];
  return { unpublished: Number(row?.unpublished ?? '0'), oldestAgeSeconds: row?.oldest_age ?? null };
}

/** Convenience for callers that already hold a pool and want the backlog without threading an executor. */
export const backlogOf = (pool: Pool): Promise<{ unpublished: number; oldestAgeSeconds: number | null }> =>
  withTransaction(pool, async (client) => outboxBacklog(client));
