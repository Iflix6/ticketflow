import net from 'node:net';

/**
 * A dependency-free liveness probe for Redis used by `/health/ready`.
 *
 * The API deliberately has no `ioredis`/`bullmq` dependency — those belong to the worker (ADR-0001).
 * Readiness only needs the honest answer to "can I open a TCP connection to Redis?", so we use Node's
 * own `net` and never couple the request path to the queue client. Redis is ADVISORY for readiness
 * (ADR-0002): the health router degrades rather than fails when this returns false.
 */
export function makeRedisProbe(redisUrl: string, timeoutMs = 1000): () => Promise<boolean> {
  const target = new URL(redisUrl);
  const host = target.hostname;
  const port = target.port === '' ? 6379 : Number(target.port);

  return (): Promise<boolean> =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const finish = (ok: boolean): void => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
    });
}
