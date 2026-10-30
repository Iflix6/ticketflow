import { trace, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { AppConfig } from '@ticketflow/config';
import type pino from 'pino';

/**
 * Worker tracing bootstrap (mirrors the API's `observability/tracing.ts`, deliberately leaner).
 *
 * The worker has no HTTP server worth tracing (its `/metrics` scrape endpoint would only add noise) and
 * no stable core BullMQ instrumentation to lean on. So it auto-instruments `pg` — every relay, sweeper,
 * and consumer query becomes a real DB span — and adds MANUAL spans at the four domain loops (relay,
 * expiry, reconcile, consume) that the spec calls out as the "workers and outbox" trace surface.
 *
 * OFF unless `OTEL_ENABLED=true`, so the integration tests (which import these modules directly, never
 * through `main.ts`) and any local run without a collector are unaffected.
 */

let activeProvider: NodeTracerProvider | undefined;

function tracesUrl(endpoint: string | undefined): string {
  const base = (endpoint ?? 'http://127.0.0.1:4318').replace(/\/+$/, '');
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

export async function startTracing(config: AppConfig, log: pino.Logger, serviceName: string): Promise<boolean> {
  if (!config.OTEL_ENABLED) return false;
  try {
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: '0.1.0',
      'deployment.environment': config.NODE_ENV,
      ...(config.GIT_SHA ? { 'service.instance.id': config.GIT_SHA } : {}),
    });
    const provider = new NodeTracerProvider({ resource });
    provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl(config.OTEL_EXPORTER_OTLP_ENDPOINT) })));
    provider.register({ contextManager: new AsyncLocalStorageContextManager() });
    registerInstrumentations({ tracerProvider: provider, instrumentations: [new PgInstrumentation()] });
    activeProvider = provider;
    log.info({ endpoint: tracesUrl(config.OTEL_EXPORTER_OTLP_ENDPOINT), service: serviceName }, 'otel tracing enabled');
    return true;
  } catch (error) {
    // Observability must never outrank correctness: an unreachable collector cannot stop the worker.
    log.error({ err: error }, 'failed to start otel tracing; continuing untraced');
    return false;
  }
}

export async function shutdownTracing(): Promise<void> {
  const provider = activeProvider;
  if (provider === undefined) return;
  activeProvider = undefined;
  try {
    await provider.shutdown();
  } catch {
    // Never change the exit code for a collector that cannot be reached during shutdown.
  }
}

export function domainTracer(): Tracer {
  return trace.getTracer('ticketflow.domain', '0.1.0');
}
