'use client';

import { useState } from 'react';
import { browserApi, isApiCallError } from '../lib/api';

/**
 * Calls the documented fixture reset and reports the server's answer verbatim — including the
 * post-reset invariant-violation count, which must be 0 on a fresh fixture. If it is not, the
 * button says so instead of pretending the reset "fixed" something.
 */
export function FixtureResetButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();

  async function reset() {
    setBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const res = await browserApi<{ data: { capacity: number; tiers: number; invariantViolations: number } }>(
        '/api/v1/lab/fixtures/reset',
        { method: 'POST', body: { capacity: 100, tiers: 1 } },
      );
      setResult(
        `Fixture reset: capacity ${res.data.capacity}, ${res.data.tiers} tier(s), invariant violations now ${res.data.invariantViolations}.`,
      );
    } catch (err) {
      setError(isApiCallError(err) ? `${err.code}: ${err.message}` : 'The reset request could not be delivered.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <button
        type="button"
        onClick={() => void reset()}
        disabled={busy}
        className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
      >
        {busy ? 'Resetting…' : 'Reset fixture (100 seats × 1 tier)'}
      </button>
      {result !== undefined && (
        <p role="status" aria-live="polite" className="text-sm text-green-900">
          {result}
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className="text-sm text-red-800">
          {error}
        </p>
      )}
    </div>
  );
}
