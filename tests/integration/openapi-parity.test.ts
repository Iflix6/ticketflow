import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { AppConfig } from '@ticketflow/config';
import type { Database } from '../../apps/api/src/db/pool.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../apps/api/src/observability/logger.js';
import { hashPassword, issueToken } from '../../apps/api/src/modules/auth/credentials.js';
import { testConfig } from '../helpers/config.js';
import { isUnrouted, readSpecText, resolvePath, scanOpenApiOperations } from '../helpers/openapi-spec.js';
import { databaseAvailable, seedCatalog, startTestDatabase, type TestDatabaseHandle } from '../helpers/integration-db.js';

/**
 * Contract parity guard for `docs/api/openapi.yaml` — the LIVE half.
 *
 * `tests/unit/openapi-contract.test.ts` proves the spec can never document FEWER operations than the app
 * registers. Counts cannot prove the other direction, and that is the half a hand-maintained spec breaks
 * first: a route gets renamed or deleted, the spec keeps its old entry, and every count still matches.
 * So here each documented path+method is requested against a real app for real, and must be answered by a
 * handler that exists.
 *
 * Discriminator (`isUnrouted`): `notFoundHandler` phrases an unmatched route as 404 `not_found` with the
 * message `No route for METHOD PATH`. A documented path is reachable when its response is NOT that
 * envelope — so an honest 404 from inside a handler still counts as reachable, which is the correct
 * reading (the route exists; the resource does not).
 *
 * Fixtures are created through the documented endpoints rather than SQL, for two reasons: the schema has
 * state-machine and invariant triggers (migrations 0005/0009) that a hand-written `UPDATE` would fight,
 * and a parity test that seeds through back doors would never prove the front door works.
 */

const suite = databaseAvailable() ? describe : describe.skip;

const DEMO_PASSWORD = 'parity-demo-password-2026';

/** Smallest run that still executes the runner end to end: two attempts against capacity two. */
const LAB_RUN_BODY: Record<string, unknown> = {
  strategy: 'atomic_update',
  configuration: { capacity: 2, concurrentUsers: 2, quantityPerUser: 1, seed: 7, dbPoolMax: 4 },
};

type Recipe = { auth?: string; body?: Record<string, unknown>; idempotency?: string };

suite('docs/api/openapi.yaml resolves against the live route table', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let labApp: Express;
  let customerAuth = '';
  let adminAuth = '';
  /** A second, unrelated customer: needed to verify the ownership semantics the spec claims. */
  let otherAuth = '';
  /** Seeded tier the fixture reservations point at; empty until `beforeAll` runs. */
  let tierId = '';
  /** Concrete values for `{id}`, filled by the fixture flow below; empty until then on purpose. */
  let concrete: Record<string, Record<string, string>> = {};

  const operations = scanOpenApiOperations(readSpecText());

  beforeAll(async () => {
    handle = await startTestDatabase('openapi_parity');
    db = handle.db;
    const config = testConfig({ LAB_ENABLED: 'true' });
    labApp = createApp({ config, db, logger: createLogger(config) });

    const catalog = await seedCatalog(db, 'parity-event', 'Parity Tier', 50);
    tierId = catalog.tierId;
    const customer = await seedUserWithPassword(db, config, 'parity-customer@local.test', 'CUSTOMER');
    const admin = await seedUserWithPassword(db, config, 'parity-admin@local.test', 'LAB_ADMIN');
    const other = await seedUserWithPassword(db, config, 'parity-other@local.test', 'CUSTOMER');
    customerAuth = customer.auth;
    adminAuth = admin.auth;
    otherAuth = other.auth;

    const toCancel = await postJson(labApp, '/api/v1/reservations', {
      auth: customerAuth,
      idempotency: 'parity-fixture-cancel',
      body: { tierId: catalog.tierId, quantity: 1 },
    });
    expect(toCancel.status).toBe(201);

    const checkoutable = await postJson(labApp, '/api/v1/reservations', {
      auth: customerAuth,
      idempotency: 'parity-fixture-checkout',
      body: { tierId: catalog.tierId, quantity: 1 },
    });
    expect(checkoutable.status).toBe(201);
    const reservationId = String((checkoutable.body as { data: { id: string } }).data.id);

    const booked = await postJson(labApp, `/api/v1/reservations/${reservationId}/checkout`, {
      auth: customerAuth,
      idempotency: 'parity-fixture-booking',
      // `{}` is a valid body: both checkout fields carry Zod defaults (success, 0 ms).
      body: {},
    });
    expect(booked.status).toBe(201);
    const bookingId = String((booked.body as { data: { id: string } }).data.id);

    const run = await postJson(labApp, '/api/v1/lab/runs', {
      auth: adminAuth,
      body: LAB_RUN_BODY,
    });
    expect(run.status).toBe(201);
    const runId = String((run.body as { data: { id: string } }).data.id);

    concrete = {
      'GET /api/v1/events/{id}': { id: catalog.eventId },
      'GET /api/v1/events/{id}/tiers': { id: catalog.eventId },
      'GET /api/v1/reservations/{id}': { id: reservationId },
      'POST /api/v1/reservations/{id}/cancel': { id: String((toCancel.body as { data: { id: string } }).data.id) },
      'POST /api/v1/reservations/{id}/checkout': { id: reservationId },
      'GET /api/v1/bookings/{id}': { id: bookingId },
      'GET /api/v1/lab/runs/{id}': { id: runId },
      'GET /api/v1/lab/runs/{id}/results': { id: runId },
    };
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  it('proves the discriminator works before trusting it (control)', async () => {
    // Without this, a broken `isUnrouted` would make every operation below look reachable and the whole
    // suite would pass vacuously — the classic way a parity guard becomes decoration.
    const unmatched = await request(labApp).get('/api/v1/definitely-not-a-route');
    expect(unmatched.status).toBe(404);
    expect(isUnrouted(unmatched)).toBe(true);

    const registered = await request(labApp).get('/api/v1/events');
    expect(registered.status).toBe(200);
    expect(isUnrouted(registered)).toBe(false);
  });

  it('has a request recipe and concrete path values for every documented operation', () => {
    const recipes = recipesFor({ customerAuth, adminAuth, tierId });
    const missing: string[] = [];
    for (const operation of operations) {
      const label = `${operation.method.toUpperCase()} ${operation.path}`;
      if (recipes[label] === undefined) missing.push(`${label} (no recipe)`);
      for (const segment of operation.path.split('/')) {
        if (!segment.startsWith('{')) continue;
        const name = segment.slice(1, -1);
        if (concrete[label]?.[name] === undefined) missing.push(`${label} (no value for {${name}})`);
      }
    }
    // Fail loudly and name what is missing: a spec entry nobody can request is a spec entry nobody verified.
    expect(missing).toEqual([]);
  });

  it('verifies the ownership semantics the spec claims (403 cross-owner, LAB_ADMIN exception)', async () => {
    // The per-operation tests only cover the happy 2xx path, so the 403 responses the spec now declares
    // would otherwise be unverified claims. `assertOwner` answers 403 `forbidden` — NOT 404 — for a row
    // that exists but belongs to someone else, and the spec documents exactly that.
    const reservationUrl = `/api/v1/reservations/${concrete['GET /api/v1/reservations/{id}']?.['id']}`;
    const bookingUrl = `/api/v1/bookings/${concrete['GET /api/v1/bookings/{id}']?.['id']}`;

    const otherReadsReservation = await request(labApp).get(reservationUrl).set('authorization', otherAuth);
    expect(otherReadsReservation.status).toBe(403);
    expect(otherReadsReservation.body.error.code).toBe('forbidden');

    const otherReadsBooking = await request(labApp).get(bookingUrl).set('authorization', otherAuth);
    expect(otherReadsBooking.status).toBe(403);
    expect(otherReadsBooking.body.error.code).toBe('forbidden');

    // The documented role exception: a lab admin reads another user's reservation. Asserted because it is
    // a real consequence of the lab design (ADR-0009) that a client author needs to know about.
    const adminReadsReservation = await request(labApp).get(reservationUrl).set('authorization', adminAuth);
    expect(adminReadsReservation.status).toBe(200);

    // And the genuine 404 half of the contract: a well-formed UUID nobody owns.
    const missing = await request(labApp)
      .get('/api/v1/reservations/00000000-0000-4000-8000-000000000099')
      .set('authorization', customerAuth);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');
  });

  it('verifies the 422 the spec declares for an unrecognised strategy id', async () => {
    // The happy-path loop below can never reach this status, and the spec would be wrong to omit it:
    // `strategy` is `z.string().min(1).max(40)` in the contract, NOT an enum, so an unknown id clears
    // validation (400) and is then refused by the service (422 `strategy_unavailable`). Documenting it as
    // an enum would predict 400 and be a lie — this test is what keeps that schema honest.
    const create = operations.find((op) => op.path === '/api/v1/reservations' && op.method === 'post');
    expect(create, 'spec must document POST /api/v1/reservations').toBeDefined();

    const res = await request(labApp)
      .post('/api/v1/reservations')
      .set('authorization', customerAuth)
      .set('idempotency-key', 'parity-unknown-strategy-01')
      .send({ tierId, quantity: 1, strategy: 'quantum_tunneling' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('strategy_unavailable');
    expect(create?.statuses).toContain('422');

    // The unsafe baseline is refused on public inventory for the same reason (ADR-0009), and the lab
    // runner re-checks it independently — the two entry points may never disagree.
    const unsafe = await request(labApp)
      .post('/api/v1/reservations')
      .set('authorization', customerAuth)
      .set('idempotency-key', 'parity-unsafe-strategy-01')
      .send({ tierId, quantity: 1, strategy: 'unsafe_lab' });
    expect(unsafe.status).toBe(422);
    expect(unsafe.body.error.code).toBe('strategy_unavailable');
  });

  for (const operation of operations) {
    const label = `${operation.method.toUpperCase()} ${operation.path}`;

    it(`${label} is answered by a registered handler`, async () => {
      const url = resolvePath(operation, concrete);
      const options = recipesFor({ customerAuth, adminAuth, tierId })[label];
      expect(options, `missing request recipe for ${label}`).toBeDefined();

      const call = operation.method === 'get' ? request(labApp).get(url) : request(labApp).post(url);
      if (options?.auth !== undefined) call.set('authorization', options.auth);
      if (options?.idempotency !== undefined) call.set('idempotency-key', `parity-${options.idempotency}`);
      if (options?.body !== undefined) call.send(options.body);
      const res = await call;

      expect(isUnrouted(res), `${label} → ${JSON.stringify(res.body)}`).toBe(false);
      // Reachable is necessary but not sufficient: the observed status must be one the spec declares, or
      // the documented contract is a claim nobody checked. `res.body` prints on failure to aid debugging.
      expect(operation.statuses, `${label} ${url} answered ${res.status}: ${JSON.stringify(res.body)}`).toContain(
        String(res.status),
      );
    });
  }
});

/**
 * One recipe per documented operation, with the headers a correct client must send. Bodies are
 * deliberately VALID: a request rejected by Zod still proves the route exists, but it would not prove the
 * documented 2xx is reachable at all — and that is the half of the contract clients depend on.
 */
function recipesFor(secrets: {
  customerAuth: string;
  adminAuth: string;
  tierId: string;
}): Record<string, Recipe | undefined> {
  const { customerAuth, adminAuth, tierId } = secrets;
  const recipes = {
    'GET /health/live': {},
    'GET /health/ready': {},
    'GET /metrics': {},
    'GET /api/v1/events': {},
    'GET /api/v1/events/{id}': {},
    'GET /api/v1/events/{id}/tiers': {},
    'POST /api/v1/auth/token': { body: { email: 'parity-customer@local.test', password: DEMO_PASSWORD } },
    // Phase-5 sessions. The 2xx chain (cookie really works end to end) is `sessions.test.ts`; here the
    // recipes prove the documented routes resolve and the observed statuses are declared. GET reads the
    // Bearer path (cookie-first resolution is covered there); rotate without a cookie is the documented
    // 401; logout is 200 even with nothing to revoke — that idempotence IS the documented contract.
    'POST /api/v1/auth/session': { body: { email: 'parity-customer@local.test', password: DEMO_PASSWORD } },
    'GET /api/v1/auth/session': { auth: customerAuth },
    'POST /api/v1/auth/session/rotate': {},
    'POST /api/v1/auth/session/logout': {},
    'POST /api/v1/reservations': {
      auth: customerAuth,
      idempotency: 'create',
      body: { tierId, quantity: 1 },
    },
    'GET /api/v1/reservations/{id}': { auth: customerAuth },
    'POST /api/v1/reservations/{id}/cancel': { auth: customerAuth, idempotency: 'cancel' },
    'POST /api/v1/reservations/{id}/checkout': { auth: customerAuth, idempotency: 'checkout', body: {} },
    'GET /api/v1/bookings/{id}': { auth: customerAuth },
    'GET /api/v1/me/bookings': { auth: customerAuth },
    'GET /api/v1/lab/strategies': { auth: adminAuth },
    // The lab mount puts EVERY route behind `authenticate` + `requireRole('LAB_ADMIN')` — reads included.
    // (An earlier draft of this test claimed the run list was unauthenticated by design; the live request
    // answered 401 `Authorization header is required`, which is what caught the claim being false.)
    'GET /api/v1/lab/runs': { auth: adminAuth },
    'POST /api/v1/lab/runs': { auth: adminAuth, body: LAB_RUN_BODY },
    'GET /api/v1/lab/runs/{id}': { auth: adminAuth },
    'GET /api/v1/lab/runs/{id}/results': { auth: adminAuth },
    'POST /api/v1/lab/fixtures/reset': { auth: adminAuth, body: { capacity: 3, tiers: 1 } },
  } satisfies Record<string, Recipe>;
  return recipes;
}

async function postJson(
  app: Express,
  url: string,
  options: { auth: string; body: Record<string, unknown>; idempotency?: string },
): Promise<{ status: number; body: unknown }> {
  const call = request(app).post(url).set('authorization', options.auth);
  if (options.idempotency !== undefined) call.set('idempotency-key', options.idempotency);
  const res = await call.send(options.body);
  return { status: res.status, body: res.body };
}

/**
 * Users need a `password_hash` for the documented token exchange, so this inserts the row directly —
 * `app_users` has no state-machine trigger, and the alternative (no registration endpoint exists) is
 * exactly what this test is verifying: the token route is the only way in.
 */
async function seedUserWithPassword(
  db: Database,
  config: AppConfig,
  email: string,
  role: 'CUSTOMER' | 'LAB_ADMIN',
): Promise<{ id: string; auth: string }> {
  const stored = await hashPassword(DEMO_PASSWORD);
  const inserted = await db.query<{ id: string }>(
    'INSERT INTO app_users (email, role, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, role, stored],
  );
  const id = inserted.rows[0]?.id;
  if (id === undefined) throw new Error(`user ${email} insert returned no row`);
  // Minted directly so the fixture flow can start from a token; the token ENDPOINT has its own operation
  // test below, which goes through the real password exchange.
  return { id, auth: `Bearer ${issueToken({ id, email, role }, config.AUTH_SECRET, 600)}` };
}
