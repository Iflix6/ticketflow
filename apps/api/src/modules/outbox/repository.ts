import type { Queryable } from '../../db/pool.js';

/**
 * Transactional outbox + audit writes (ADR-0005).
 *
 * Both are INSERTs into the caller's transaction. The outbox row is what makes "the DB committed
 * and the event exists" atomic — a Phase-4 relay publishes `published_at IS NULL` rows later, so a
 * crash after commit can never lose a business event (at-least-once, consumers deduplicate). The
 * audit row is the same idea for human inspection: actor/action/aggregate with PII-free metadata.
 *
 * The relay, retries and dead-lettering are Phase 4. Phase 2 only *writes* events, because that is
 * the part whose correctness is bound to the reservation transaction.
 */

export type AggregateType = 'reservation' | 'booking' | 'inventory' | 'experiment_run';

export interface OutboxEvent {
  readonly eventType: string;
  readonly aggregateType: AggregateType;
  readonly aggregateId: string;
  readonly payload: Record<string, unknown>;
}

export async function insertOutboxEvent(client: Queryable, event: OutboxEvent): Promise<void> {
  await client.query(
    `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, payload)
     VALUES ($1, $2, $3, $4::jsonb)`,
    [event.eventType, event.aggregateType, event.aggregateId, JSON.stringify(event.payload)],
  );
}

export interface AuditWrite {
  readonly actorUserId: string | null;
  readonly actorKind: 'user' | 'system' | 'worker' | 'lab' | 'anonymous';
  readonly action: string;
  readonly aggregateType: string;
  readonly aggregateId: string | null;
  readonly metadata: Record<string, unknown>;
  readonly requestId: string | null;
}

export async function recordAudit(client: Queryable, audit: AuditWrite): Promise<void> {
  await client.query(
    `INSERT INTO audit_records (actor_user_id, actor_kind, action, aggregate_type, aggregate_id, metadata, request_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      audit.actorUserId,
      audit.actorKind,
      audit.action,
      audit.aggregateType,
      audit.aggregateId,
      JSON.stringify(audit.metadata),
      audit.requestId,
    ],
  );
}
