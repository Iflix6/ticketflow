import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Removes build output and generated artifacts (`npm run clean`).
 * Never touches volumes, node_modules or the database: `docker compose down -v` is an explicit,
 * operator-typed decision, not something a script should do on their behalf.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const targets = [
  'packages/config/dist',
  'packages/contracts/dist',
  'apps/api/dist',
  'apps/worker/dist',
  'coverage',
  'artifacts/experiments', // local run reports (never committed)
];

for (const target of targets) {
  const full = path.join(root, target);
  rmSync(full, { recursive: true, force: true });
  console.log(`removed ${target}`);
}
