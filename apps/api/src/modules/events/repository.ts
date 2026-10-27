import type { Database, Queryable, SqlClient } from '../../db/pool.js';
import { asQueryable } from '../../db/pool.js';

/**
 * Events and tiers: read-only SQL. Explicit column lists (no `SELECT *`) so a column addition cannot
 * change a response shape by accident.
 */

export type EventRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  start_at: Date;
  status: string;
  created_at: Date;
  updated_at: Date;
};

export type TierRow = {
  id: string;
  event_id: string;
  name: string;
  price_display_only: string;
  currency: string;
  capacity: number;
  created_at: Date;
  updated_at: Date;
};

/** Tier joined with its authoritative counters; `available` here is a read, never a decision. */
export type TierWithInventoryRow = TierRow & {
  tier_id: string;
  available: number;
  reserved: number;
  sold: number;
  version: number;
  inventory_capacity: number;
  inventory_updated_at: Date;
};

export type ListOptions = {
  page: number;
  pageSize: number;
  status?: string;
};

export class EventsRepository {
  constructor(private readonly db: Database) {}

  async listEvents(options: ListOptions, client?: SqlClient): Promise<{ rows: EventRow[]; total: number }> {
    const executor: Queryable = client === undefined ? this.db : asQueryable(client);
    const offset = (options.page - 1) * options.pageSize;

    // The status filter is a nullable parameter rather than a spliced predicate, so both statements
    // always bind a fixed parameter count (a mismatched bind list is a PostgreSQL protocol error).
    const rowsResult = await executor.query<EventRow>(
      `SELECT e.id, e.slug, e.title, e.description, e.start_at, e.status, e.created_at, e.updated_at
         FROM events e
        WHERE ($3::text IS NULL OR e.status = $3)
        ORDER BY e.start_at ASC, e.id ASC
        LIMIT $1 OFFSET $2`,
      [options.pageSize, offset, options.status ?? null],
    );

    const countResult = await executor.query<{ total: string }>(
      `SELECT COUNT(*)::text AS total
         FROM events e
        WHERE ($1::text IS NULL OR e.status = $1)`,
      [options.status ?? null],
    );

    return { rows: rowsResult.rows, total: Number(countResult.rows[0]?.total ?? '0') };
  }

  async findEventById(id: string, client?: SqlClient): Promise<EventRow | undefined> {
    const executor: Queryable = client === undefined ? this.db : asQueryable(client);
    const result = await executor.query<EventRow>(
      `SELECT id, slug, title, description, start_at, status, created_at, updated_at
         FROM events WHERE id = $1`,
      [id],
    );
    return result.rows[0];
  }

  async findTiersForEvent(eventId: string, client?: SqlClient): Promise<TierWithInventoryRow[]> {
    const executor: Queryable = client === undefined ? this.db : asQueryable(client);
    const result = await executor.query<TierWithInventoryRow>(
      `SELECT t.id, t.event_id, t.name, t.price_display_only, t.currency, t.capacity,
              t.created_at, t.updated_at,
              i.tier_id, i.available, i.reserved, i.sold, i.version,
              i.capacity AS inventory_capacity, i.updated_at AS inventory_updated_at
         FROM ticket_tiers t
         JOIN inventory i ON i.tier_id = t.id
        WHERE t.event_id = $1
        ORDER BY t.price_display_only ASC, t.name ASC`,
      [eventId],
    );
    return result.rows;
  }

  async findTierWithInventory(tierId: string, client?: SqlClient): Promise<TierWithInventoryRow | undefined> {
    const executor: Queryable = client === undefined ? this.db : asQueryable(client);
    const result = await executor.query<TierWithInventoryRow>(
      `SELECT t.id, t.event_id, t.name, t.price_display_only, t.currency, t.capacity,
              t.created_at, t.updated_at,
              i.tier_id, i.available, i.reserved, i.sold, i.version,
              i.capacity AS inventory_capacity, i.updated_at AS inventory_updated_at
         FROM ticket_tiers t
         JOIN inventory i ON i.tier_id = t.id
        WHERE t.id = $1`,
      [tierId],
    );
    return result.rows[0];
  }
}
