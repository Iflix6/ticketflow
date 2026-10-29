import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import type { AppConfig } from '@ticketflow/config';
import { asyncHandler } from '../../middleware/request-context.js';
import { sendJson } from '../../shared/respond.js';
import { parseBody } from '../../shared/validation.js';
import { AppError } from '../../shared/errors.js';
import { DUMMY_PASSWORD_HASH, issueToken, verifyPassword, verifyToken } from './credentials.js';
import { SESSION_COOKIE, SessionService, parseCookie, sessionCookie } from './sessions.js';
import type { UserRole } from './types.js';

/**
 * Authentication endpoints, split by what they are for:
 *
 * - `createAuthRouter` — the local demo token exchange (spec: "explicitly documented local test
 *   tokens"). Lab-gated, because a production-shaped deployment must not expose a password-for-token
 *   endpoint at all.
 * - `createSessionRouter` — the Phase-5 browser session (DB-backed, HttpOnly cookie, hashed-at-rest
 *   tokens, explicit rotation; see `sessions.ts`). Mounted unconditionally: it is the booking UI's
 *   auth path, and it satisfies the promise recorded in migration 0003 and `authenticate.ts` that
 *   the session mechanism arrives with the browser UI "behind the same `req.user` contract".
 *
 * Known limitation (hardening backlog): password verification is single-factor with no lockout —
 * acceptable for synthetic local data, never for real credentials.
 */

const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(12).max(200),
});

type UserRow = {
  id: string;
  email: string;
  role: UserRole;
  password_hash: string | null;
};

/**
 * One generic failure message for unknown user and wrong password: no account enumeration.
 * Token-only demo identities (password_hash IS NULL) can never log in with a password.
 *
 * The scrypt check always runs, even when no row matched or the row is token-only, so an unknown
 * email cannot be told apart from a wrong password by response time alone (the constant-time twin of
 * the shared error message above — see `DUMMY_PASSWORD_HASH`).
 */
async function authenticateCredentials(db: Database, email: string, password: string): Promise<UserRow> {
  // Parameterized lookup; case-insensitive to match the unique index in migration 0003.
  const result = await db.query<UserRow>(
    'SELECT id, email, role, password_hash FROM app_users WHERE lower(email) = lower($1)',
    [email],
  );
  const user = result.rows[0];
  const storedHash = user?.password_hash ?? DUMMY_PASSWORD_HASH;
  const presented = await verifyPassword(password, storedHash);
  if (user === undefined || user.password_hash === null || !presented) {
    throw new AppError('unauthorized', 'Credentials are not valid');
  }
  return user;
}

export function createAuthRouter(db: Database, config: AppConfig): Router {
  const router = Router();

  router.post(
    '/token',
    asyncHandler(async (req, res) => {
      const { email, password } = parseBody(req, loginBodySchema);
      const user = await authenticateCredentials(db, email, password);

      const token = issueToken(
        { id: user.id, email: user.email, role: user.role },
        config.AUTH_SECRET,
        config.SESSION_TTL_HOURS * 3600,
      );

      req.log.info({ role: user.role }, 'demo token issued');
      // Same `{ data: ... }` envelope as every other endpoint, so clients parse one shape everywhere.
      sendJson(res, 200, { data: { token, tokenType: 'Bearer', expiresInSeconds: config.SESSION_TTL_HOURS * 3600 } }, req.id);
    }),
  );

  return router;
}

export function createSessionRouter(db: Database, config: AppConfig): Router {
  const router = Router();
  const sessions = new SessionService(db);
  const ttlSeconds = () => config.SESSION_TTL_HOURS * 3600;
  const secure = config.NODE_ENV === 'production';

  const cookieToken = (req: { header(name: string): string | undefined }): string | undefined =>
    parseCookie(req.header('cookie'), SESSION_COOKIE);

  router.post(
    '/session',
    asyncHandler(async (req, res) => {
      const { email, password } = parseBody(req, loginBodySchema);
      const user = await authenticateCredentials(db, email, password);
      const token = await sessions.start(user.id, ttlSeconds());

      res.append('Set-Cookie', sessionCookie(token, ttlSeconds(), secure));
      req.log.info({ role: user.role }, 'session started');
      sendJson(
        res,
        200,
        { data: { user: { id: user.id, email: user.email, role: user.role }, expiresAt: token.expiresAt } },
        req.id,
      );
    }),
  );

  router.get(
    '/session',
    asyncHandler(async (req, res) => {
      // "Who am I?" — resolves through either auth path with the same precedence as the
      // `authenticate` middleware: session cookie first, bearer token for scripts.
      const cookie = cookieToken(req);
      let user = cookie ? await sessions.resolve(cookie) : undefined;
      if (!user) {
        const header = req.header('authorization');
        const [scheme, value] = header ? header.split(' ') : [];
        if (scheme?.toLowerCase() === 'bearer' && value) {
          const payload = verifyToken(value.trim(), config.AUTH_SECRET);
          user = { id: payload.sub, email: payload.email, role: payload.role };
        }
      }
      if (!user) throw new AppError('unauthorized', 'Authentication is required');
      sendJson(res, 200, { data: { user } }, req.id);
    }),
  );

  router.post(
    '/session/rotate',
    asyncHandler(async (req, res) => {
      const token = cookieToken(req);
      if (!token) throw new AppError('unauthorized', 'No session cookie present');
      const rotated = await sessions.rotate(token, ttlSeconds());
      if (!rotated) throw new AppError('unauthorized', 'Session is not valid or was rotated by a concurrent request');

      res.append('Set-Cookie', sessionCookie(rotated, ttlSeconds(), secure));
      sendJson(res, 200, { data: { rotated: true, expiresAt: rotated.expiresAt } }, req.id);
    }),
  );

  router.post(
    '/session/logout',
    asyncHandler(async (req, res) => {
      const token = cookieToken(req);
      const revoked = token ? await sessions.revoke(token) : false;
      res.append('Set-Cookie', sessionCookie(undefined, 0, secure));
      // Logout is idempotent by design: no session, or an already-dead one, still answers 200 —
      // the client's goal ("I am not signed in anymore") is satisfied either way.
      sendJson(res, 200, { data: { revoked } }, req.id);
    }),
  );

  return router;
}
