import { describe, expect, it } from 'vitest';
import {
  STRATEGY_descriptors,
  isLabOnlyStrategy,
  isSafeStrategy,
  listStrategies,
} from '../../apps/api/src/modules/experiments/strategies.js';

/**
 * Strategy registry (Phase 3) — the single source of truth both the API and the dashboard read.
 *
 * The contract the rest of the system relies on: exactly three safe strategies are offerable on the
 * public path, the unsafe baseline is registry-visible but lab-only, and the `safe`/`labOnly` flags
 * agree with those claims. A drift here is what would let the unsafe strategy leak onto production
 * inventory, so it is pinned independently of the HTTP and SQL layers.
 */

describe('listStrategies', () => {
  it('offers exactly the three safe strategies to public consumers', () => {
    const ids = listStrategies(false).map((d) => d.id);
    expect(ids).toEqual(['atomic_update', 'pessimistic', 'optimistic']);
  });

  it('appends the unsafe baseline only when the lab is included', () => {
    const publicIds = listStrategies(false).map((d) => d.id);
    const labIds = listStrategies(true).map((d) => d.id);
    expect(labIds).toContain('unsafe_lab');
    expect(publicIds).not.toContain('unsafe_lab');
    expect(labIds).toHaveLength(publicIds.length + 1);
  });

  it('never exposes a lab-only descriptor on the public listing', () => {
    for (const descriptor of listStrategies(false)) expect(descriptor.labOnly).toBe(false);
  });
});

describe('safe / labOnly classification', () => {
  it('marks the three safe strategies safe and offerable', () => {
    for (const id of ['atomic_update', 'pessimistic', 'optimistic'] as const) {
      expect(isSafeStrategy(id)).toBe(true);
      expect(isLabOnlyStrategy(id)).toBe(false);
    }
  });

  it('marks the baseline unsafe AND lab-only', () => {
    expect(isSafeStrategy('unsafe_lab')).toBe(false);
    expect(isLabOnlyStrategy('unsafe_lab')).toBe(true);
  });
});

describe('descriptor integrity', () => {
  it('covers every registered strategy with real SQL and tradeoffs (display, not paraphrase)', () => {
    for (const descriptor of Object.values(STRATEGY_descriptors)) {
      expect(descriptor.sql.trim().length).toBeGreaterThan(0);
      expect(descriptor.tradeoffs.length).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
    }
  });
});
