'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import gsap from 'gsap';
import { browserApi, isApiCallError } from '../lib/api';
import { buttonClass } from './ui';

/**
 * Calls the documented fixture reset and reports the server's answer verbatim — including the
 * post-reset invariant-violation count, which must be 0 on a fresh fixture. If it is not, the
 * button says so instead of pretending the reset "fixed" something. The result/alert line is
 * revealed with a short GSAP motion (skipped under reduced-motion); the copy itself is unchanged.
 */
export function FixtureResetButton() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const statusRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (result === undefined && error === undefined) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches || statusRef.current === null) return;
    const ctx = gsap.context(() => {
      gsap.from(statusRef.current, { autoAlpha: 0, y: 6, duration: 0.3, ease: 'power2.out' });
    }, statusRef);
    return () => ctx.revert();
  }, [result, error]);

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
    <div className="mt-3 space-y-2">
      <button type="button" onClick={() => void reset()} disabled={busy} className={buttonClass('outline', 'sm')}>
        {busy ? 'Resetting…' : 'Reset fixture (100 seats × 1 tier)'}
      </button>
      {(result !== undefined || error !== undefined) && (
        <div ref={statusRef}>
          {result !== undefined && <p role="status" aria-live="polite" className="text-sm text-ok">{result}</p>}
          {error !== undefined && <p role="alert" className="text-sm text-danger">{error}</p>}
        </div>
      )}
    </div>
  );
}
