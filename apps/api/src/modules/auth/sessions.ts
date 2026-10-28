import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../../shared/crypto.js';
import type { Database } from '../../db/pool.js';
import type { AuthenticatedUser } from './types.js';

/**
 * DB-backed browser sessions (the Phase-5 half of the promise recorded in migration 0003 and
 * `middleware/authenticate.ts`: cookie sessions replace the stateless demo token "behind the same
 * `req.user` contract").
 *
 * Design decisions, all traceable to the `sessions` table that shipped in 0003:
 * - The client receives 32 random bytes (base64url). Only its SHA-256 hash is stored, so a database
 *   leak does not hand over usable session tokens (same posture as `password_hash`).
 * - **Rotation is explicit, not per-request.** Rotating the token hash on every authenticated
 *   request would race browser-parallel fetches: request A rotates server-side while request B is
 *   already in flight with the old cookie, and B would then 401 for no reason the user caused.
 *   Instead the session id is stable for the visit, `POST /auth/session/rotate` swaps the hash
 *   atomically (a single UPDATE keyed by the OLD hash — a concurrent rotate loses and the caller
 *   must re-authenticate), and expiry is absolute (`expires_at`, database clock — no silent
 *   sliding that would extend a stolen session forever).
 * - Revocation is `revoked_at IS NOT NULL` (audit-friendly: the row survives logout), and expiry is
 *   compared with `app.now()`, never the application clock (ADR-0006).
 * - CSRF posture: `SameSite=Lax` blocks cross-site POSTs from sending the cookie, and every session
 *   mutation is a POST/JSON endpoint. A local lab does not need a double-submit token; production
 *   would add one — recorded in the hardening backlog.
 */

export const SESSION_COOKIE = 'tf_session';

export interface SessionToken {
  /** The raw base64url token; the only place it ever exists is here and in the Set-Cookie header. */
  readonly value: string;
  readonly expiresAt: string;
}

interface SessionIdentityRow {
  id: string;
  email: string;
  role: AuthenticatedUser['role'];
}

interface SessionLookupRow extends SessionIdentityRow {
  session_id: string;
  expires_at: string;
}

const newTokenValue = (): string => randomBytes(32).toString('base64url');

export class SessionService {
  constructor(private readonly db: Database) {}

  /** Creates a fresh session row and returns the raw token. Also prunes this user's dead sessions. */
  async start(userId: string, ttlSeconds: number): Promise<SessionToken> {
    // Bounded retention without a sweeper job: each login cleans that user's own expired/revoked
    // rows, so the table cannot grow per-user without limit on a long-lived local database.
    await this.db.query(
      `DELETE FROM sessions
        WHERE user_id = $1
          AND (revoked_at IS NOT NULL OR expires_at <= app.now())`,
      [userId],
    );

    const value = newTokenValue();
    const result = await this.db.query<{ expires_at: string }>(
      `INSERT INTO sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, app.now() + make_interval(secs => $3))
       RETURNING expires_at`,
      [userId, sha256Hex(value), Math.floor(ttlSeconds)],
    );
    const row = result.rows[0];
    if (!row) throw new Error('session insert returned no row'); // unreachable; satisfies strict mode
    return { value, expiresAt: row.expires_at };
  }

  /** Resolves a raw token to identity, honoring expiry and revocation. Undefined = not signed in. */
  async resolve(token: string): Promise<AuthenticatedUser | undefined> {
    const result = await this.db.query<SessionLookupRow>(
      `SELECT s.id AS session_id, u.id, u.email, u.role, s.expires_at
         FROM sessions s
         JOIN app_users u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > app.now()`,
      [sha256Hex(token)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { id: row.id, email: row.email, role: row.role };
  }

  /**
   * Rotates in one atomic statement: the UPDATE only matches the presented (old) hash, so two
   * concurrent rotations cannot both succeed — the loser resolves to "no session" and the caller
   * re-authenticates. Returns undefined when the presented token was not a live session.
   */
  async rotate(token: string, ttlSeconds: number): Promise<SessionToken | undefined> {
    const value = newTokenValue();
    const result = await this.db.query<{ expires_at: string }>(
      `UPDATE sessions
          SET token_hash = $2,
              expires_at = app.now() + make_interval(secs => $3)
        WHERE token_hash = $1
          AND revoked_at IS NULL
          AND expires_at > app.now()
      RETURNING expires_at`,
      [sha256Hex(token), sha256Hex(value), Math.floor(ttlSeconds)],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { value, expiresAt: row.expires_at };
  }

  /** Revokes the presented session if live. Returns whether a session was actually revoked. */
  async revoke(token: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `UPDATE sessions
          SET revoked_at = app.now()
        WHERE token_hash = $1
          AND revoked_at IS NULL
      RETURNING id`,
      [sha256Hex(token)],
    );
    return result.rowCount !== null && result.rowCount > 0;
  }
}

/** Minimal Cookie header parser — one dependency fewer, and the semantics we need are small. */
export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw; // a malformed escape is not a reason to reject an otherwise-readable value
    }
  }
  return undefined;
}

/**
 * Set-Cookie builder. `Secure` follows NODE_ENV (a local lab on http://127.0.0.1 cannot set Secure
 * cookies; a production-shaped deployment must not send them over plain http). Max-Age 0 with an
 * epoch Expires is the standard deletion incantation.
 */
export function sessionCookie(token: SessionToken | undefined, ttlSeconds: number, secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=${token?.value ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (token) {
    attrs.push(`Max-Age=${Math.floor(ttlSeconds)}`);
    attrs.push(`Expires=${new Date(Date.now() + ttlSeconds * 1000).toUTCString()}`);
  } else {
    attrs.push('Max-Age=0', 'Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  }
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}
