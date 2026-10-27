import { execFile } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseAvailable, startTestDatabase, type TestDatabaseHandle } from '../helpers/integration-db.js';

const run = promisify(execFile);
const suite = databaseAvailable() ? describe : describe.skip;
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// Node 24 refuses to spawn `.cmd` shims without a shell (EINVAL), so npm is invoked through its
// own CLI JavaScript entrypoint — the same code `npm.cmd` wraps, portable across platforms.
const npmCliDir = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCli = existsSync(npmCliDir) ? npmCliDir : path.join(path.dirname(process.execPath), 'npm-cli.js');

/**
 * Proves the *actual operational commands* work end-to-end — not a reimplementation of them:
 * `npm run migrate` (up), `npm run seed -- --experiment`, `npm run invariants`, `npm run migrate:down`.
 * This is the "fresh checkout boots" gate in miniature, executed against a throwaway database.
 */
suite('operational scripts run for real', () => {
  let handle: TestDatabaseHandle;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    handle = await startTestDatabase('scripts');
    // The harness already migrated; start from a blank database so `migrate` has real work to do.
    const client = new pg.Client({ connectionString: handle.adminUrl, database: 'postgres' });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(handle.databaseName)} WITH (FORCE)`);
      await client.query(`CREATE DATABASE ${pg.escapeIdentifier(handle.databaseName)}`);
    } finally {
      await client.end();
    }
    const url = new URL(handle.adminUrl);
    url.pathname = `/${handle.databaseName}`;
    env = {
      ...process.env,
      DATABASE_URL: url.toString(),
      NODE_ENV: 'test',
      // bootstrapConfig requires these; values are test-local.
      REDIS_URL: process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379',
      AUTH_SECRET: 'scripts_test_secret_value_at_least_32_chars_long',
      LOG_LEVEL: 'silent',
    };
  });

  afterAll(async () => {
    await handle.cleanup().catch(() => undefined);
  });

  const npmRun = async (script: string, args: string[] = []): Promise<string> => {
    const { stdout, stderr } = await run(
      process.execPath,
      [npmCli, 'run', script, ...(args.length ? ['--', ...args] : [])],
      {
        cwd: repoRoot,
        env: env as NodeJS.ProcessEnv,
        timeout: 120_000,
      },
    );
    return `${stdout}${stderr}`;
  };

  it('migrates a fresh database, seeds it, passes invariants, and rolls back cleanly', async () => {
    const up = await npmRun('migrate');
    expect(up).toMatch(/applied 9 migration\(s\)/);

    const seed = await npmRun('seed', ['--experiment']);
    expect(seed).toMatch(/seed complete/);

    // The seeded catalog actually exists with constraint-consistent counters.
    const probe = new pg.Client({ connectionString: env['DATABASE_URL'] });
    await probe.connect();
    try {
      const inventory = await probe.query(
        'SELECT capacity, available, reserved, sold FROM inventory ORDER BY capacity DESC LIMIT 5',
      );
      expect(inventory.rowCount).toBeGreaterThanOrEqual(4);
      for (const row of inventory.rows) {
        expect(Number(row.available) + Number(row.reserved) + Number(row.sold)).toBe(Number(row.capacity));
      }
      const lab = await probe.query('SELECT COUNT(*)::int AS n FROM lab.inventory');
      expect(lab.rows[0]?.n).toBe(1); // experiment fixture via lab.reset_fixture
      const admin = await probe.query("SELECT role FROM app_users WHERE email = 'lab@local.test'");
      expect(admin.rows[0]?.role).toBe('LAB_ADMIN');
    } finally {
      await probe.end();
    }

    const invariants = await npmRun('invariants', ['--quiescent']);
    expect(invariants).toMatch(/all invariants hold/);

    // Full rollback: every migration down in reverse order, ending with no ledger rows.
    const down = await npmRun('migrate:down', ['9']);
    expect(down).toMatch(/rolling back 9_invariant_views \.\.\. ok/);
    expect(down).toMatch(/rolling back 1_extensions_and_id_generator \.\.\. ok/);

    const client = new pg.Client({ connectionString: env['DATABASE_URL'] });
    await client.connect();
    try {
      const ledger = await client.query('SELECT COUNT(*)::int AS n FROM migrations.schema_migrations');
      expect(ledger.rows[0]?.n).toBe(0);
      const appSchema = await client.query(
        "SELECT COUNT(*)::int AS n FROM information_schema.schemata WHERE schema_name = 'app'",
      );
      expect(appSchema.rows[0]?.n).toBe(0); // migration 0001 owns `app`, and its rollback really drops it
      const tables = await client.query(
        "SELECT COUNT(*)::int AS n FROM pg_tables WHERE schemaname IN ('public','lab') AND tablename NOT LIKE 'schema%'",
      );
      expect(tables.rows[0]?.n).toBe(0);
    } finally {
      await client.end();
    }

    // Re-applying from zero proves the runner is idempotent across full cycles.
    const again = await npmRun('migrate');
    expect(again).toMatch(/applied 9 migration\(s\)/);
  });
});
