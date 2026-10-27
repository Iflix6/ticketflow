import { createHash } from 'node:crypto';

/**
 * Canonicalization + hashing used for idempotency request comparison.
 *
 * The whole point of `request_hash` is deciding "is this the same request I already served?". A
 * hash of the raw body text would treat `{a:1,b:2}` and `{b:2,a:1}` — the same request after a
 * client re-serialization — as different payloads, producing spurious `idempotency_key_reuse`. So
 * we re-encode with keys sorted and insignificant whitespace removed before hashing.
 *
 * Values are JSON scalars/objects/arrays only (request bodies are already Zod-parsed), so a stable
 * recursive key sort is a sufficient canonical form here — no need for full JSON Canonicalization
 * Scheme edge cases like number reformatting, which Zod has already normalized.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      // Drop undefined so `{a:1,b:undefined}` and `{a:1}` canonicalize identically.
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }
  return value;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Convenience: the stable fingerprint of a (already-parsed) request body. */
export function hashRequestPayload(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}
