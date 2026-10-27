import type { RequestHandler } from 'express';
import type { AppConfig } from '@ticketflow/config';
import { AppError } from '../shared/errors.js';
import { verifyToken } from '../modules/auth/credentials.js';
import type { AuthenticatedUser, UserRole } from '../modules/auth/types.js';

/**
 * Authentication for a local lab.
 *
 * Bearer tokens (HMAC-signed, short-lived, see `modules/auth/credentials.ts`) are the documented local
 * test-token mechanism. Cookie sessions replace this for the browser UI in Phase 5; the handler
 * contract (`req.user`) stays identical.
 */

function extractToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (!scheme || !value) return undefined;
  return scheme.toLowerCase() === 'bearer' ? value.trim() : undefined;
}

export function authenticate(config: AppConfig, required: boolean): RequestHandler {
  return (req, _res, next) => {
    const token = extractToken(req.header('authorization'));

    if (!token) {
      return required ? next(new AppError('unauthorized', 'Authorization header is required')) : next();
    }

    try {
      const payload = verifyToken(token, config.AUTH_SECRET);
      const user: AuthenticatedUser = { id: payload.sub, email: payload.email, role: payload.role };
      req.user = user;
      req.log = req.log.child({ userId: user.id, role: user.role });
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
