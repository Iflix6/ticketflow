import { createServer, type Server } from 'node:http';
import { workerMetrics } from './metrics.js';

/**
 * A minimal Prometheus scrape endpoint for the worker.
 *
 * The worker runs no business HTTP server by design (it is a poller, not an API). But its metrics are
 * only useful if something can scrape them, and standing up a full framework for one text endpoint would
 * be overkill — this is `node:http` with exactly two routes: `/metrics` (Prometheus text) and
 * `/health/live` (a liveness probe the container healthcheck and the supervisor can hit). Everything
 * else 404s. No auth, because it binds to loopback in compose and exposes only aggregate counters — the
 * same threat model as the API's `/metrics` (never publish these ports to the internet).
 */
export function startMetricsServer(port: number, host = '127.0.0.1'): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (path === '/metrics') {
      void workerMetrics
        .metricsText()
        .then((text) => {
          res.writeHead(200, { 'content-type': workerMetrics.contentType() });
          res.end(text);
        })
        .catch((error: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`metrics render failed: ${error instanceof Error ? error.message : String(error)}\n`);
        });
      return;
    }
    if (path === '/health/live') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"status":"live"}\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  // Keep the process alive only for real work: the timer-free HTTP server is unref'd by the caller if
  // needed, but here it SHOULD hold the loop open — a worker whose metrics endpoint died is unhealthy.
  server.listen(port, host);
  return server;
}
