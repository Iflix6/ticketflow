import type { StrategyDescriptorDto, StrategyId } from '@ticketflow/contracts';

/**
 * Strategy descriptors.
 *
 * The SQL shown to the UI is the same text the repositories execute, kept here as a constant so the
 * dashboard can display the actual mechanism instead of a paraphrase. The implementations land in
 * Phase 2 (A) and Phase 3 (B, C, unsafe); the descriptors exist now because the API contract and the
 * documentation reference them.
 */

export const STRATEGY_descriptors: Record<StrategyId, StrategyDescriptorDto> = {
  atomic_update: {
    id: 'atomic_update',
    label: 'Safe A — atomic conditional UPDATE',
    summary:
      'One UPDATE both tests availability and mutates the counters; the row lock it takes is the serialization point.',
    sql: `UPDATE inventory
             SET available = available - $2,
                 reserved  = reserved + $2,
                 version   = version + 1,
                 updated_at = app.now()
           WHERE tier_id = $1 AND available >= $2
     RETURNING available, reserved, sold, version;`,
    safe: true,
    labOnly: false,
    tradeoffs: [
      'Single round trip; no retry logic needed.',
      'Zero rows returned means sold out — the caller must not treat it as an internal error.',
      'All contention concentrates on one row, which is the intended behaviour.',
    ],
  },
  pessimistic: {
    id: 'pessimistic',
    label: 'Safe B — pessimistic locking',
    summary: 'Lock the inventory row first, validate in the application, then write.',
    sql: `SELECT available, reserved, sold, version
            FROM inventory
           WHERE tier_id = $1
              FOR UPDATE;
    -- validate available >= quantity, then:
    UPDATE inventory
       SET available = available - $2, reserved = reserved + $2, version = version + 1
     WHERE tier_id = $1;`,
    safe: true,
    labOnly: false,
    tradeoffs: [
      'Useful when validation needs a stable snapshot of several columns.',
      'Holds the row lock across the whole check-then-write window, so lock waits are expected.',
      'Must always lock in a consistent order if extended to multiple tiers.',
    ],
  },
  optimistic: {
    id: 'optimistic',
    label: 'Safe C — optimistic version check',
    summary: 'Read the version, write only if it is unchanged, retry conflicts with bounded jitter.',
    sql: `-- attempt n:
    UPDATE inventory
       SET available = available - $2, reserved = reserved + $2, version = version + 1
     WHERE tier_id = $1 AND version = $3 AND available >= $2;
    -- zero rows: re-read and retry (conflict) unless available < quantity (sold out)`,
    safe: true,
    labOnly: false,
    tradeoffs: [
      'Distinguishes conflict (retry) from sold out (stop) — conflating them hides bugs.',
      'Retry amplification under heavy contention; the experiment measures it.',
      'More round trips than Safe A for a single hot row.',
    ],
  },
  unsafe_lab: {
    id: 'unsafe_lab',
    label: 'Unsafe baseline — unlocked read-modify-write (LAB ONLY)',
    summary:
      'Reads counters without a lock, sleeps inside the read-modify-write window, then writes blindly. Demonstrates lost updates.',
    sql: `-- 1. unlocked read
    SELECT available, reserved, capacity FROM inventory WHERE tier_id = $1;
    -- 2. artificial delay (pg_sleep) — models network/slow code inside the window
    -- 3. blind write of computed values (NO guard, NO version check)
    UPDATE inventory SET available = $read_available - $qty, reserved = $read_reserved + $qty
     WHERE tier_id = $1;`,
    safe: false,
    labOnly: true,
    tradeoffs: [
      'Writes only to the isolated `lab` schema fixture (ADR-0009).',
      'Expected anomaly: over-allocation detected by invariant I3, sometimes a CHECK violation.',
      'Never available outside local/test deployments, and never against public inventory.',
    ],
  },
};

export function listStrategies(includeLabOnly: boolean): StrategyDescriptorDto[] {
  const all = Object.values(STRATEGY_descriptors);
  return includeLabOnly ? all : all.filter((descriptor) => !descriptor.labOnly);
}

export function isSafeStrategy(strategy: StrategyId): boolean {
  return STRATEGY_descriptors[strategy].safe;
}

export function isLabOnlyStrategy(strategy: StrategyId): boolean {
  return STRATEGY_descriptors[strategy].labOnly;
}
