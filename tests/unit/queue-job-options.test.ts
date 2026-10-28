import { describe, expect, it } from 'vitest';
import { QUEUE, dispatchJobId, expiryJobId, jobDefaults, redisOptionsFromUrl } from '../../apps/worker/src/queues.js';

/**
 * Hermetic guards for the two BullMQ option traps that were LIVE BUGS in Phase 4, caught only by the
 * Redis-backed recovery suite. Both fail inside `add()`, so an illegal value does not look like a
 * misconfiguration — it looks like a worker that quietly never publishes anything:
 *  - a custom job id containing ':' is rejected outright (`Job.validateOptions`);
 *  - `backoff.jitter` is validated as a FRACTION 0..1 even though BullMQ's own docstring calls it a
 *    percentage, so `jitter: 50` throws on every add.
 * Pinning them here means a regression fails in seconds, on a laptop with no Docker running.
 */
describe('BullMQ job options stay legal for the client', () => {
  it('derives colon-free job ids', () => {
    for (const id of [dispatchJobId('42'), expiryJobId('11111111-1111-4111-8111-111111111111')]) {
      expect(id).not.toContain(':');
    }
    expect(dispatchJobId('42')).toBe('outbox-42');
    expect(expiryJobId('abc')).toBe('expiry-abc');
  });

  it('derives ids deterministically, which is what makes a relay retry dedupe', () => {
    expect(dispatchJobId('7')).toBe(dispatchJobId('7'));
    expect(dispatchJobId('7')).not.toBe(dispatchJobId('8'));
    // The inputs are DB-generated (bigint outbox id, uuid reservation id), so they can never carry a
    // colon themselves — the prefix scheme is what keeps the composed id legal.
    for (const raw of ['42', '999999', '11111111-1111-4111-8111-111111111111']) {
      expect(dispatchJobId(raw)).not.toContain(':');
      expect(expiryJobId(raw)).not.toContain(':');
    }
  });

  it('keeps backoff jitter inside the 0..1 fraction range BullMQ validates', () => {
    const defaults = jobDefaults(3);
    expect(defaults.backoff.jitter).toBeGreaterThanOrEqual(0);
    expect(defaults.backoff.jitter).toBeLessThanOrEqual(1);
    expect(defaults.backoff.type).toBe('exponential');
    expect(defaults.backoff.delay).toBeGreaterThan(0);
  });

  it('bounds finished-job retention instead of keeping everything forever', () => {
    const defaults = jobDefaults(4);
    expect(defaults.attempts).toBe(4);
    // `removeOnComplete: false` means "never delete", which grows Redis until it dies. Retention must
    // be bounded by BOTH age and count: it only has to outlast the relay's retry cadence, since the
    // consumer's dedup marker is what makes a later duplicate delivery harmless anyway. (BullMQ's own
    // `KeepJobs` type would tolerate a count-only config, which is why `jobDefaults` narrows it.)
    for (const keep of [defaults.removeOnComplete, defaults.removeOnFail]) {
      expect(keep).toBeInstanceOf(Object);
      expect(keep.age).toBeGreaterThan(0);
      expect(keep.count).toBeGreaterThan(0);
    }
    expect(defaults.removeOnFail.age).toBeGreaterThan(defaults.removeOnComplete.age); // dead letters linger for humans
  });

  it('applies the maxRetriesPerRequest:null rule BullMQ requires, per queue topology', () => {
    const connection = redisOptionsFromUrl('redis://127.0.0.1:6399/2');
    expect(connection).toMatchObject({ host: '127.0.0.1', port: 6399, db: 2, maxRetriesPerRequest: null });
    expect(QUEUE.dispatchDead).toBe('outbox-dispatch-dead');
    expect(QUEUE.expiryDead).toBe('reservation-expiry-dead');
  });

  it('passes credential-bearing urls through decoded', () => {
    const connection = redisOptionsFromUrl('redis://user%40corp:s3%23cr3t@example:6379');
    expect(connection).toMatchObject({ host: 'example', port: 6379, username: 'user@corp', password: 's3#cr3t' });
  });
});
