'use client';

import { useRouter } from 'next/navigation';
import { useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { createLabRunRequestSchema } from '@ticketflow/contracts';
import { browserApi, isApiCallError } from '../lib/api';
import type { LabRunDto, StrategyDescriptorDto } from '../lib/types';
import { LiveProgress } from './LiveProgress';
import { buttonClass, Callout, SectionLabel } from './ui';

/**
 * Scenario builder. Client validation uses the very zod schema the API enforces (imported from
 * @ticketflow/contracts, not copied), so a field the browser accepts can never be a field the
 * server would reject; the server remains the authority and its error is shown if it ever differs.
 * Submit stays busy for the WHOLE run — POST /lab/runs only answers when the experiment is over —
 * and navigation happens on the response, never before it ("no misleading success"). The card and its
 * field groups reveal in on mount via GSAP (reduced-motion safe); layout is the only thing animated —
 * every default, bound value, and validation path is exactly as before.
 */

const LOAD_FIELDS = [
  { key: 'capacity', label: 'Ticket capacity', hint: 'seats in the fixture tier (1–100,000)' },
  { key: 'concurrentUsers', label: 'Concurrent buyers', hint: 'parallel attempts (1–5,000) — the headline scenario is 1,000 vs 100' },
  { key: 'quantityPerUser', label: 'Seats per buyer', hint: '1–100' },
  { key: 'rampMs', label: 'Ramp window (ms)', hint: '0 = barrier start: every request fires together' },
] as const;

const TIMING_FIELDS = [
  { key: 'artificialDelayMs', label: 'Unsafe-window delay (ms)', hint: '0–5,000; widens the unsafe_lab read-modify-write window' },
  { key: 'reservationTtlSeconds', label: 'Reservation TTL (s)', hint: '5–86,400' },
  { key: 'seed', label: 'RNG seed', hint: 'same seed + same config = comparable runs across strategies' },
  { key: 'dbPoolMax', label: 'DB pool max', hint: '1–200' },
] as const;

const DEFAULTS = {
  capacity: 100,
  concurrentUsers: 1000,
  quantityPerUser: 1,
  rampMs: 0,
  artificialDelayMs: 25,
  reservationTtlSeconds: 300,
  seed: 42,
  dbPoolMax: 20,
  isolation: 'read_committed',
  label: '',
};

const field =
  'mt-1 w-full rounded-lg border border-edge bg-app px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-brand focus:bg-panel';

export function ScenarioForm({ strategies }: { strategies: StrategyDescriptorDto[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string | number>>({ ...DEFAULTS });
  const [strategy, setStrategy] = useState<string>(strategies[0]?.id ?? 'atomic_update');
  const [busy, setBusy] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | undefined>();
  const [launchNote, setLaunchNote] = useState<string | undefined>();
  // Live (SSE) mode is an OPT-IN. Default OFF keeps the synchronous POST /lab/runs contract — and the e2e
  // suite that drives it — exactly as before; a curious operator can tick it to watch the tally stream in.
  const [live, setLive] = useState(false);
  const [liveRun, setLiveRun] = useState<{ id: string; total: number } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  useLayoutEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || formRef.current === null) return;
    const ctx = gsap.context(() => {
      gsap.from(formRef.current!.children, { autoAlpha: 0, y: 12, duration: 0.4, stagger: 0.06, ease: 'power2.out' });
    }, formRef);
    return () => ctx.revert();
  }, []);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setValidationErrors([]);
    setServerError(undefined);
    const configuration = {
      capacity: Number(values.capacity),
      concurrentUsers: Number(values.concurrentUsers),
      quantityPerUser: Number(values.quantityPerUser),
      rampMs: Number(values.rampMs),
      artificialDelayMs: Number(values.artificialDelayMs),
      reservationTtlSeconds: Number(values.reservationTtlSeconds),
      seed: Number(values.seed),
      dbPoolMax: Number(values.dbPoolMax),
      isolation: values.isolation,
    };
    const candidate = { strategy, configuration, ...(values.label !== '' ? { label: String(values.label) } : {}) };
    const parsed = createLabRunRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      setValidationErrors(parsed.error.issues.map((i) => `${i.path.join('.') || 'root'}: ${i.message}`));
      return;
    }
    setBusy(true);
    if (live) {
      // Asynchronous mode: 202 Accepted + the fresh PENDING run. The live panel then streams progress and
      // navigates to the authoritative summary the moment a terminal frame arrives. Success is still ONLY
      // claimed on a server response — here the 2xx that queues the run, and later its terminal frame.
      setLaunchNote('Live run queued — POST /lab/runs?mode=live answered; streaming progress from the server.');
      browserApi<{ data: LabRunDto }>('/api/v1/lab/runs?mode=live', { method: 'POST', body: parsed.data })
        .then((res) => {
          setLiveRun({ id: res.data.id, total: parsed.data.configuration.concurrentUsers });
        })
        .catch((err: unknown) => {
          setBusy(false);
          setLaunchNote(undefined);
          setServerError(isApiCallError(err) ? `${err.code}: ${err.message}` : 'The live run request could not be delivered.');
        });
      return;
    }
    setLaunchNote('Run in flight — POST /lab/runs answers only when the experiment has finished. Leave this page open.');
    browserApi<{ data: LabRunDto }>('/api/v1/lab/runs', { method: 'POST', body: parsed.data })
      .then((res) => {
        // Success is ONLY claimed here, on the server's 201 with the completed run document.
        setLaunchNote(undefined);
        router.push(`/lab/runs/${res.data.id}`);
      })
      .catch((err: unknown) => {
        setBusy(false);
        setLaunchNote(undefined);
        setServerError(isApiCallError(err) ? `${err.code}: ${err.message}` : 'The run request could not be delivered.');
      });
  }

  const renderField = (f: { key: string; label: string; hint: string }) => (
    <div key={f.key}>
      <label htmlFor={f.key} className="block text-sm font-medium text-ink">
        {f.label}
      </label>
      <input
        id={f.key}
        type="number"
        inputMode="numeric"
        value={values[f.key]}
        onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
        className={field}
      />
      <p className="mt-1 text-xs text-muted">{f.hint}</p>
    </div>
  );

  return (
    <form ref={formRef} onSubmit={submit} className="max-w-3xl space-y-5">
      <fieldset disabled={busy} className="space-y-5">
        <div className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
          <SectionLabel>Allocation strategy</SectionLabel>
          <label htmlFor="strategy" className="mt-3 block text-sm font-medium text-ink">
            Strategy under test
          </label>
          <select id="strategy" value={strategy} onChange={(e) => setStrategy(e.target.value)} className={field}>
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.safe ? 'safe' : 'UNSAFE (lab only)'}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs text-muted">
            {strategies.find((s) => s.id === strategy)?.summary ?? 'Pick a strategy to read its summary.'}
          </p>
        </div>

        <div className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
          <SectionLabel>Load shape</SectionLabel>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">{LOAD_FIELDS.map(renderField)}</div>
        </div>

        <div className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
          <SectionLabel>Timing &amp; determinism</SectionLabel>
          <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">{TIMING_FIELDS.map(renderField)}</div>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="isolation" className="block text-sm font-medium text-ink">
                Transaction isolation
              </label>
              <select
                id="isolation"
                value={values.isolation}
                onChange={(e) => setValues((v) => ({ ...v, isolation: e.target.value }))}
                className={field}
              >
                <option value="read_committed">read_committed</option>
                <option value="repeatable_read">repeatable_read</option>
                <option value="serializable">serializable</option>
              </select>
            </div>
            <div>
              <label htmlFor="label" className="block text-sm font-medium text-ink">
                Label (optional, ≤120 chars)
              </label>
              <input
                id="label"
                type="text"
                maxLength={120}
                value={values.label}
                onChange={(e) => setValues((v) => ({ ...v, label: e.target.value }))}
                placeholder="e.g. oversell demo, 25ms window"
                className={field}
              />
            </div>
          </div>
        </div>

        {validationErrors.length > 0 && (
          <div role="alert">
            <Callout tone="warn">
              <p className="font-semibold">Configuration rejected before sending (schema-bound):</p>
              <ul className="mt-1 list-inside list-disc">
                {validationErrors.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
            </Callout>
          </div>
        )}
        {serverError !== undefined && (
          <div role="alert">
            <Callout tone="danger">{serverError}</Callout>
          </div>
        )}
        {launchNote !== undefined && (
          <div role="status" aria-live="polite">
            <Callout tone="info">{launchNote}</Callout>
          </div>
        )}

        {liveRun !== null && (
          <div className="rounded-xl2 border border-edge bg-panel p-5 shadow-1">
            <LiveProgress runId={liveRun.id} total={liveRun.total} onDone={() => router.push(`/lab/runs/${liveRun.id}`)} />
          </div>
        )}

        <div className="flex items-center gap-3">
          <label htmlFor="live-mode" className="flex items-center gap-2 text-sm text-ink">
            <input
              id="live-mode"
              type="checkbox"
              checked={live}
              onChange={(e) => setLive(e.target.checked)}
              disabled={busy}
              className="h-4 w-4 rounded border-edge bg-app accent-brand"
            />
            Stream progress live (SSE)
          </label>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" className={busy ? buttonClass('outline') : buttonClass('success')}>
            {busy ? (
              <>
                <span aria-hidden className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Run in flight…
              </>
            ) : (
              'Launch run'
            )}
          </button>
          <p className="text-xs text-muted">Validation is bound to the same schema the API enforces.</p>
        </div>
      </fieldset>
    </form>
  );
}
