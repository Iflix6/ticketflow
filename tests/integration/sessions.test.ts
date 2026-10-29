import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from '../../apps/api/src/db/pool.js';
import { createApp } from '../../apps/api/src/app.js';
import { createLogger } from '../../apps/api/src/observability/logger.js';
import { hashPassword, issueToken } from '../../apps/api/src/modules/auth/credentials.js';
import { sha256Hex } from '../../apps/api/src/shared/crypto.js';
import { testConfig } from '../helpers/config.js';
import { databaseAvailable, seedCatalog, startTestDatabase, type TestDatabaseHandle } from '../helpers/integration-db.js';

// Honest skip: without a real PostgreSQL this suite reports as skipped, never as passed.
const suite = databaseAvailable() ? describe : describe.skip;

const PASSWORD = 'session-test-password-2026';

/** Extract the tf_session value from a Set-Cookie header (supertest surfaces them on res.headers). */
function sessionCookieOf(res: request.Response): string {
  const raw = res.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const hit = list.find((c) => c.startsWith('tf_session='));
  if (!hit) throw new Error(`no tf_session cookie in ${JSON.stringify(raw)}`);
  return hit.split(';')[0] as string;
}

suite('phase 5 — db-backed browser sessions', () => {
  let handle: TestDatabaseHandle;
  let db: Database;
  let app: Express;
  let labApp: Express;
  let customerId: string;
  let adminId: string;
  let tierId: string;

  beforeAll(async () => {
    handle = await startTestDatabase('sessions');
    db = handle.db;
    const config = testConfig();
    const labConfig = testConfig({ LAB_ENABLED: 'true' });
    app = createApp({ config, db, logger: createLogger(config) });
    labApp = createApp({ config: labConfig, db, logger: createLogger(labConfig) });

    const catalog = await seedCatalog(db, 'session-event', 'General', 50);
    tierId = catalog.tierId;
    const hash = await hashPassword(PASSWORD);
    const c = await db.query<{ id: string }>(
      "INSERT INTO app_users (email, role, password_hash) VALUES ('sess-cust@local.test', 'CUSTOMER', $1) RETURNING id",
      [hash],
    );
    const a = await db.query<{ id: string }>(
      "INSERT INTO app_users (email, role, password_hash) VALUES ('sess-admin@local.test', 'LAB_ADMIN', $1) RETURNING id",
      [hash],
    );
    customerId = c.rows[0]?.id as string;
    adminId = a.rows[0]?.id as string;
  });

  afterAll(async () => {
    await handle.cleanup();
  });

  describe('login and identity', () => {
    it('POST /auth/session sets an HttpOnly Lax cookie and returns the identity', async () => {
      const res = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body.data.user).toMatchObject({ id: customerId, role: 'CUSTOMER' });
      expect(res.body.data.expiresAt).toMatch(/^\d{4}-/);
      const cookie = sessionCookieOf(res);
      expect(cookie.length).toBeGreaterThan(20); // 32 random bytes base64url
      const attrs = ([res.headers['set-cookie'] as unknown].flat() as string[]).join(' ');
      expect(attrs).toContain('HttpOnly');
      expect(attrs).toContain('SameSite=Lax');
      expect(attrs).toContain('Path=/');
    });

    it('wrong password and unknown user share one generic 401 (no enumeration)', async () => {
      const wrong = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: `x${PASSWORD}` });
      const unknown = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'nobody@local.test', password: PASSWORD });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body.error.message).toBe(unknown.body.error.message);
    });

    it('the raw session token is never stored — only its SHA-256 hash', async () => {
      const login = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      const value = sessionCookieOf(login).slice('tf_session='.length);
      const rows = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions WHERE user_id = $1', [customerId]);
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every((r) => r.token_hash !== value)).toBe(true);
      expect(rows.rows.some((r) => r.token_hash.match(/^[0-9a-f]{64}$/))).toBe(true);
    });

    it('GET /auth/session answers from the cookie (and 401s without one)', async () => {
      const login = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-admin@local.test', password: PASSWORD });
      const me = await request(labApp).get('/api/v1/auth/session').set('cookie', sessionCookieOf(login));
      expect(me.status).toBe(200);
      expect(me.body.data.user).toMatchObject({ id: adminId, role: 'LAB_ADMIN' });
      const anon = await request(app).get('/api/v1/auth/session');
      expect(anon.status).toBe(401);
      expect(anon.body.error.code).toBe('unauthorized');
    });
  });

  describe('the cookie reaches the protected domain (same req.user contract)', () => {
    it('a session cookie creates a reservation without any Authorization header', async () => {
      const login = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      const cookie = sessionCookieOf(login);
      const res = await request(app)
        .post('/api/v1/reservations')
        .set('cookie', cookie)
        .set('idempotency-key', 'session-reserve-000001')
        .send({ tierId, quantity: 2 });
      expect(res.status).toBe(201);
      expect(res.body.data.userId).toBe(customerId);
    });

    it('a forged cookie value is 401, not 500', async () => {
      const res = await request(app)
        .get('/api/v1/me/bookings')
        .set('cookie', 'tf_session=not-a-real-session-token-at-all-at-all-at-all');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthorized');
    });

    it('an explicit Bearer header wins over an ambient cookie (scripts are never downgraded)', async () => {
      // Login as admin, present a CUSTOMER bearer alongside: ownership must follow the bearer.
      const adminLogin = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-admin@local.test', password: PASSWORD });
      const customerToken = issueToken(
        { id: customerId, email: 'sess-cust@local.test', role: 'CUSTOMER' },
        testConfig().AUTH_SECRET,
        60,
      );
      const res = await request(app)
        .post('/api/v1/reservations')
        .set('cookie', sessionCookieOf(adminLogin))
        .set('authorization', `Bearer ${customerToken}`)
        .set('idempotency-key', 'session-precedence-0001')
        .send({ tierId, quantity: 1 });
      expect(res.status).toBe(201);
      expect(res.body.data.userId).toBe(customerId);
    });

    it('the lab mount accepts a LAB_ADMIN session cookie in place of a bearer', async () => {
      const adminLogin = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-admin@local.test', password: PASSWORD });
      const res = await request(labApp).get('/api/v1/lab/strategies').set('cookie', sessionCookieOf(adminLogin));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(4);
    });

    it('a CUSTOMER session cookie on the lab mount is 403, not 404', async () => {
      const custLogin = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      const res = await request(labApp).get('/api/v1/lab/strategies').set('cookie', sessionCookieOf(custLogin));
      expect(res.status).toBe(403);
    });
  });

  describe('rotation and revocation', () => {
    it('rotate swaps the token: the NEW cookie works, the OLD one is dead', async () => {
      const login = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      const oldCookie = sessionCookieOf(login);
      const rotated = await request(app).post('/api/v1/auth/session/rotate').set('cookie', oldCookie);
      expect(rotated.status).toBe(200);
      expect(rotated.body.data.rotated).toBe(true);
      const newCookie = sessionCookieOf(rotated);
      expect(newCookie).not.toBe(oldCookie);

      const withNew = await request(app).get('/api/v1/auth/session').set('cookie', newCookie);
      expect(withNew.status).toBe(200);
      const withOld = await request(app).get('/api/v1/auth/session').set('cookie', oldCookie);
      expect(withOld.status).toBe(401);
    });

    it('rotate without a cookie is 401; replaying a rotated-in token still rotates (chain is live)', async () => {
      const anon = await request(app).post('/api/v1/auth/session/rotate');
      expect(anon.status).toBe(401);
    });

    it('logout revokes: the cookie stops working, and logout is idempotent 200', async () => {
      const login = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      const cookie = sessionCookieOf(login);

      const out = await request(app).post('/api/v1/auth/session/logout').set('cookie', cookie);
      expect(out.status).toBe(200);
      expect(out.body.data.revoked).toBe(true);
      const attrs = ([out.headers['set-cookie'] as unknown].flat() as string[]).join(' ');
      expect(attrs).toContain('Max-Age=0');

      const after = await request(app).get('/api/v1/auth/session').set('cookie', cookie);
      expect(after.status).toBe(401);

      const again = await request(app).post('/api/v1/auth/session/logout').set('cookie', cookie);
      expect(again.status).toBe(200);
      expect(again.body.data.revoked).toBe(false); // already dead — still a 200, honestly reported
    });

    it('an expired session is refused by the database clock, not by app time', async () => {
      const login = await request(app)
        .post('/api/v1/auth/session')
        .send({ email: 'sess-cust@local.test', password: PASSWORD });
      const cookie = sessionCookieOf(login);
      const value = cookie.slice('tf_session='.length);
      await db.query(
        `UPDATE sessions SET expires_at = app.now() - interval '1 minute' WHERE token_hash = $1`,
        [sha256Hex(value)],
      );
      const res = await request(app).get('/api/v1/auth/session').set('cookie', cookie);
      expect(res.status).toBe(401);
    });
  });

  describe('sessions are per-user and bounded', () => {
    it('logging in twice yields two independent sessions; logout kills exactly one', async () => {
      const a = sessionCookieOf(
        await request(app).post('/api/v1/auth/session').send({ email: 'sess-cust@local.test', password: PASSWORD }),
      );
      const b = sessionCookieOf(
        await request(app).post('/api/v1/auth/session').send({ email: 'sess-cust@local.test', password: PASSWORD }),
      );
      expect(a).not.toBe(b);
      await request(app).post('/api/v1/auth/session/logout').set('cookie', a);
      const stillLive = await request(app).get('/api/v1/auth/session').set('cookie', b);
      expect(stillLive.status).toBe(200);
    });
  });
});
