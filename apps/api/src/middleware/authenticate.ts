import type { RequestHandler } from 'express';
import type { AppConfig } from '@ticketflow/config';
import { AppError } from '../shared/errors.js';
import { verifyToken } from '../modules/auth/credentials.js';
import { SESSION_COOKIE, parseCookie } from '../modules/auth/sessions.js';
import type { SessionService } from '../modules/auth/sessions.js';
import type { AuthenticatedUser, UserRole } from '../modules/auth/types.js';

/**
 * Authentication for a local lab. Two mechanisms, one contract:
 *
 * 1. Bearer tokens (HMAC-signed, short-lived, `modules/auth/credentials.ts`) — the documented local
 *    test-token mechanism, kept for scripts, curl examples, and load-test actors.
 * 2. DB-backed cookie sessions (`modules/auth/sessions.ts`) — the Phase-5 browser mechanism. An
 *    explicit `Authorization` header WINS over an ambient cookie so a script is never silently
 *    downgraded by a stray browser session, and the lookup only runs when a session service was
 *    injected (routes that predate Phase 5 keep the token-only behaviour).
 *
 * Both paths populate the identical `req.user` shape; nothing downstream (requireRole, ownership
 * checks, services) can tell how the caller authenticated.
 */

function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return undefined;
  return scheme.toLowerCase() === 'bearer' ? value.trim() : undefined;
}

export function authenticate(config: AppConfig, required: boolean, sessions?: SessionService): RequestHandler {
  return async (req, _res, next) => {
    const attach = (user: AuthenticatedUser): void => {
      req.user = user;
      req.log = req.log.child({ userId: user.id, role: user.role });
    };

    const token = extractToken(req.header('authorization'));
    if (token) {
      try {
        const payload = verifyToken(token, config.AUTH_SECRET);
        attach({ id: payload.sub, email: payload.email, role: payload.role });
        return next();
      } catch (error) {
        // An invalid token is a client error even when the route treats auth as optional.
        if (!required) return next();
        return next(
          error instanceof AppError && error.code === 'unauthorized'
            ? error
            : new AppError('unauthorized', 'Authorization is invalid', undefined, error),
        );
      }
    }

    const cookie = parseCookie(req.header('cookie'), SESSION_COOKIE);
    if (cookie && sessions) {
      const user = await sessions.resolve(cookie);
      if (user) {
        attach(user);
        return next();
      }
      if (required) return next(new AppError('unauthorized', 'Session is not valid or has expired'));
      return next();
    }

    return required ? next(new AppError('unauthorized', 'Authorization header is required')) : next();
  };
}

/** Authorization: role check. Combined with the lab gate this is defence in depth, not either/or. */
export function requireRole(...roles: UserRole[]): RequestHandler {
  const allowed = new Set<string>(roles);
  return (req, _res, next) => {
    if (!req.user) return next(new AppError('unauthorized', 'Authentication is required'));
    if (!allowed.has(req.user.role)) {
      return next(new AppError('forbidden', `Role ${req.user.role} is not permitted here`));
    }
    return next();
  };
}

export function requireUser(req: { user?: AuthenticatedUser }): AuthenticatedUser {
  if (!req.user) throw new AppError('unauthorized', 'Authentication is required');
  return req.user;
}
