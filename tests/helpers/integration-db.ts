import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { AppConfig } from '@ticketflow/config';
import { createDatabase, type Database } from '../../apps/api/src/db/pool.js';

/**
 * Integration-test harness (used only under `tests/integration`).
 *
 * Guarantees:
 * - each suite file gets its own database (`ticketflow_test_<suite>`), created through an admin
 *   connection; concurrent CI shards therefore cannot see each other's rows;
 * - the REAL migration files (same bytes `npm run migrate` applies) build the schema — tests never
 *   run against a hand-copied "test schema" that could drift from production;
 * - if `TF_TEST_DATABASE_URL` is unset AND no `.env` provides a DATABASE_URL, `connect()` throws a
 *   clear message and the suite file skips instead of passing vacuously.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS_DIR = path.join(root, 'apps/api/src/db/migrations');

export interface TestDatabaseHandle {
  db: Database;
  adminUrl: string;
  databaseName: string;
  cleanup(): Promise<void>;
}

function dotenvValue(key: string): string | undefined {
  const envFile = path.join(root, '.env');
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] === key) return match[2]?.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

/** Admin connection string with its database component removed, for CREATE/DROP DATABASE. */
function adminConnectionUrl(): string {
  const url =
    process.env['TF_TEST_DATABASE_URL'] ??
    process.env['DATABASE_URL'] ??
    dotenvValue('DATABASE_URL');
  if (url === undefined) {
    throw new Error(
      'integration tests need TF_TEST_DATABASE_URL (or DATABASE_URL in .env) pointing at a PostgreSQL ' +
        'the test role may create databases with; e.g. `npm run db:up`',
    );
  }
  return url;
}

function testDatabaseName(suite: string): string {
  const base = adminConnectionUrl();
  // Prefer the URL's own database name when it already targets a dedicated test DB.
  const fromUrl = new URL(base).pathname.slice(1);
  const prefix = fromUrl.startsWith('ticketflow_test') ? fromUrl : 'ticketflow_test';
  return `${prefix}_${suite.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
}

export function databaseAvailable(): boolean {
  try {
    adminConnectionUrl();
    return true;
  } catch {
    return false;
  }
}

export async function startTestDatabase(suite: string): Promise<TestDatabaseHandle> {
  const adminUrl = adminConnectionUrl();
  const databaseName = testDatabaseName(suite);
  const admin = new pg.Client({ connectionString: adminUrl, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${pg.escapeIdentifier(databaseName)}`);
  } finally {
    await admin.end();
  }

  const target = new URL(adminUrl);
  target.pathname = `/${databaseName}`;
  const connectionString = target.toString();

  // Apply migrations with a plain client (ledger table included) exactly like the real runner.
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS migrations');
    await client.query(
      'CREATE TABLE IF NOT EXISTS migrations.schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum text NOT NULL DEFAULT \'\', applied_at timestamptz NOT NULL DEFAULT now())',
    );
    await client.query('CREATE SCHEMA IF NOT EXISTS app');
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.up.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO migrations.schema_migrations (version, name) VALUES ($1, $2)', [
          Number(file.slice(0, 4)),
          file.replace(/^\d{4}_/, '').replace(/\.up\.sql$/, ''),
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${file} failed in test database: ${String(error)}`);
      }
    }
  } finally {
    await client.end();
  }

  const pool = new pg.Pool({ connectionString, max: 10 });
  const db = createDatabase(fakeConfig(connectionString), pool);

  return {
    db,
    adminUrl,
    databaseName,
    cleanup: async () => {
      await db.close();
      const cleaner = new pg.Client({ connectionString: adminUrl, database: 'postgres' });
      await cleaner.connect();
      try {
        await cleaner.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(databaseName)} WITH (FORCE)`);
      } finally {
        await cleaner.end();
      }
    },
  };
}

/**
 * `createDatabase` reads only DATABASE_URL from config; tests pass a frozen partial object cast to
 * AppConfig instead of fabricating a "validated" config that was never validated.
 */
function fakeConfig(connectionString: string): AppConfig {
  return Object.freeze({ DATABASE_URL: connectionString } as unknown as AppConfig);
}

/** Quiescence helper for invariant assertions between phases of a test. */
export async function seedCatalog(
  db: Database,
  eventSlug: string,
  tierName: string,
  capacity: number,
): Promise<{ eventId: string; tierId: string }> {
  const event = await db.query<{ id: string }>(
    `INSERT INTO events (slug, title, description, start_at, status)
     VALUES ($1, $2, 'integration fixture', now() + interval '30 days', 'ON_SALE')
     RETURNING id`,
    [eventSlug, `Integration event ${eventSlug}`],
  );
  const eventId = event.rows[0]?.id;
  if (eventId === undefined) throw new Error('event insert returned no row');

  const tier = await db.query<{ id: string }>(
    `INSERT INTO ticket_tiers (event_id, name, price_display_only, capacity)
     VALUES ($1, $2, '10.00', $3)
     RETURNING id`,
    [eventId, tierName, capacity],
  );
  const tierId = tier.rows[0]?.id;
  if (tierId === undefined) throw new Error('tier insert returned no row');

  await db.query(
    `INSERT INTO inventory (tier_id, capacity, available, reserved, sold)
     VALUES ($1, $2, $2, 0, 0)`,
    [tierId, capacity],
  );
  return { eventId, tierId };
}

export async function seedUser(db: Database, email: string, role: 'CUSTOMER' | 'LAB_ADMIN' = 'CUSTOMER'): Promise<string> {
  const result = await db.query<{ id: string }>(
    'INSERT INTO app_users (email, role) VALUES ($1, $2) RETURNING id',
    [email, role],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('user insert returned no row');
  return id;
}
