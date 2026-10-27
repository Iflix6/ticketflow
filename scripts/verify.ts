import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single-command acceptance suite (`npm run verify`).
 *
 * Every step's actual outcome is printed and the exit code is the AND of all steps — the spec's
 * "never report success you did not measure" rule made a shell one-liner insufficient, because a
 * one-liner cannot tell you *which* guarantee failed.
 *
 * Steps 1–5 are hermetic. Steps 6–9 need PostgreSQL (and step 6 `docker compose up -d postgres`
 * or CI service containers); they are skipped with an explicit SKIP line when the database is
 * unreachable, and that skip is reflected in the exit code unless `--allow-skip` is passed.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

interface Step {
  name: string;
  command: string;
  args: string[];
  needsDatabase?: boolean;
  timeoutMs?: number;
}

const STEPS: Step[] = [
  { name: 'typecheck (strict)', command: npm, args: ['run', 'typecheck'] },
  { name: 'lint', command: npm, args: ['run', 'lint'] },
  { name: 'unit tests', command: npm, args: ['run', 'test:unit'] },
  { name: 'integration tests (real PostgreSQL)', command: npm, args: ['run', 'test:integration'], needsDatabase: true, timeoutMs: 300_000 },
];

function runStep(step: Step, env: NodeJS.ProcessEnv): Promise<'pass' | 'fail' | 'skip'> {
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, { cwd: root, env, stdio: 'inherit' });
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
