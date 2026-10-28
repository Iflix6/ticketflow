import { createPool } from '../../apps/api/src/db/pool.js';
import { createLogger } from '../../apps/api/src/observability/logger.js';
import { createApp } from '../../apps/api/src/app.js';
import { ERROR_CODES, HTTP_STATUS_CODES } from '@ticketflow/contracts';
import { testConfig } from '../helpers/config.js';
import { readSpecText, scanOpenApiOperations } from '../helpers/openapi-spec.js';
import { describe, expect, it } from 'vitest';

/**
 * Contract parity guard for `docs/api/openapi.yaml` — the STRUCTURAL half (see
 * `tests/helpers/openapi-spec.ts` for why the scanner lives there).
 *
 * The spec is hand-maintained, so it drifts the moment someone adds or renames a route. Two hermetic
 * checks make that impossible to miss (no database, no listener — this only builds the app object and
 * reads a file):
 *  1. every documented operation is structurally legal (operationId present, unique path+method, and
 *     status/error codes drawn from the closed sets in `packages/contracts`);
 *  2. the documented operation count and per-method distribution equal the route table Express actually
 *     registered, so a new endpoint without a contract entry fails here.
 * `tests/integration/openapi-parity.test.ts` covers the other direction: documented paths are requested
 * for real, so a path that no longer resolves fails there.
 */

type DocumentedOperation = ReturnType<typeof scanOpenApiOperations>[number];

/** Registered routes, read off the built app. Express 5 keeps `route`/`handle.stack` off the public types. */
type RouteLike = { path: string; methods: Record<string, boolean> };
type LayerLike = { route?: RouteLike; handle?: { stack?: LayerLike[] } };

function registeredRoutes(app: { router: { stack: unknown[] } }): Array<{ path: string; methods: string[] }> {
  const walk = (stack: LayerLike[]): Array<{ path: string; methods: string[] }> => {
    const found: Array<{ path: string; methods: string[] }> = [];
    for (const layer of stack) {
      if (layer.route !== undefined) {
        found.push({ path: layer.route.path, methods: Object.keys(layer.route.methods) });
      } else if (layer.handle?.stack !== undefined) {
        found.push(...walk(layer.handle.stack));
      }
    }
    return found;
  };
  return walk(app.router.stack as LayerLike[]);
}

const specText = readSpecText();
const documented: DocumentedOperation[] = scanOpenApiOperations(specText);

// The app is built with the lab ENABLED, because the spec documents lab endpoints too. No request is
// served here, so the pool is never connected and the test stays hermetic.
const config = testConfig({ LAB_ENABLED: 'true' });
const pool = createPool(config);
const db = {
  pool,
  query: () => Promise.reject(new Error('contract test never queries')),
  connect: () => Promise.reject(new Error('contract test never connects')),
  close: () => Promise.resolve(),
  stats: () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 }),
};
const app = createApp({ config, db, logger: createLogger(config), version: 'contract-test' });
const routes = registeredRoutes(app as unknown as { router: { stack: unknown[] } });

describe('docs/api/openapi.yaml matches the implemented routes', () => {
  it('finds the documented operations at all (a broken scan must fail loudly)', () => {
    expect(documented.length).toBeGreaterThan(15);
    for (const operation of documented) expect(operation.path).toMatch(/^\/(health|metrics|api\/v1\/)/);
  });

  it('gives every operation an operationId and a unique method+path pair', () => {
    const ids = documented.map((operation) => operation.operationId);
    for (const id of ids) expect(typeof id).toBe('string');
    expect(new Set(ids).size).toBe(ids.length);

    const pairs = documented.map((operation) => `${operation.method.toUpperCase()} ${operation.path}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('uses only status codes the contract allows, and documents the closed error taxonomy exactly', () => {
    const allowed = new Set<number>(HTTP_STATUS_CODES);
    for (const operation of documented) {
      for (const status of operation.statuses) expect(allowed.has(Number(status))).toBe(true);
    }

    // The only multi-line enum in the spec is `ErrorBody.code` (every other enum is inline), so these
    // list items ARE the taxonomy. Equality in both directions is the point: no invented error code, and
    // none of the 16 real ones missing.
    const documentedCodes = specText
      .split(/\r?\n/)
      .filter((line) => /^ {12}- [a-z_]+$/.test(line))
      .map((line) => line.slice(14));
    expect([...documentedCodes].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('documents exactly as many operations as the app registers, per HTTP method', () => {
    const registeredCount = routes.reduce((sum, route) => sum + route.methods.length, 0);
    expect(documented.length).toBe(registeredCount);

    const tally = (methods: string[]): Record<string, number> => {
      const counts: Record<string, number> = {};
      for (const method of methods) counts[method] = (counts[method] ?? 0) + 1;
      return counts;
    };
    expect(tally(documented.map((operation) => operation.method.toUpperCase()))).toEqual(
      tally(routes.flatMap((route) => route.methods.map((method) => method.toUpperCase()))),
    );
  });

  it('documents the middleware-derived codes for every operation the middleware actually covers', () => {
    // These four rules are not stylistic. Each one mirrors a mount-level decision in
    // `apps/api/src/app.ts`, which applies to EVERY route under it — so an operation missing one is not
    // an omission of prose, it is a documented contract that contradicts the pipeline:
    //   429 — the rate limiter runs on the `/api` router only, never on `/health` or `/metrics`
    //         (api.test.ts asserts scrapers cannot be throttled into a false outage);
    //   401 — `authenticate` guards every operation that did not declare `security: []`;
    //   403 — `/api/v1/lab` adds `requireRole('LAB_ADMIN')` and `labGate` on top of authentication;
    //   400 — path/query/body all go through Zod `parse*`, which throws `validation_failed`.
    const findings: string[] = [];
    for (const operation of documented) {
      const label = `${operation.method.toUpperCase()} ${operation.path}`;
      const underApi = operation.path.startsWith('/api/v1/');
      const hasPathParameter = operation.path.includes('{');
      const hasBody = operation.method !== 'get';
      const paginated = ['/api/v1/events', '/api/v1/me/bookings', '/api/v1/lab/runs'].includes(operation.path);
      const declares = (status: string): boolean => operation.statuses.includes(status);

      if (underApi && !declares('429')) findings.push(`${label}: no 429 (rate limiter wraps every /api/v1 route)`);
      if (!operation.path.startsWith('/api/v1/') && declares('429')) {
        findings.push(`${label}: documents 429, but ${operation.path} is deliberately never throttled`);
      }
      if (!operation.anonymous && !declares('401')) findings.push(`${label}: authenticated but no 401`);
      // Deliberately no inverse check (an anonymous operation that documents 401 is NOT a failure):
      // `POST /api/v1/auth/token` is anonymous by mount, yet 401 `unauthorized` is one of its real
      // business outcomes — rejected credentials. A stricter rule here would be wrong, not just tight.
      if (operation.path.startsWith('/api/v1/lab/') && !declares('403')) {
        findings.push(`${label}: lab route but no 403 (LAB_ADMIN role + labGate)`);
      }
      if ((hasPathParameter || hasBody || paginated) && !declares('400')) {
        findings.push(`${label}: takes path/body/query input but no 400 for validation_failed`);
      }
    }
    expect(findings).toEqual([]);
  });

  it('keeps the lab and demo-token routers unmounted when LAB_ENABLED is false', () => {
    // The spec documents them, and they must be genuinely absent in a public deployment (ADR-0009) —
    // otherwise "restricted dashboard" is a UI convention rather than a server guarantee.
    // `layer.route.path` is MOUNT-RELATIVE (`/token`, not `/auth/token`), so the old filter on
    // `/^\\/(auth|lab)/` matched nothing and the assertion passed vacuously for every prior phase.
    // These are the real relative paths, and the Phase-5 session routes are asserted PRESENT: they
    // are the UI's auth path and stay mounted even with the lab off.
    const publicApp = createApp({
      config: testConfig({ LAB_ENABLED: 'false' }),
      db,
      logger: createLogger(testConfig({ LAB_ENABLED: 'false' })),
      version: 'contract-test',
    });
    const publicPaths = registeredRoutes(publicApp as unknown as { router: { stack: unknown[] } }).map(
      (route) => route.path,
    );
    expect(publicPaths.filter((p) => ['/token', '/strategies', '/runs', '/runs/:id', '/runs/:id/results', '/fixtures/reset'].includes(p))).toEqual([]);
    expect(publicPaths).toEqual(expect.arrayContaining(['/session', '/session/rotate', '/session/logout']));
    expect(publicPaths).toEqual(expect.arrayContaining(['/', '/:id', '/:id/cancel', '/:id/checkout']));
  });

  it('closes the unused pool so the process can exit', async () => {
    await pool.end();
    expect(pool.totalCount).toBe(0);
  });
});
