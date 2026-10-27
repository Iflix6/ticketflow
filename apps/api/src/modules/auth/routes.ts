import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../../db/pool.js';
import type { AppConfig } from '@ticketflow/config';
import { asyncHandler } from '../../middleware/request-context.js';
import { sendJson } from '../../shared/respond.js';
import { parseBody } from '../../shared/validation.js';
import { AppError } from '../../shared/errors.js';
import { issueToken, verifyPassword } from './credentials.js';
import type { UserRole } from './types.js';

/**
 * Local demo token exchange (spec: "explicitly documented local test tokens").
 *
 * Deliberately Phase-1 minimal: email + scrypt-verifiable password in, bounded HMAC token out.
 * The `sessions` table exists in schema (migration 0003) but DB-backed session rotation arrives
 * with the browser UI (Phase 5); until then these tokens are stateless and short-lived, and this
 * router is only mounted when the lab gate allows (local/test deployments).
 *
 * Known limitation (recorded in the hardening backlog): password verification is single-factor
 * with no lockout — acceptable for synthetic local data, never for real credentials.
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

export function createAuthRouter(db: Database, config: AppConfig): Router {
  const router = Router();

  router.post(
    '/token',
    asyncHandler(async (req, res) => {
      const { email, password } = parseBody(req, loginBodySchema);

      // Parameterized lookup; case-insensitive to match the unique index in migration 0003.
      const result = await db.query<UserRow>(
        'SELECT id, email, role, password_hash FROM app_users WHERE lower(email) = lower($1)',
        [email],
      );
      const user = result.rows[0];

      // One generic failure message for unknown user and wrong password: no account enumeration.
      // Token-only demo identities (password_hash IS NULL) can never log in with a password.
      const presented =
        user !== undefined && user.password_hash !== null
          ? await verifyPassword(password, user.password_hash)
          : false;
      if (user === undefined || !presented) {
        throw new AppError('unauthorized', 'Credentials are not valid');
      }

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
