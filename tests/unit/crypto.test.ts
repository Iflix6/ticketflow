import { describe, expect, it } from 'vitest';
import { canonicalJson, hashRequestPayload, sha256Hex } from '../../apps/api/src/shared/crypto.js';

/**
 * The idempotency `request_hash` decides "is this the same request I already served?". If key order
 * or insignificant whitespace changed the hash, a client that re-serialized the same logical body
 * would get a spurious `idempotency_key_reuse`. These tests pin that that cannot happen.
 */

describe('canonicalJson', () => {
  it('sorts object keys recursively so key order is irrelevant', () => {
    const a = canonicalJson({ b: 1, a: 2, nested: { z: 1, y: { q: 2, p: 1 } } });
    const b = canonicalJson({ nested: { y: { p: 1, q: 2 }, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"nested":{"y":{"p":1,"q":2},"z":1}}');
  });

  it('preserves array order (arrays are positional, not sets)', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it('drops undefined-valued keys so an absent optional and an explicit undefined match', () => {
    expect(canonicalJson({ x: 1, y: undefined })).toBe(canonicalJson({ x: 1 }));
  });

  it('keeps null (a real value) distinct from an absent key', () => {
    expect(canonicalJson({ y: null })).not.toBe(canonicalJson({}));
  });
});

describe('sha256Hex / hashRequestPayload', () => {
  it('produces the known SHA-256 of the empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is stable for equal logical payloads and differs for different ones', () => {
    const payload = { tierId: 't', quantity: 2, reservationTtlSeconds: null, strategy: 'atomic_update' };
    const reordered = { strategy: 'atomic_update', reservationTtlSeconds: null, quantity: 2, tierId: 't' };
    expect(hashRequestPayload(payload)).toBe(hashRequestPayload(reordered));
    expect(hashRequestPayload({ quantity: 2 })).not.toBe(hashRequestPayload({ quantity: 3 }));
  });
});
