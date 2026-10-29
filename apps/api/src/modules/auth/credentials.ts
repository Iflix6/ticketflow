import { createHash, createHmac, randomBytes, randomUUID, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from '../../shared/errors.js';
import type { AuthenticatedUser, TokenPayload, UserRole } from './types.js';

/**
 * Local demo credentials (spec allows "a small local demo identity system … or explicitly documented
 * local test tokens"). Both are implemented here and both are honest about their limits:
 *
 * - Password hashing uses Node's built-in scrypt (memory-hard, no extra dependency). It is adequate
 *   for a local lab; a production system would use Argon2id with tuned parameters and a secrets
 *   manager. Recorded in the hardening backlog.
 * - Tokens are HMAC-signed, short-lived, and carry only id/email/role. They are NOT a session
 *   mechanism: DB-backed sessions with rotation arrive together with the booking UI.
 */

/**
 * `promisify` keeps only the 3-arg scrypt overload, but the cost parameters must be passed
 * explicitly (silent defaults would make stored hashes unverifiable after a parameter change), so
 * the promisified function is annotated with the exact 4-arg signature we use.
 */
const scryptAsync = promisify(scrypt) as unknown as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;
const SCRYPT_KEYLEN = 32;
const PREFIX = 'scrypt';

/**
 * A correctly formatted scrypt hash of a throwaway random value, built once at module load. Its
 * content is meaningless and it is never a valid login; it exists only so the "unknown account" and
 * "token-only demo identity" branches of login do the SAME scrypt work as a real password check.
 * Without it those branches return immediately, and the response-time gap is enough to enumerate
 * which emails have a password account (see `authenticateCredentials`).
 */
export const DUMMY_PASSWORD_HASH: string = (() => {
  const salt = randomBytes(16);
  const derived = scryptSync(randomBytes(32), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  return `${PREFIX}$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
})();

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) {
    throw new AppError('validation_failed', 'Password must be at least 12 characters');
  }
  const salt = randomBytes(16);
  const derived = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
  const encoded = Buffer.from(derived).toString('base64');
  return `${PREFIX}$${SCRYPT_OPTIONS.N}$${SCRYPT_OPTIONS.r}$${SCRYPT_OPTIONS.p}$${salt.toString('base64')}$${encoded}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, n, r, p, salt, hash] = parts;
  if (!n || !r || !p || !salt || !hash) return false;

  const derived = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), 32, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  const expected = Buffer.from(hash, 'base64');
  return expected.length === derived.length && timingSafeEqual(expected, Buffer.from(derived));
}

const TOKEN_PREFIX = 'tf1';

const base64url = (input: Buffer | string): string =>
  Buffer.from(input).toString('base64url');

const sign = (secret: string, material: string): string =>
  base64url(createHmac('sha256', secret).update(material).digest());

export function issueToken(user: AuthenticatedUser, secret: string, ttlSeconds: number): string {
  const payload: TokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${TOKEN_PREFIX}.${body}.${sign(secret, body)}`;
}

/** Verifies signature and expiry; throws a 401-classified AppError otherwise (never 500). */
export function verifyToken(token: string, secret: string): TokenPayload {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) {
    throw new AppError('unauthorized', 'Malformed authorization token');
  }
  const [, body = '', providedSignature = ''] = parts;

  const expectedSignature = sign(secret, body);
  const provided = Buffer.from(providedSignature, 'base64url');
  const expected = Buffer.from(expectedSignature, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new AppError('unauthorized', 'Authorization token signature is invalid');
  }

  let payload: TokenPayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
  } catch {
    throw new AppError('unauthorized', 'Authorization token payload is unreadable');
  }

  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new AppError('unauthorized', 'Authorization token has expired');
  }
  if (typeof payload.sub !== 'string' || typeof payload.email !== 'string' || !ROLE_VALUES.has(payload.role)) {
    throw new AppError('unauthorized', 'Authorization token identity is invalid');
  }
  return payload;
}

const ROLE_VALUES = new Set<string>(['CUSTOMER', 'LAB_ADMIN']);

/** Deterministic pseudo-email for load-test actors; never a real address, never reused. */
export function syntheticActorEmail(label: string): string {
  const digest = createHash('sha256').update(label).digest('hex').slice(0, 20);
  return `actor-${digest}@load.test`;
}

export function newRequestId(): string {
  return randomUUID();
}

export type { UserRole };
