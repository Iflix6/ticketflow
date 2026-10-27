import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { bootstrapConfig, ConfigError } from '@ticketflow/config';

/**
 * Versioned SQL migration runner. No framework — the rules are short enough to audit in one file:
 *
 * - migrations live in apps/api/src/db/migrations as `NNNN_name.up.sql` / `NNNN_name.down.sql`;
 * - each version is applied inside its own transaction (DDL is transactional in PostgreSQL),
 *   so a failed migration leaves the database exactly as it was;
 * - applied versions are recorded in `migrations.schema_migrations` with a checksum of the file, and a
 *   changed already-applied file is a hard error rather than a silent re-run;
 * - `--down [n]` rolls back the newest `n` applied versions (default 1) using their `.down.sql`,
 *   in reverse order. Rollback scripts are reviewed alongside the forward ones in every PR.
 *
 * Usage: npm run migrate | npm run migrate:down [-- 1]
 */

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../apps/api/src/db/migrations',
);

const MAX_MIGRATION_LOCK_ID = 720_300_101; // arbitrary fixed advisory lock key for this app

interface MigrationFile {
  version: number;
  name: string;
  upPath: string;
}

function listMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith('.up.sql'))
    .map((file) => {
      const match = /^(\d{4}_(.+))\.up\.sql$/.exec(file);
      if (!match?.[1] || !match[2]) throw new Error(`Unrecognized migration filename: ${file}`);
      return {
        version: Number(match[1].slice(0, 4)),
        name: match[2],
        upPath: path.join(MIGRATIONS_DIR, file),
      };
    })
    .sort((a, b) => a.version - b.version);
}

async function ensureLedger(client: pg.PoolClient): Promise<void> {
  // The ledger is deliberately NOT inside `app`: migration 0001 owns that schema and its rollback
  // drops it, so a ledger living there would make a full `--down` impossible to complete.
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS migrations;
    CREATE TABLE IF NOT EXISTS migrations.schema_migrations (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      checksum    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/** Integrity check over the file bytes: sha256, no extension needed. */
function checksum(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

async function up(client: pg.PoolClient, migrations: MigrationFile[]): Promise<void> {
  let applied = 0;
  for (const migration of migrations) {
    const sum = checksum(migration.upPath);
    const existing = await client.query<{ checksum: string }>(
      'SELECT checksum FROM migrations.schema_migrations WHERE version = $1',
      [migration.version],
    );

    if (existing.rowCount !== null && existing.rowCount > 0) {
      const recorded = existing.rows[0]?.checksum;
      if (recorded !== sum) {
        throw new Error(
          `Migration ${migration.version}_${migration.name} changed after being applied ` +
            `(recorded ${recorded?.slice(0, 12)}…, file ${sum.slice(0, 12)}…). ` +
            'Add a new migration instead of editing history.',
        );
      }
      continue;
    }

    const sql = readFileSync(migration.upPath, 'utf8');
    process.stdout.write(`applying ${migration.version}_${migration.name} ... `);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query(
        'INSERT INTO migrations.schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, sum],
      );
      await client.query('COMMIT');
      console.log('ok');
      applied += 1;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.log('FAILED (rolled back)');
      throw error;
    }
  }
  console.log(applied === 0 ? 'database is up to date' : `applied ${applied} migration(s)`);
}

async function down(client: pg.PoolClient, count: number): Promise<void> {
  const rows = await client.query<{ version: number; name: string }>(
    'SELECT version, name FROM migrations.schema_migrations ORDER BY version DESC LIMIT $1',
    [count],
  );
  if (rows.rowCount === 0) {
    console.log('nothing to roll back');
    return;
  }

  for (const row of rows.rows) {
    const files = readdirSync(MIGRATIONS_DIR);
    const downFile = `${String(row.version).padStart(4, '0')}_${row.name}.down.sql`;
    if (!files.includes(downFile)) throw new Error(`Missing rollback script for ${row.version}_${row.name}`);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, downFile), 'utf8');

    process.stdout.write(`rolling back ${row.version}_${row.name} ... `);
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('DELETE FROM migrations.schema_migrations WHERE version = $1', [row.version]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.log('FAILED (rolled back)');
      throw error;
    }
  }
}

async function main(): Promise<void> {
  const config = bootstrapConfig();
  const args = process.argv.slice(2);
  const isDown = args.includes('--down');
  const rawCount = args[args.indexOf('--down') + 1];
  const downCount = rawCount === undefined ? 1 : Number(rawCount);

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  try {
    // A session lock serializes concurrent deploy steps instead of racing on the same DDL.
    await client.query('SELECT pg_advisory_lock($1)', [MAX_MIGRATION_LOCK_ID]);
    await ensureLedger(client);
    if (isDown) {
      if (!Number.isInteger(downCount) || downCount < 1) throw new Error(`Invalid rollback count: ${rawCount}`);
      await down(client, downCount);
    } else {
      await up(client, listMigrations());
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MAX_MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.exit(1); // report already printed by bootstrapConfig
  }
  console.error('[migrate]', error instanceof Error ? error.message : error);
  process.exit(1);
});
