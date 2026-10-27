import type { Queryable } from '../../db/pool.js';

/**
 * Idempotency key acquisition (ADR-0004, data-model §6).
 *
 * Everything here runs on the caller's transactional client — the key row is inserted in the SAME
 * transaction as the business write it guards. That single choice gives the three hardest properties
 * for free:
 * - a rollback removes the `IN_PROGRESS` row with the business effects, so a retry is unblocked;
 * - a committed row always ends the transaction `COMPLETED` (there is no window where a committed
 *   row is stuck in-progress), so `COMPLETED` replay is the only steady state;
 * - the unique index `(scope_user_id, scope_endpoint, key)` is the arbiter of concurrent duplicates:
 *   a second concurrent insert with the same key blocks on the index until the first commits, then
 *   `ON CONFLICT DO NOTHING` yields no row and we fall through to reading the committed outcome.
 */

export type IdempotencyAcquisition =
  | { readonly status: 'NEW'; readonly recordId: string }
  | { readonly status: 'REPLAY'; readonly responseStatus: number; readonly responseBody: unknown }
  | { readonly status: 'IN_PROGRESS' }
  | { readonly status: 'REUSE_MISMATCH' };

export interface AcquireParams {
  readonly scopeUserId: string;
  readonly scopeEndpoint: string;
  readonly key: string;
  readonly requestHash: string;
  readonly ttlHours: number;
}

interface ExistingRow {
  state: 'IN_PROGRESS' | 'COMPLETED';
  request_hash: string;
  response_status: number | null;
  response_body: unknown;
}

export async function acquireIdempotency(
  client: Queryable,
  params: AcquireParams,
): Promise<IdempotencyAcquisition> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO idempotency_records (scope_user_id, scope_endpoint, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'IN_PROGRESS', app.now() + make_interval(hours => $5::int))
     ON CONFLICT (scope_user_id, scope_endpoint, key) DO NOTHING
     RETURNING id`,
    [params.scopeUserId, params.scopeEndpoint, params.key, params.requestHash, params.ttlHours],
  );

  const recordId = inserted.rows[0]?.id;
  if (recordId !== undefined) return { status: 'NEW', recordId };

  // Key already exists (committed by a prior request, or by the transaction we just waited on).
  const existing = await client.query<ExistingRow>(
    `SELECT state, request_hash, response_status, response_body
       FROM idempotency_records
      WHERE scope_user_id = $1 AND scope_endpoint = $2 AND key = $3`,
    [params.scopeUserId, params.scopeEndpoint, params.key],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    // The concurrent inserter rolled back between our conflict and our read; treat as still absent so
    // the caller's transaction can retry acquisition rather than mis-reporting a state.
    return { status: 'IN_PROGRESS' };
  }
  if (row.state === 'IN_PROGRESS') return { status: 'IN_PROGRESS' };
  if (row.request_hash !== params.requestHash) return { status: 'REUSE_MISMATCH' };
  return { status: 'REPLAY', responseStatus: row.response_status ?? 200, responseBody: row.response_body };
}

/** Marks the key `COMPLETED` with the exact status/body to replay. Same transaction as the write. */
export async function completeIdempotency(
  client: Queryable,
  params: {
    readonly recordId: string;
    readonly responseStatus: number;
    readonly responseBody: unknown;
    readonly resourceType: string;
    readonly resourceId: string;
  },
): Promise<void> {
  await client.query(
    `UPDATE idempotency_records
        SET state = 'COMPLETED',
            response_status = $2,
            response_body = $3::jsonb,
            resource_type = $4,
            resource_id = $5
      WHERE id = $1`,
    [
      params.recordId,
      params.responseStatus,
      JSON.stringify(params.responseBody),
      params.resourceType,
      params.resourceId,
    ],
  );
}
