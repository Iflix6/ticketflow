import { describe, expect, it } from 'vitest';
import {
  issueToken,
  syntheticActorEmail,
  verifyPassword,
  verifyToken,
  hashPassword,
  DUMMY_PASSWORD_HASH,
} from '../../apps/api/src/modules/auth/credentials.js';
import { AppError } from '../../apps/api/src/shared/errors.js';
import type { AuthenticatedUser } from '../../apps/api/src/modules/auth/types.js';

const SECRET = 'credential_test_secret_value_32plus_chars';
const user: AuthenticatedUser = { id: '11111111-1111-4111-8111-111111111111', email: 'a@local.test', role: 'CUSTOMER' };

describe('password hashing (scrypt)', () => {
  it('round-trips a valid password and never stores it verbatim', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects wrong passwords and malformed stored values without throwing', async () => {
    const hash = await hashPassword('another long passphase');
    expect(await verifyPassword('not the password at all', hash)).toBe(false);
    expect(await verifyPassword('anything', 'plaintext$no$no$no$no$no')).toBe(false);
    expect(await verifyPassword('anything', 'sha1$1$1$1$abc$def')).toBe(false);
  });

  it('enforces a minimum length at creation time (400-classified)', async () => {
    await expect(hashPassword('short')).rejects.toThrow(AppError);
  });

  it('produces different hashes for the same password (per-hash salt)', async () => {
    const a = await hashPassword('the same long password');
    const b = await hashPassword('the same long password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('the same long password', b)).toBe(true);
  });

  it('exposes a well-formed dummy hash so the unknown-account login branch costs real scrypt work', async () => {
    // SEC-1 regression guard: `authenticateCredentials` verifies against DUMMY_PASSWORD_HASH when no
    // live password row exists, so an unknown email is not distinguishable from a wrong password by
    // timing. The dummy must (a) parse as a genuine scrypt hash so the KDF actually runs, and (b) never
    // match, and (c) be structurally identical to a real hash (same prefix/params/segment count).
    expect(DUMMY_PASSWORD_HASH).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(DUMMY_PASSWORD_HASH.split('$')).toHaveLength(6);
    expect(await verifyPassword('anything at all here', DUMMY_PASSWORD_HASH)).toBe(false);
    expect(await verifyPassword('', DUMMY_PASSWORD_HASH)).toBe(false);
    const real = await hashPassword('a genuine long password');
    expect(real.split('$')).toHaveLength(DUMMY_PASSWORD_HASH.split('$').length);
  });
});

describe('HMAC demo tokens', () => {
  it('issues and verifies a well-formed token', () => {
    const token = issueToken(user, SECRET, 3600);
    const payload = verifyToken(token, SECRET);
    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe('CUSTOMER');
  });

  it('rejects tampered payloads, foreign signatures, garbage and expiry', () => {
    const token = issueToken(user, SECRET, 3600);
    const [prefix, body, signature] = token.split('.');

    expect(() => verifyToken(`${prefix}.${Buffer.from('{"sub":"evil"}').toString('base64url')}.${signature}`, SECRET)).toThrow(
      AppError,
    );
    expect(() => verifyToken(`${prefix}.${body}.${'A'.repeat(signature?.length ?? 10)}`, SECRET)).toThrow(/signature/);
    expect(() => verifyToken('not.a.token.at.all', SECRET)).toThrow(/Malformed/);
    expect(() => verifyToken(issueToken(user, SECRET, -10), SECRET)).toThrow(/expired/);
    // Right shape, wrong secret: signature check must be the failure, not a 500.
    expect(() => verifyToken(token, 'a_completely_different_secret_value_32_chars!')).toThrow(/signature/);
  });

  it('classifies every rejection as 401, never 500', () => {
    try {
      verifyToken('tf1.###.###', SECRET);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(401);
    }
  });

  it('derives stable, bounded synthetic actor emails for load tests', () => {
    const a = syntheticActorEmail('buyer-0001');
    expect(a).toMatch(/^actor-[0-9a-f]{20}@load\.test$/);
    expect(syntheticActorEmail('buyer-0001')).toBe(a);
    expect(syntheticActorEmail('buyer-0002')).not.toBe(a);
  });
});
