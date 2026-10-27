import pg from 'pg';
import { bootstrapConfig } from '@ticketflow/config';
import { hashPassword } from '../apps/api/src/modules/auth/credentials.js';

/**
 * Seed and experiment-fixture script.
 *
 *   npm run seed                    # demo catalog + local demo accounts
 *   npm run seed -- --experiment    # reset + flagship fixture: one tier, capacity 100
 *   npm run seed -- --reset         # wipe transactional data, keep accounts
 *
 * Rules this file keeps:
 * - every seeded value is synthetic; no real emails (`.test` TLD only), no real money semantics;
 * - inventory rows are created with `available = capacity` through SQL so the CHECK constraints
 *   are exercised rather than bypassed (a constraint-violating seed is a schema bug, not noise);
 * - the lab fixture lives in the isolated `lab` schema only (ADR-0009);
 * - passwords here are LOCAL DEMO values, printed on purpose; production has no seed accounts.
 */

const DEMO_EVENT = {
  slug: 'midnight-metro-festival',
  title: 'Midnight Metro Festival',
  description: 'Synthetic headline act used by the catalog, booking flows and the 1,000-vs-100 experiment.',
  // Fixed calendar anchor: deterministic across reseeds so experiment reports remain comparable.
  startAt: '2027-06-12T00:00:00Z',
  tiers: [
    { name: 'GA Lawn', price: '49.00', capacity: 5000 },
    { name: 'Reserved Seats', price: '89.50', capacity: 1200 },
    { name: 'Backstage Pass', price: '210.00', capacity: 100 },
  ],
};

const EXPERIMENT_EVENT = {
  slug: 'lab-flagship-1000-vs-100',
  title: 'Lab Fixture — 1,000 Buyers vs 100 Tickets',
  description: 'Isolated fixture for comparative strategy experiments. One tier, capacity 100, one ticket per buyer.',
  startAt: '2027-01-01T00:00:00Z',
  tier: { name: 'Single Seat', price: '25.00', capacity: 100 },
};

// Local demo accounts only. The admin password can be overridden; the customer password is a
// deliberately weak documented local value because these accounts guard synthetic data on 127.0.0.1.
const DEMO_CUSTOMER_PASSWORD = process.env.TF_SEED_CUSTOMER_PASSWORD ?? 'local-demo-customer-2026';
const DEMO_ADMIN_PASSWORD = process.env.TF_SEED_ADMIN_PASSWORD ?? 'local-demo-admin-2026';

type Pool = pg.Pool;

async function upsertUser(pool: Pool, email: string, role: 'CUSTOMER' | 'LAB_ADMIN', password: string, displayName: string): Promise<void> {
  const hash = await hashPassword(password);
  await pool.query(
    `INSERT INTO app_users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (lower(email)) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            display_name  = EXCLUDED.display_name,
            role          = EXCLUDED.role,
            updated_at    = app.now()`,
    [email, hash, displayName, role],
  );
}

async function upsertEvent(
  pool: Pool,
  event: { slug: string; title: string; description: string; startAt: string },
  status: 'DRAFT' | 'ON_SALE',
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO events (slug, title, description, start_at, status)
     VALUES ($1, $2, $3, $4::timestamptz, $5)
     ON CONFLICT (slug) DO UPDATE
        SET title = EXCLUDED.title, description = EXCLUDED.description, updated_at = app.now()
     RETURNING id`,
    [event.slug, event.title, event.description, event.startAt, status],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error(`failed to upsert event ${event.slug}`);
  return id;
}

async function upsertTierWithInventory(
  pool: Pool,
  eventId: string,
  tier: { name: string; price: string; capacity: number },
): Promise<void> {
  // Tier and counters in one statement chain; ON CONFLICT resets counters only when nothing has
  // been sold yet, so seeding never silently wipes live reservation state.
  await pool.query(
    `INSERT INTO ticket_tiers (event_id, name, price_display_only, currency, capacity)
     VALUES ($1, $2, $3::numeric, 'USD', $4)
     ON CONFLICT (event_id, name) DO UPDATE
        SET price_display_only = EXCLUDED.price_display_only,
            capacity           = EXCLUDED.capacity,
            updated_at         = app.now()`,
    [eventId, tier.name, tier.price, tier.capacity],
  );

  await pool.query(
    `INSERT INTO inventory (tier_id, capacity, available, reserved, sold, version)
     SELECT t.id, t.capacity, t.capacity, 0, 0, 0
       FROM ticket_tiers t
      WHERE t.event_id = $1 AND t.name = $2
     ON CONFLICT (tier_id) DO UPDATE
        SET capacity  = CASE WHEN inventory.reserved = 0 AND inventory.sold = 0 THEN EXCLUDED.capacity ELSE inventory.capacity END,
            -- Reset counters only at quiescence (nothing reserved/sold); live data is never clobbered.
            available = CASE WHEN inventory.reserved = 0 AND inventory.sold = 0 THEN EXCLUDED.capacity ELSE inventory.available END,
            version   = CASE WHEN inventory.reserved = 0 AND inventory.sold = 0 THEN 0 ELSE inventory.version END,
            updated_at = app.now()`,
    [eventId, tier.name],
  );
}

async function resetTransactionalData(pool: Pool): Promise<void> {
  // Order matters only for readability; everything cascades from the parent rows anyway.
  await pool.query(`
    DELETE FROM payment_attempts;
    DELETE FROM bookings;
    DELETE FROM reservations;
    DELETE FROM idempotency_records;
    DELETE FROM outbox_events;
    DELETE FROM audit_records;
    DELETE FROM consumed_events;
    DELETE FROM experiment_results;
    DELETE FROM reconciliation_findings;
    DELETE FROM experiment_runs;
    DELETE FROM sessions;
  `);
  console.log('transactional data cleared (accounts and catalog retained)');
}

async function resetLabFixture(pool: Pool, capacity: number): Promise<void> {
  // The same SQL function the Phase-3 lab endpoint and integration tests call, so "same seed"
  // provably means "same rows" everywhere (deterministic tier ids derived from the seed).
  await pool.query('SELECT lab.reset_fixture($1, $2, $3)', [42, capacity, 1]);
  console.log(`lab fixture reset: seed=42, single tier with capacity ${capacity}`);
}

async function main(): Promise<void> {
  const config = bootstrapConfig();
  const args = process.argv.slice(2);
  const doReset = args.includes('--reset');
  const doExperiment = args.includes('--experiment');

  const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 2 });
  try {
    await pool.query('BEGIN');
    if (doReset) await resetTransactionalData(pool);

    const demoEventId = await upsertEvent(pool, DEMO_EVENT, 'ON_SALE');
    for (const tier of DEMO_EVENT.tiers) await upsertTierWithInventory(pool, demoEventId, tier);

    if (doExperiment) {
      const experimentEventId = await upsertEvent(pool, EXPERIMENT_EVENT, 'ON_SALE');
      await upsertTierWithInventory(pool, experimentEventId, EXPERIMENT_EVENT.tier);
      await resetLabFixture(pool, EXPERIMENT_EVENT.tier.capacity);
    }

    await upsertUser(pool, 'customer@local.test', 'CUSTOMER', DEMO_CUSTOMER_PASSWORD, 'Local Customer');
    await upsertUser(pool, config.LAB_ADMIN_EMAIL, 'LAB_ADMIN', DEMO_ADMIN_PASSWORD, 'Lab Administrator');
    for (let i = 1; i <= 5; i += 1) {
      await upsertUser(pool, `buyer${i}@local.test`, 'CUSTOMER', DEMO_CUSTOMER_PASSWORD, `Local Buyer ${i}`);
    }

    await pool.query('COMMIT');

    const counts = await pool.query<{ events: string; tiers: string; users: string }>(
      `SELECT
         (SELECT COUNT(*)::text FROM events)      AS events,
         (SELECT COUNT(*)::text FROM ticket_tiers) AS tiers,
         (SELECT COUNT(*)::text FROM app_users)    AS users`,
    );
    const c = counts.rows[0];
    console.log(`seed complete — events=${c?.events} tiers=${c?.tiers} users=${c?.users}`);
    console.log('local demo accounts (documented, local-only — never production):');
    console.log(`  customer@local.test / ${DEMO_CUSTOMER_PASSWORD}`);
    console.log(`  ${config.LAB_ADMIN_EMAIL} / ${DEMO_ADMIN_PASSWORD}  (LAB_ADMIN)`);
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error('[seed]', error instanceof Error ? error.message : error);
  process.exit(1);
});
