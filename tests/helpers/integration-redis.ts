import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRedisProbe } from '../../apps/api/src/redis-probe.js';

/**
 * Redis availability for the worker recovery suite (mirrors `databaseAvailable()` in spirit):
 * when Redis is absent the suite SKIPS with an honest message instead of faking green. The URL is
 * resolved the same way the DB URL is — env first, then `.env` — and liveness is answered by the
 * API's own dependency-free TCP probe, which also keeps that production helper under real test.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function dotenvValue(key: string): string | undefined {
  const envFile = path.join(root, '.env');
  if (!existsSync(envFile)) return undefined;
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match?.[1] === key) return match[2]?.replace(/^["']|["']$/g, '');
  }
  return undefined;
}

export function redisUrl(): string {
  const url = process.env['REDIS_URL'] ?? dotenvValue('REDIS_URL') ?? 'redis://127.0.0.1:6379';
  return url;
}

export async function redisAvailable(): Promise<boolean> {
  return makeRedisProbe(redisUrl())().catch(() => false);
}
