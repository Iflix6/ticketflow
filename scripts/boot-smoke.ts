import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Boot smoke test against the *compiled* artifact (`apps/api/dist/server.js`), not the TypeScript
 * source. This step exists because a stale `dist/` briefly masked two already-fixed defects
 * (`sqlstate` leaking from an application code, and the auth response missing the `{ data }`
 * envelope) while every source-level test stayed green. The only honest way to gate "a fresh
 * checkout boots" is to boot the thing we actually ship and probe it over real HTTP.
 *
 * It asserts the guarantees that matter for the Phase 1 gate, then verifies graceful shutdown:
 *   1. process starts and listens on an OS-assigned port (PORT=0);
 *   2. health endpoints answer (liveness always; readiness only with a reachable database);
 *   3. the catalog route returns the `{ data: [...] }` envelope;
 *   4. the local demo token exchange yields a usable `Bearer` token;
 *   5. an authorized LAB_ADMIN reads the lab, a CUSTOMER is refused (403), and that 403 body does
 *      not leak a SQLSTATE (the respond.ts hardening);
 *   6. SIGTERM/SIGBREAK drains and exits 0 with a "shutdown complete" log.
 *
 * Prerequisites: database migrated and seeded (`npm run migrate && npm run seed`), because the
 * token exchange authenticates against real `app_users` rows — reproducing them here would defeat
 * the point of testing the shipped path.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(root, 'apps', 'api', 'dist', 'server.js');

// Seeded local-only credentials (see scripts/seed.ts); overridable so operators can align with a
// custom seed without editing this file.
const ADMIN_EMAIL = process.env.LAB_ADMIN_EMAIL ?? 'lab@local.test';
const ADMIN_PASSWORD = process.env.TF_SEED_ADMIN_PASSWORD ?? 'local-demo-admin-2026';
const CUSTOMER_EMAIL = 'customer@local.test';
const CUSTOMER_PASSWORD = process.env.TF_SEED_CUSTOMER_PASSWORD ?? 'local-demo-customer-2026';

interface Check {
  name: string;
  run: () => Promise<string>;
}

function startServer(): {
  child: ReturnType<typeof spawn>;
  lines: string[];
  listening: Promise<number>;
} {
  const lines: string[] = [];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'local',
    HOST: '127.0.0.1',
    // Port 0 asks the OS for a free port; we read the real number back from the "api listening" log.
    PORT: '0',
    LAB_ENABLED: 'true',
    LOG_LEVEL: 'info',
    // The token is issued and verified by this same process, so any >=32-char value is fine locally.
    AUTH_SECRET: process.env.AUTH_SECRET ?? 'boot_smoke_local_only_value_min_32_chars',
    TF_TEST_LOGS: '1',
  };

  const child = spawn(process.execPath, [serverEntry], {
    cwd: root,
    env,
    // An IPC channel (4th slot) lets us trigger the server's graceful drain deterministically on
    // every platform, instead of relying on Windows signal semantics that skip process handlers.
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');

  // Keep EVERY line for the whole run: the shutdown check greps the accumulated log for
  // 'shutdown complete'. This collector stays attached even after port discovery resolves below.
  child.stdout?.on('data', (chunk: string) => lines.push(chunk));
  child.stderr?.on('data', (chunk: string) => lines.push(chunk));

  const listening = new Promise<number>((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const onData = (chunk: string): void => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const raw = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (raw.length === 0) continue;
        try {
          const parsed = JSON.parse(raw) as { msg?: string; port?: number };
          if (!settled && parsed.msg === 'api listening' && typeof parsed.port === 'number') {
            settled = true;
            child.stdout?.off('data', onData);
            resolve(parsed.port);
          }
        } catch {
          // Non-JSON stdout (e.g. npm banner) is expected and irrelevant to port discovery.
        }
      }
    };
    child.stdout?.on('data', onData);
    child.once('exit', (code) => reject(new Error(`server exited before listening (code ${String(code)})`)));
    const timer = setTimeout(() => reject(new Error('server did not start listening within 15s')), 15_000);
    timer.unref();
  });

  return { child, lines, listening };
}

async function main(): Promise<void> {
  const { child, lines, listening } = startServer();
  const baseUrl = `http://127.0.0.1:${await listening}`;
  console.log(`[boot-smoke] built server listening on ${baseUrl}`);

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = async (item: Check): Promise<void> => {
    try {
      const detail = await item.run();
      results.push({ name: item.name, ok: true, detail });
      console.log(`  PASS  ${item.name} — ${detail}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ name: item.name, ok: false, detail });
      console.error(`  FAIL  ${item.name} — ${detail}`);
    }
  };

  const expectStatus = (res: { status: number }, want: number): void => {
    if (res.status !== want) throw new Error(`expected HTTP ${want}, got ${res.status}`);
  };

  let adminToken = '';
  let customerToken = '';

  await check({
    name: 'GET /health/live → 200 with x-request-id',
    run: async () => {
      const res = await fetch(`${baseUrl}/health/live`);
      expectStatus(res, 200);
      const id = res.headers.get('x-request-id');
      if (id === null || id.length === 0) throw new Error('missing x-request-id header');
      return `request-id ${id}`;
    },
  });

  await check({
    name: 'GET /health/ready → 200 (live database)',
    run: async () => {
      const res = await fetch(`${baseUrl}/health/ready`);
      expectStatus(res, 200);
      const body = (await res.json()) as { detail?: string };
      if (body.detail === undefined || !body.detail.includes('database')) throw new Error('readiness did not report database');
      return `detail=${body.detail}`;
    },
  });

  await check({
    name: 'GET /api/v1/events → 200 { data: [...] }',
    run: async () => {
      const res = await fetch(`${baseUrl}/api/v1/events`);
      expectStatus(res, 200);
      const body = (await res.json()) as { data?: unknown[] };
      if (!Array.isArray(body.data) || body.data.length === 0) throw new Error('catalog envelope missing non-empty data array');
      return `${body.data.length} event(s)`;
    },
  });

  await check({
    name: 'POST /api/v1/auth/token (LAB_ADMIN) → usable Bearer token',
    run: async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      expectStatus(res, 200);
      const body = (await res.json()) as { data?: { token?: string; tokenType?: string } };
      const token = body.data?.token;
      if (typeof token !== 'string' || token.length === 0) throw new Error('no data.token in envelope');
      if (body.data?.tokenType !== 'Bearer') throw new Error(`unexpected tokenType ${String(body.data?.tokenType)}`);
      adminToken = token;
      return 'issued Bearer LAB_ADMIN token';
    },
  });

  await check({
    name: 'GET /api/v1/lab/strategies (admin) → 200',
    run: async () => {
      const res = await fetch(`${baseUrl}/api/v1/lab/strategies`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expectStatus(res, 200);
      const body = (await res.json()) as { data?: unknown[] };
      if (!Array.isArray(body.data)) throw new Error('lab strategies missing data array');
      return `${body.data.length} strategies`;
    },
  });

  await check({
    name: 'POST /api/v1/auth/token (CUSTOMER) → token',
    run: async () => {
      const res = await fetch(`${baseUrl}/api/v1/auth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: CUSTOMER_EMAIL, password: CUSTOMER_PASSWORD }),
      });
      expectStatus(res, 200);
      const body = (await res.json()) as { data?: { token?: string } };
      const token = body.data?.token;
      if (typeof token !== 'string') throw new Error('no data.token for customer');
      customerToken = token;
      return 'issued Bearer CUSTOMER token';
    },
  });

  await check({
    name: 'GET /api/v1/lab/strategies (customer) → 403 and NO sqlstate leak',
    run: async () => {
      const res = await fetch(`${baseUrl}/api/v1/lab/strategies`, {
        headers: { authorization: `Bearer ${customerToken}` },
      });
      expectStatus(res, 403);
      const text = await res.text();
      // The respond.ts hardening: an authorization refusal must never masquerade as a database error.
      if (text.toLowerCase().includes('sqlstate')) throw new Error(`403 body leaked sqlstate: ${text}`);
      const body = JSON.parse(text) as { error?: { code?: string } };
      if (body.error?.code !== 'forbidden') throw new Error(`expected error.code=forbidden, got ${String(body.error?.code)}`);
      return '403 forbidden, no sqlstate field';
    },
  });

  // Graceful shutdown: ask the process to drain over IPC and confirm it exits cleanly on its handler.
  const signalName = 'ipc:graceful-shutdown';
  const shutdown = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, detail: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, detail });
    };
    child.once('exit', (code) => {
      const log = lines.join('');
      const drained = log.includes('shutdown complete');
      if (code === 0 && drained) finish(true, `exit 0 after 'shutdown complete'`);
      else finish(false, `exit code ${String(code)}, drained=${String(drained)}`);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(false, `no graceful exit within 8s of ${signalName}`);
    }, 8_000);
    timer.unref();
    child.once('error', (error) => finish(false, `ipc send failed: ${error.message}`));
    child.send('graceful-shutdown');
  });
  results.push({ name: `graceful shutdown (${signalName})`, ...shutdown });
  console.log(`  ${shutdown.ok ? 'PASS' : 'FAIL'}  graceful shutdown — ${shutdown.detail}`);

  // Ensure the child is gone even if the graceful path below failed to report.
  if (child.exitCode === null && !child.killed) child.kill('SIGKILL');

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`\n[boot-smoke] FAILED ${failed.length}/${results.length} check(s).`);
    process.exit(1);
  }
  console.log(`\n[boot-smoke] PASSED all ${results.length} checks against the built artifact.`);
}

main().catch((error: unknown) => {
  console.error('[boot-smoke]', error instanceof Error ? error.message : error);
  process.exit(1);
});
