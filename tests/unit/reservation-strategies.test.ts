import { describe, expect, it } from 'vitest';
import type { Queryable } from '../../apps/api/src/db/pool.js';
import {
  allocateOptimistic,
  allocatePessimistic,
  tryAllocate,
} from '../../apps/api/src/modules/reservations/repository.js';

/**
 * Strategy allocation classification (Safe A/B/C) verified with a scripted fake client.
 *
 * These are the decisions that must be right BEFORE the SQL is trusted against real PostgreSQL (the
 * integration suite runs the same functions against real rows). The two properties under test are the
 * ones the requirements call out explicitly: sold-out and conflict must be distinguishable, and no
 * strategy may write when the guard has already failed.
 */

type Canned = { rows: Record<string, unknown>[] };

class ScriptedQueryable {
  calls: Array<{ text: string; params: readonly unknown[] | undefined }> = [];
  constructor(private readonly script: Canned[]) {}

  // Returns a structurally-satisfied subset; repositories only read `.rows`.
  async query(_text: string, params?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.calls.push({ text: _text, params });
    const next = this.script.shift() ?? { rows: [] };
    return { rows: next.rows };
  }

  asQueryable(): Queryable {
    return this as unknown as Queryable;
  }

  get statements(): string[] {
    return this.calls.map((c) => c.text.split('\n')[0]?.trim() ?? '');
  }
}

const counters = (available: number, reserved: number, version = 0): Record<string, unknown> => ({
  available,
  reserved,
  sold: 0,
  version,
});

describe('Safe A — tryAllocate', () => {
  it('returns post-write counters when the guard matches', async () => {
    const fake = new ScriptedQueryable([{ rows: [counters(7, 3, 1)] }]);
    const result = await tryAllocate(fake.asQueryable(), 'tier-1', 3);
    expect(result).toMatchObject({ available: 7, reserved: 3 });
    expect(fake.calls).toHaveLength(1);
  });

  it('returns null (sold out) when zero rows match — and issues no second statement', async () => {
    const fake = new ScriptedQueryable([{ rows: [] }]);
    const result = await tryAllocate(fake.asQueryable(), 'tier-1', 99);
    expect(result).toBeNull();
    expect(fake.calls).toHaveLength(1);
  });
});

describe('Safe B — allocatePessimistic', () => {
  it('locks, sees insufficient availability, and reports sold_out WITHOUT writing', async () => {
    const fake = new ScriptedQueryable([{ rows: [counters(2, 0)] }]);
    const result = await allocatePessimistic(fake.asQueryable(), 'tier-1', 3);
    expect(result).toEqual({ kind: 'sold_out' });
    expect(fake.calls).toHaveLength(1); // the FOR UPDATE read only; the UPDATE never ran
    expect(fake.statements[0]).toContain('FOR UPDATE');
  });

  it('locks, validates, then performs a guarded relative write', async () => {
    const fake = new ScriptedQueryable([{ rows: [counters(5, 0, 4)] }, { rows: [counters(2, 3, 5)] }]);
    const result = await allocatePessimistic(fake.asQueryable(), 'tier-1', 3);
    expect(result).toEqual({ kind: 'allocated', counters: { available: 2, reserved: 3, sold: 0, version: 5 } });
    expect(fake.calls).toHaveLength(2);
    // The write is relative (available = available - $2), never a blind assignment from the snapshot.
    expect(fake.calls[1]?.text).toContain('available = available - $2');
  });
});

describe('Safe C — allocateOptimistic', () => {
  it('compare-and-set succeeds on the first matching version', async () => {
    const fake = new ScriptedQueryable([
      { rows: [{ available: 5, version: 7 }] },
      { rows: [counters(3, 2, 8)] },
    ]);
    const result = await allocateOptimistic(fake.asQueryable(), 'tier-1', 2, 5, () => 0);
    expect(result.kind).toBe('allocated');
    expect(fake.calls).toHaveLength(2);
    // The guard carries BOTH the version predicate and the availability predicate.
    expect(fake.calls[1]?.text).toContain('version = $2');
    expect(fake.calls[1]?.text).toContain('available >= $3');
  });

  it('stops retrying at sold_out (a real business rejection, not a conflict)', async () => {
    const fake = new ScriptedQueryable([{ rows: [{ available: 1, version: 3 }] }]);
    const result = await allocateOptimistic(fake.asQueryable(), 'tier-1', 2, 5, () => 0);
    expect(result).toEqual({ kind: 'sold_out' });
    expect(fake.calls).toHaveLength(1); // one read sees insufficient stock; no write, no retry
  });

  it('reports conflict (not sold_out) after exhausting its bounded retry budget', async () => {
    // Every read shows availability, but every CAS misses (version churns) → livelock bounded to conflict.
    const script: Canned[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      script.push({ rows: [{ available: 5, version: attempt }] }); // read
      script.push({ rows: [] }); // CAS update returns no rows
    }
    const fake = new ScriptedQueryable(script);
    const result = await allocateOptimistic(fake.asQueryable(), 'tier-1', 1, 3, () => 0);
    expect(result).toEqual({ kind: 'conflict', attempts: 3 });
    expect(fake.calls).toHaveLength(6); // 3 × (read + update)
  });
});
