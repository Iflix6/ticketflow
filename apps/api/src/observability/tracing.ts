import { trace, type Tracer } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { Resource } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { AppConfig } from '@ticketflow/config';
import type { Logger } from './logger.js';

/**
 * OpenTelemetry tracing bootstrap (Phase 6/7).
 *
 * Design constraints that shaped this file:
 * - It is OFF unless `OTEL_ENABLED=true`. Every test, the boot-smoke gate, and a default local run
 *   therefore run with tracing disabled, where the `@opentelemetry/api` no-op `Tracer` makes manual
 *   `startSpan` calls cost effectively nothing. This is why enabling tracing can never turn `verify` red.
 * - There is NO dependency on a `--loader`/`--import` flag: this project ships plain ESM
 *   (`node dist/server.js`). Auto-instrumentation of `http`/`express`/`pg` only patches those modules
 *   if they are loaded AFTER the provider is registered, so the process entry points must call
 *   {@link startTracing} first and only then `import()` the app graph (see `server.ts` / worker `main.ts`).
 * - Registration is fully defensive: a bad exporter endpoint or a missing collector must NEVER prevent
 *   the booking service from booting. Failures are logged and the process continues untraced.
 *
 * The lean, justifiable package set (spec: "prefer minimal libraries"): HTTP transport (server +
 * outbound client spans), Express (route spans), and `pg` (one DB span per query with the parameterized
 * statement, never the values). Worker/outbox/reservation spans are added MANUALLY at the domain
 * boundaries, because there is no stable core BullMQ instrumentation to rely on — see `otel-spans`.
 */

// A minimal allow-list so an unreachable collector cannot make shutdown hang or buffer unboundedly.
const SPAN_LIMITS = { attributeValueLengthLimit: 512 } as const;

let activeProvider: NodeTracerProvider | undefined;

/** Builds the OTLP/HTTP traces URL from a bare endpoint (mirrors the collector's 4318 http receiver). */
function tracesUrl(endpoint: string | undefined): string {
  const base = (endpoint ?? 'http://127.0.0.1:4318').replace(/\/+$/, '');
  // Accept either a bare host:port or an already-complete /v1/traces URL.
  return base.endsWith('/v1/traces') ? base : `${base}/v1/traces`;
}

/**
 * Registers the tracer provider + auto-instrumentations when enabled. Safe to call once at process
 * start, before the app modules load. Returns whether tracing is active so the entry point can log it.
 */
export async function startTracing(config: AppConfig, logger: Logger, serviceName: string): Promise<boolean> {
  if (!config.OTEL_ENABLED) return false;

  try {
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: '0.1.0',
      'deployment.environment': config.NODE_ENV,
      ...(config.GIT_SHA ? { 'service.instance.id': config.GIT_SHA } : {}),
    });

    const provider = new NodeTracerProvider({ resource, spanLimits: SPAN_LIMITS });
    provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter({ url: tracesUrl(config.OTEL_EXPORTER_OTLP_ENDPOINT) })));

    // AsyncLocalStorage context manager keeps spans correlated across the awaits a booking performs.
    provider.register({ contextManager: new AsyncLocalStorageContextManager() });
    registerInstrumentations({
      tracerProvider: provider,
      instrumentations: [
        // HTTP transport spans (server + outbound client). Instrumentation defaults already redact bound
        // values; adding per-instrumentation allow-lists here only risks drifting from the pinned API.
        new HttpInstrumentation(),
        new ExpressInstrumentation(),
        new PgInstrumentation(),
      ],
    });

    activeProvider = provider;
    logger.info({ endpoint: tracesUrl(config.OTEL_EXPORTER_OTLP_ENDPOINT), service: serviceName }, 'otel tracing enabled');
    return true;
  } catch (error) {
    // Tracing is observability, not correctness: never let it stop the process from serving traffic.
    logger.error({ err: error }, 'failed to start otel tracing; continuing untraced');
    return false;
  }
}

/** Flushes any batched spans on graceful shutdown so the tail of a drained request is not lost. */
export async function shutdownTracing(): Promise<void> {
  const provider = activeProvider;
  if (provider === undefined) return;
  activeProvider = undefined;
  try {
    await provider.shutdown();
  } catch {
    // A collector that is unreachable at shutdown time must not change the process exit code.
  }
}

/** The tracer manual domain spans use. Returns a no-op tracer when tracing was never registered. */
export function domainTracer(): Tracer {
  return trace.getTracer('ticketflow.domain', '0.1.0');
}
