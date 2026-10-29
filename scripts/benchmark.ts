import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { cpus, totalmem } from 'node:os';
import process from 'node:process';

/**
 * Phase 6 HTTP benchmark harness (`npm run bench`).
 *
 * WHY this exists next to the lab runner: `ExperimentRunner` drives `pg` calls directly, so its latency
 * excludes routing, auth, JSON, idempotency and the connection pool — it measures contention at the data
 * layer. This harness drives the REAL reservation API over HTTP (the same endpoints a browser hits), so
 * the numbers are end-to-end request cost. It complements the lab; it does not replace it, and neither is
 * presented as the other (a standing limitation of the Phase 3 report).
 *
 * Honesty contract with the pack ("never fabricate"):
 *  - It only ever runs against a live `base` URL; if the API is not ready it exits non-zero rather than
 *    emitting an empty success artifact.
 *  - Capacity is MEASURED from `/events/:id/tiers` at start, never assumed, and "no oversell" is asserted:
 *    confirmed bookings must never exceed the capacity the run started from — a breach fails the run.
 *  - Every per-request row goes to a CSV, and the aggregate + before/after `/metrics` text go to a JSON,
 *    both under `load-tests/results/` (gitignored), so any number quoted in the docs is reproducible.
 *
 * Dependency-free (node:http, not fetch/undici): a bounded worker pool of `concurrency` in-flight requests,
 * keep-alive OFF so each request opens its own socket and the PostgreSQL pool queueing is genuinely
 * exercised rather than hidden behind a client-side connection cap.
 */

interface Args {
  base: string;
  tierId: string;
  eventQuery: string;
  eventSlug: string;
  email: string;
  password: string;
  users: number;
  concurrency: number;
  quantity: number;
  outcome: 'success' | 'failure' | 'timeout';
  outDir: string;
  label: string;
}

interface Row {
  index: number;
  op: 'reserve' | 'checkout';
  status: number;
  outcome: string;
  latencyMs: number;
  reservationId?: string | undefined;
  errorCode?: string | undefined;
}

interface HttpResult {
  status: number;
  json: unknown;
  text: string;
  latencyMs: number;
  transportError?: string;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined ? (argv[i + 1] as string) : fallback;
  };
  const num = (name: string, fallback: number): number => Number(get(name, String(fallback)));
  const outcome = get('outcome', 'success');
  return {
    base: get('base', 'http://127.0.0.1:4000').replace(/\/$/, ''),
    tierId: get('tier', ''),
    eventQuery: get('event-index', '0'),
    eventSlug: get('event-slug', ''),
    email: get('email', 'customer@local.test'),
    password: get('password', 'local-demo-customer-2026'),
    users: num('users', 1000),
    concurrency: num('concurrency', 100),
    quantity: num('quantity', 1),
    outcome: outcome === 'failure' || outcome === 'timeout' ? outcome : 'success',
    outDir: get('out-dir', 'load-tests/results'),
    label: get('label', 'bench'),
  };
}

const HTTP_AGENT = new Agent({ keepAlive: false, maxSockets: 2048 });

/** One HTTP call, timed with `process.hrtime` nanosecond precision; captures both parsed JSON and raw text. */
function call(
  base: string,
  method: 'GET' | 'POST',
  path: string,
  opts: { token?: string; idemKey?: string; body?: unknown } = {},
): Promise<HttpResult> {
  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const url = new URL(base + path);
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
    if (opts.idemKey !== undefined) headers['idempotency-key'] = opts.idemKey;

    const req = httpRequest(
      { agent: HTTP_AGENT, method, hostname: url.hostname, port: url.port || '80', path: url.pathname + url.search, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined; // /metrics is text/plain — JSON.parse throws; `text` still holds it.
          }
          resolve({ status: res.statusCode ?? 0, json, text, latencyMs });
        });
      },
    );
    req.on('error', (error: Error) => {
      const latencyMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({ status: 0, json: undefined, text: '', latencyMs, transportError: error.message });
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Envelope-safe field read: every documented route answers `{ data: ... }` or `{ error: ... }`. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

const round = (n: number): number => (Number.isFinite(n) ? Number(n.toFixed(3)) : n);

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return (sorted[idx] as number) ?? Number.NaN;
}

function classifyReserve(status: number, body: unknown): string {
  if (status === 201) return 'reserved';
  const code = asRecord(asRecord(body).error).code;
  if (status === 409 && code === 'sold_out') return 'sold_out';
  if (status === 409 && code === 'conflict') return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server_error';
  return `other_${status}_${String(code ?? 'x')}`;
}

async function resolveTier(args: Args, token: string): Promise<{ tierId: string; available: number; capacity: number }> {
  const events = await call(args.base, 'GET', '/api/v1/events', {});
  const list = Array.isArray(asRecord(events.json).data) ? (asRecord(events.json).data as unknown[]) : [];
  // Prefer an explicit, stable slug (the flagship fixture is `lab-flagship-1000-vs-100`): it is the
  // documented, reproducible selector. Fall back to list index only when no slug is supplied.
  const event =
    args.eventSlug !== ''
      ? list.find((e) => String(asRecord(e).slug) === args.eventSlug)
      : list[Math.min(list.length - 1, Number(args.eventQuery))];
  const eventId = String(asRecord(event).id);
  if (eventId === 'undefined') {
    throw new Error(
      args.eventSlug !== ''
        ? `no event with slug "${args.eventSlug}"; run \`npm run seed -- --experiment\` first`
        : 'no events found; run `npm run seed` first',
    );
  }

  const tiers = await call(args.base, 'GET', `/api/v1/events/${eventId}/tiers`, { token });
  const tierRows = Array.isArray(asRecord(tiers.json).data) ? (asRecord(tiers.json).data as unknown[]) : [];
  const chosen =
    args.tierId !== ''
      ? tierRows.find((t) => String(asRecord(asRecord(t).tier).id) === args.tierId)
      : tierRows[0];
  if (chosen === undefined) throw new Error(`tier ${args.tierId || '(first)'} not found on event ${eventId}`);
  const tier = asRecord(asRecord(chosen).tier);
  const inventory = asRecord(asRecord(chosen).inventory);
  return {
    tierId: String(tier.id),
    available: Number(inventory.available),
    capacity: Number(inventory.capacity),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const probe = await call(args.base, 'GET', '/health/ready', {});
  if (probe.status !== 200) {
    console.error(`[bench] API not ready at ${args.base} (/health/ready -> ${probe.status}); refusing to fabricate a run.`);
    process.exit(1);
  }

  const login = await call(args.base, 'POST', '/api/v1/auth/token', { body: { email: args.email, password: args.password } });
  const token = asRecord(asRecord(login.json).data).token;
  if (typeof token !== 'string') {
    console.error(`[bench] login failed (status ${login.status}); is the seed applied?`);
    process.exit(1);
  }

  // Capacity at start is the ceiling we must never exceed — measured, not assumed.
  const tier = await resolveTier(args, token);
  if (!Number.isFinite(tier.available)) {
    console.error('[bench] could not read tier inventory `available`; aborting so the no-oversell check has a real baseline.');
    process.exit(1);
  }

  mkdirSync(args.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const csvPath = `${args.outDir}/${args.label}-${stamp}.csv`;
  const jsonPath = `${args.outDir}/${args.label}-${stamp}.json`;
  const csv = createWriteStream(csvPath);
  csv.write('index,op,status,outcome,latencyMs,reservationId,errorCode\n');

  const rows: Row[] = [];
  const push = (row: Row): void => {
    rows.push(row);
    csv.write(`${row.index},${row.op},${row.status},${row.outcome},${row.latencyMs.toFixed(3)},${row.reservationId ?? ''},${row.errorCode ?? ''}\n`);
  };

  let next = 0;
  let confirmed = 0;
  const reserveLatencies: number[] = [];
  const checkoutLatencies: number[] = [];

  const metricsBefore = await call(args.base, 'GET', '/metrics', {});

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= args.users) return;

      // Idempotency keys are salted with this run's unique `stamp` so a re-run is a clean, repeatable
      // comparison. Reusing fixed keys across runs makes the API return 409 idempotency_key_reuse for
      // earlier reservations, silently turning part of the measured load into cached replays instead of
      // fresh contention — which would make two nominally identical runs non-comparable.
      const reserve = await call(args.base, 'POST', '/api/v1/reservations', {
        token,
        idemKey: `bench-${stamp}-reserve-${index}`,
        body: { tierId: tier.tierId, quantity: args.quantity },
      });
      const rOutcome = classifyReserve(reserve.status, reserve.json);
      reserveLatencies.push(reserve.latencyMs);
      const reservationId = String(asRecord(asRecord(reserve.json).data).id ?? '');
      if (rOutcome !== 'reserved') {
        const errCode = asRecord(asRecord(reserve.json).error).code;
        push({ index, op: 'reserve', status: reserve.status, outcome: rOutcome, latencyMs: reserve.latencyMs, errorCode: typeof errCode === 'string' ? errCode : undefined });
        continue;
      }
      push({ index, op: 'reserve', status: reserve.status, outcome: rOutcome, latencyMs: reserve.latencyMs, reservationId });

      const checkout = await call(args.base, 'POST', `/api/v1/reservations/${reservationId}/checkout`, {
        token,
        idemKey: `bench-${stamp}-checkout-${index}`,
        body: { simulatedOutcome: args.outcome },
      });
      checkoutLatencies.push(checkout.latencyMs);
      const bookingStatus = String(asRecord(asRecord(checkout.json).data).status ?? 'UNKNOWN');
      const coOutcome =
        checkout.status === 201 ? (bookingStatus === 'CONFIRMED' ? 'confirmed' : `paid_${bookingStatus}`)
        : checkout.status === 202 ? 'pending'
        : checkout.status === 200 ? 'failed'
        : `error_${checkout.status}`;
      if (coOutcome === 'confirmed') confirmed += 1;
      push({ index, op: 'checkout', status: checkout.status, outcome: coOutcome, latencyMs: checkout.latencyMs, reservationId });
    }
  };

  const wallStart = process.hrtime.bigint();
  await Promise.all(Array.from({ length: args.concurrency }, () => worker()));
  const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
  csv.end();

  const metricsAfter = await call(args.base, 'GET', '/metrics', {});

  const reserveSorted = [...reserveLatencies].sort((a, b) => a - b);
  const checkoutSorted = [...checkoutLatencies].sort((a, b) => a - b);
  const totalOps = rows.length;
  const outcomeTally = rows.reduce<Record<string, number>>((acc, r) => {
    acc[`${r.op}:${r.outcome}`] = (acc[`${r.op}:${r.outcome}`] ?? 0) + 1;
    return acc;
  }, {});

  const oversell = confirmed > tier.available;

  const summary = {
    label: args.label,
    ranAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1048576),
      node: process.version,
      base: args.base,
    },
    config: {
      users: args.users,
      concurrency: args.concurrency,
      quantityPerUser: args.quantity,
      simulatedOutcome: args.outcome,
      tierId: tier.tierId,
      startAvailable: tier.available,
      startCapacity: tier.capacity,
      rateLimiterNote:
        'Run against an API with RATE_LIMIT_MAX raised (local lab). Left at the default it would measure the limiter (429), not reservation contention.',
    },
    results: {
      reserveOps: reserveSorted.length,
      checkoutOps: checkoutSorted.length,
      confirmed,
      totalOps,
      wallClockMs: Math.round(wallMs),
      endToEndThroughputOpsPerSec: Number(((totalOps / wallMs) * 1000).toFixed(2)),
      confirmedPerSec: Number(((confirmed / wallMs) * 1000).toFixed(2)),
      reserveLatencyMs: { p50: round(percentile(reserveSorted, 0.5)), p95: round(percentile(reserveSorted, 0.95)), p99: round(percentile(reserveSorted, 0.99)), max: round(reserveSorted.at(-1) ?? Number.NaN) },
      checkoutLatencyMs: { p50: round(percentile(checkoutSorted, 0.5)), p95: round(percentile(checkoutSorted, 0.95)), p99: round(percentile(checkoutSorted, 0.99)), max: round(checkoutSorted.at(-1) ?? Number.NaN) },
      outcomeTally,
      oversellViolation: oversell,
    },
  };

  writeFileSync(
    jsonPath,
    JSON.stringify({ ...summary, metricsBeforeText: metricsBefore.text, metricsAfterText: metricsAfter.text }, null, 2),
  );
  printSummary(summary, csvPath, jsonPath);

  if (oversell) {
    console.error(`\n[bench] FAILED: ${confirmed} confirmed exceeded start capacity ${tier.available} — that is an oversell.`);
    process.exit(1);
  }
}

function printSummary(summary: { results: Record<string, unknown>; config: Record<string, unknown> }, csvPath: string, jsonPath: string): void {
  console.log(JSON.stringify({ config: summary.config, results: summary.results }, null, 2));
  console.log(`\n[bench] wrote ${csvPath}`);
  console.log(`[bench] wrote ${jsonPath}`);
}

void main().catch((error: unknown) => {
  console.error('[bench]', error instanceof Error ? error.message : error);
  process.exit(1);
});
