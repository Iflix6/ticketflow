import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadDotEnv } from '@ticketflow/config';

/**
 * Single-command acceptance suite (`npm run verify`).
 *
 * Every step's actual outcome is printed and the exit code is the AND of all steps — the spec's
 * "never report success you did not measure" rule made a shell one-liner insufficient, because a
 * one-liner cannot tell you *which* guarantee failed.
 *
 * Steps 1–4 are hermetic. Steps 5–6 need PostgreSQL; they are skipped with an explicit SKIP line
 * when the database is unreachable, and that skip fails the run unless `--allow-skip` is passed.
 * The final step boots the *compiled* artifact over real HTTP, so a stale `dist/` cannot let the
 * gate pass on source-only green (a stale build once masked two fixed defects).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Node 24 refuses to spawn `.cmd` shims without a shell (EINVAL), so npm is invoked through its own
// CLI JavaScript entrypoint — the same code `npm.cmd` wraps, portable across platforms. We resolve
// the conventional location first and fall back to the primary candidate so the value is a plain
// `string` (indexing the array would yield `string | undefined` under noUncheckedIndexedAccess).
const npmCliDir = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npmCliFallback = path.join(path.dirname(process.execPath), 'npm-cli.js');
const npmCli = existsSync(npmCliDir) ? npmCliDir : npmCliFallback;

interface Step {
  name: string;
  script: string;
  needsDatabase?: boolean;
  timeoutMs?: number;
}

const STEPS: Step[] = [
  { name: 'build (workspaces)', script: 'build' },
  { name: 'typecheck (strict)', script: 'typecheck' },
  { name: 'lint', script: 'lint' },
  { name: 'unit tests', script: 'test:unit' },
  { name: 'integration tests (real PostgreSQL)', script: 'test:integration', needsDatabase: true, timeoutMs: 300_000 },
  { name: 'boot smoke (built artifact over HTTP)', script: 'boot:smoke', needsDatabase: true, timeoutMs: 60_000 },
];

function runStep(step: Step, env: NodeJS.ProcessEnv): Promise<'pass' | 'fail' | 'skip'> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [npmCli, 'run', step.script], { cwd: root, env, stdio: 'inherit' });
    const timer =
      step.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            console.error(`\n[verify] '${step.name}' exceeded ${step.timeoutMs}ms; killing`);
            child.kill('SIGKILL');
          }, step.timeoutMs);
    timer?.unref();

    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? 'pass' : 'fail');
    });
    child.on('error', () => resolve('fail'));
  });
}

async function databaseReachable(env: NodeJS.ProcessEnv): Promise<boolean> {
  const { default: pg } = await import('pg');
  const url = env['DATABASE_URL'];
  if (typeof url !== 'string' || url.length === 0) return false;
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const allowSkip = process.argv.includes('--allow-skip');
  // Load `.env` first: DATABASE_URL and friends live there, and without them this runner would
  // wrongly conclude the database is unreachable and SKIP the integration and boot-smoke gates.
  loadDotEnv(root);
  const env = { ...process.env };
  const hasDatabase = await databaseReachable(env);
  if (!hasDatabase) {
    console.log('[verify] PostgreSQL is not reachable at DATABASE_URL — database-dependent steps will be skipped.');
    console.log('[verify] start them with: npm run db:up');
  }

  const results: Array<{ name: string; outcome: string }> = [];
  for (const step of STEPS) {
    console.log(`\n=== [verify] ${step.name} ===`);
    if (step.needsDatabase && !hasDatabase) {
      console.log('SKIP (no database)');
      results.push({ name: step.name, outcome: 'skip' });
      continue;
    }
    const outcome = await runStep(step, env);
    results.push({ name: step.name, outcome });
    if (outcome === 'fail') break; // stop at the first failure: later steps inherit its breakage
  }

  console.log('\n================ verify summary ================');
  for (const { name, outcome } of results) {
    console.log(`${outcome.toUpperCase().padEnd(4)}  ${name}`);
  }

  const failed = results.filter((r) => r.outcome === 'fail').length;
  const skipped = results.filter((r) => r.outcome === 'skip').length;
  if (failed > 0) {
    console.error(`\nverify FAILED: ${failed} step(s) failed.`);
    process.exit(1);
  }
  if (skipped > 0 && !allowSkip) {
    console.error(`\nverify INCOMPLETE: ${skipped} step(s) skipped (pass --allow-skip to accept, or start the database).`);
    process.exit(1);
  }
  console.log('\nverify PASSED');
}

main().catch((error: unknown) => {
  console.error('[verify]', error instanceof Error ? error.message : error);
  process.exit(1);
});
