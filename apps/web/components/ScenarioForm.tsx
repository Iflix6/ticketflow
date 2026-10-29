'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { createLabRunRequestSchema } from '@ticketflow/contracts';
import { browserApi, isApiCallError } from '../lib/api';
import type { LabRunDto, StrategyDescriptorDto } from '../lib/types';

/**
 * Scenario builder. Client validation uses the very zod schema the API enforces (imported from
 * @ticketflow/contracts, not copied), so a field the browser accepts can never be a field the
 * server would reject; the server remains the authority and its error is shown if it ever differs.
 * Submit stays busy for the WHOLE run — POST /lab/runs only answers when the experiment is over —
 * and navigation happens on the response, never before it ("no misleading success").
 */

const FIELDS = [
  { key: 'capacity', label: 'Ticket capacity', hint: 'seats in the fixture tier (1–100,000)' },
  { key: 'concurrentUsers', label: 'Concurrent buyers', hint: 'parallel attempts (1–5,000) — the headline scenario is 1,000 vs 100' },
  { key: 'quantityPerUser', label: 'Seats per buyer', hint: '1–100' },
  { key: 'rampMs', label: 'Ramp window (ms)', hint: '0 = barrier start: every request fires together' },
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

export function ScenarioForm({ strategies }: { strategies: StrategyDescriptorDto[] }) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string | number>>({ ...DEFAULTS });
  const [strategy, setStrategy] = useState<string>(strategies[0]?.id ?? 'atomic_update');
  const [busy, setBusy] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [serverError, setServerError] = useState<string | undefined>();
  const [launchNote, setLaunchNote] = useState<string | undefined>();

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

  return (
    <form onSubmit={submit} className="max-w-2xl space-y-4 rounded-lg border border-slate-200 bg-white p-5">
      <fieldset disabled={busy} className="space-y-4">
        <div>
          <label htmlFor="strategy" className="block text-sm font-medium">
            Allocation strategy
          </label>
          <select
            id="strategy"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
            className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
          >
            {strategies.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} — {s.safe ? 'safe' : 'UNSAFE (lab only)'}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-slate-500">
            {strategies.find((s) => s.id === strategy)?.summary ?? 'Pick a strategy to read its summary.'}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {FIELDS.map((f) => (
            <div key={f.key}>
              <label htmlFor={f.key} className="block text-sm font-medium">
                {f.label}
              </label>
              <input
                id={f.key}
                type="number"
                inputMode="numeric"
                value={values[f.key]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
              />
              <p className="mt-0.5 text-xs text-slate-500">{f.hint}</p>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label htmlFor="isolation" className="block text-sm font-medium">
              Transaction isolation
            </label>
            <select
              id="isolation"
              value={values.isolation}
              onChange={(e) => setValues((v) => ({ ...v, isolation: e.target.value }))}
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            >
              <option value="read_committed">read_committed</option>
              <option value="repeatable_read">repeatable_read</option>
              <option value="serializable">serializable</option>
            </select>
          </div>
          <div>
            <label htmlFor="label" className="block text-sm font-medium">
              Label (optional, ≤120 chars)
            </label>
            <input
              id="label"
              type="text"
              maxLength={120}
              value={values.label}
              onChange={(e) => setValues((v) => ({ ...v, label: e.target.value }))}
              placeholder="e.g. oversell demo, 25ms window"
              className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5"
            />
          </div>
        </div>

        {validationErrors.length > 0 && (
          <div role="alert" className="rounded bg-amber-50 p-3 text-sm text-amber-900">
            <p className="font-semibold">Configuration rejected before sending (schema-bound):</p>
            <ul className="mt-1 list-inside list-disc">
              {validationErrors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          </div>
        )}
        {serverError !== undefined && (
          <div role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">
            {serverError}
          </div>
        )}
        {launchNote !== undefined && (
          <p role="status" aria-live="polite" className="rounded bg-blue-50 p-3 text-sm text-blue-900">
            {launchNote}
          </p>
        )}

        <button type="submit" className="rounded bg-green-700 px-4 py-2 text-sm text-white hover:bg-green-800 disabled:opacity-50">
          {busy ? 'Run in flight…' : 'Launch run'}
        </button>
      </fieldset>
    </form>
  );
}
