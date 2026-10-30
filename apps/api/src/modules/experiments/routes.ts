import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLabRunRequestSchema, fixtureResetRequestSchema, LAB_RUN_TERMINAL, pageQuerySchema } from '@ticketflow/contracts';
import type { LabRunDto, LabRunProgressEvent } from '@ticketflow/contracts';
import type { AppConfig } from '@ticketflow/config';
import { asyncHandler } from '../../middleware/request-context.js';
import { requireUser } from '../../middleware/authenticate.js';
import { sendJson } from '../../shared/respond.js';
import { parseBody, parseParams, parseQuery, uuidParamSchema } from '../../shared/validation.js';
import { buildPagination } from '../events/service.js';
import { listStrategies } from './strategies.js';
import { subscribeProgress } from './progress-bus.js';
import type { LabService } from './service.js';

/**
 * Engineering Lab routes (local/test only; the whole router is unmounted otherwise, and `labGate` +
 * `requireRole('LAB_ADMIN')` guard it even when mounted — ADR-0009).
 *
 * Phase 3 implements the full local experiment lifecycle: the strategy catalogue, run creation
 * (executed synchronously against the isolated `lab` fixture), run listing/detail/results, and fixture
 * reset. Handlers stay thin — parse, delegate to {@link LabService}, choose the status code.
 */

const resultsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(5000).default(500),
});

/**
 * `POST /lab/runs` execution mode. Absent/`sync` keeps the long-standing synchronous contract (the request
 * blocks until the run is COMPLETED and answers 201 with the full summary — what e2e and OpenAPI parity
 * depend on). `live` returns 202 immediately and streams progress over SSE, so the flagship demo can show a
 * moving tally without a second route (the operation count per method is unchanged, keeping the contract
 * guard's tally assertion exact).
 */
const createRunQuerySchema = z.object({ mode: z.enum(['sync', 'live']).default('sync') });

/** Statuses after which no further progress will arrive; the SSE stream closes on the first one seen.
 * Derived from the shared state-machine terminal set so the stream can never disagree with the run ladder. */
const TERMINAL_STATUSES: ReadonlySet<LabRunDto['status']> = new Set<LabRunDto['status']>(LAB_RUN_TERMINAL);

/** Safety cap on a single SSE connection. The background run continues past it; the client can reconnect. */
const MAX_STREAM_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;
const STATUS_POLL_MS = 1_000;

export function createLabRouter(service: LabService): Router {
  const router = Router();

  router.get('/strategies', (req, res) => {
    // `unsafe_lab` appears only when the lab is enabled at all, so a public deployment cannot even
    // discover that the unsafe strategy exists.
    sendJson(res, 200, { data: listStrategies((req.app.locals.config as AppConfig).LAB_ENABLED) }, req.id);
  });

  router.post(
    '/runs',
    asyncHandler(async (req, res) => {
      const user = requireUser(req);
      const { strategy, configuration, label } = parseBody(req, createLabRunRequestSchema);
      const { mode } = parseQuery(req, createRunQuerySchema);
      if (mode === 'live') {
        // 202 Accepted: the run is queued; the client follows the returned id on the progress stream.
        const run = await service.openRun(user, strategy, configuration, label ?? null);
        sendJson(res, 202, { data: run }, req.id);
        return;
      }
      const run = await service.createRun(user, strategy, configuration, label ?? null);
      sendJson(res, 201, { data: run }, req.id);
    }),
  );

  router.get(
    '/runs/:id/progress',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, uuidParamSchema);
      // Read BEFORE any streaming headers: a missing run must throw `not_found` into the error handler (404
      // JSON), which is impossible once we have written a 200 event-stream head. Doubles as the terminal check.
      const initial = await service.getRunById(id);

      openEventStream(req, res);
      const send = (event: LabRunProgressEvent): void => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      if (TERMINAL_STATUSES.has(initial.status)) {
        // Already finished (common in the parity test and in reconnects): one snapshot, then close.
        emitTerminal(send, id, initial);
        endStream(res);
        return;
      }

      let closed = false;
      let unsubscribe: () => void = () => undefined;
      const close = (): void => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(pollTimer);
        clearInterval(heartbeatTimer);
        clearTimeout(capTimer);
        endStream(res);
      };

      // Live frames: relay whatever the background run publishes; a terminal frame closes us immediately.
      unsubscribe = subscribeProgress(id, (event) => {
        if (closed) return;
        send(event);
        if (event.type === 'summary' || (event.type === 'phase' && TERMINAL_STATUSES.has(event.status as LabRunDto['status']))) {
          close();
        }
      });

      req.on('close', close);

      // Heartbeat comments keep intermediaries from idling a quiet stream (invisible to EventSource clients).
      const heartbeatTimer = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, HEARTBEAT_MS);

      // Fallback for the connect-after-terminal race: if we missed the bus frame, the DB status catches it.
      const pollTimer = setInterval(() => {
        if (closed) return;
        void service
          .getRunById(id)
          .then((run) => {
            if (closed) return;
            if (TERMINAL_STATUSES.has(run.status)) {
              emitTerminal(send, id, run);
              close();
            }
          })
          .catch(close);
      }, STATUS_POLL_MS);

      // Never hold a socket forever: cap the window; the run keeps going and the client may reconnect.
      const capTimer = setTimeout(() => {
        if (closed) return;
        res.write(': stream window elapsed; the run continues in the background\n\n');
        close();
      }, MAX_STREAM_MS);
    }),
  );

  router.get(
    '/runs',
    asyncHandler(async (req, res) => {
      const { page, pageSize } = parseQuery(req, pageQuerySchema);
      const { rows, total } = await service.listRuns(page, pageSize);
      sendJson(res, 200, { data: rows, pagination: buildPagination(page, pageSize, total) }, req.id);
    }),
  );

  router.get(
    '/runs/:id',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, uuidParamSchema);
      const run = await service.getRunById(id);
      sendJson(res, 200, { data: run }, req.id);
    }),
  );

  router.get(
    '/runs/:id/results',
    asyncHandler(async (req, res) => {
      const { id } = parseParams(req, uuidParamSchema);
      const { limit } = parseQuery(req, resultsQuerySchema);
      const results = await service.getRunResults(id, limit);
      sendJson(res, 200, { data: results }, req.id);
    }),
  );

  router.post(
    '/fixtures/reset',
    asyncHandler(async (req, res) => {
      // Authentication + LAB_ADMIN role are already enforced by the mount; the reset itself is idempotent.
      requireUser(req);
      const request = parseBody(req, fixtureResetRequestSchema);
      const result = await service.resetFixture(request);
      sendJson(res, 200, { data: result }, req.id);
    }),
  );

  return router;
}

/**
 * Switches a response into Server-Sent Events mode. No library: the wire format is three header lines and
 * `data: …\n\n` frames. `flushHeaders` sends the head immediately so the browser's `EventSource` opens
 * without waiting for a body, and `X-Accel-Buffering: no` asks nginx (and the Next dev proxy) not to buffer.
 */
function openEventStream(req: Request, res: Response): void {
  req.socket.setTimeout(0); // an SSE stream is intentionally long-lived; do not let the idle timer kill it
  req.socket.setNoDelay(true);
  req.socket.setKeepAlive(true);
  res.status(200);
  res.setHeader('content-type', 'text/event-stream; charset=utf-8');
  res.setHeader('cache-control', 'no-cache, no-transform');
  res.setHeader('connection', 'keep-alive');
  res.setHeader('x-accel-buffering', 'no');
  res.flushHeaders();
}

/** Writes the terminal frame: the immutable summary for a COMPLETED run, else a bare phase marker. */
function emitTerminal(send: (event: LabRunProgressEvent) => void, runId: string, run: LabRunDto): void {
  const at = new Date().toISOString();
  if (run.status === 'COMPLETED' && run.outcomes !== null) {
    send({ type: 'summary', phase: 'completed', runId, status: run.status, outcomes: run.outcomes, at });
    return;
  }
  const phase = run.status === 'FAILED' ? 'failed' : run.status === 'ABORTED' ? 'aborted' : 'completed';
  send({ type: 'phase', phase, runId, status: run.status, at });
}

/** Emits the `[DONE]` sentinel (mirrors the spec's stream-close convention) and ends the response. */
function endStream(res: Response): void {
  res.write('data: [DONE]\n\n');
  res.end();
}
