'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { buttonClass } from './ui';
import { IconRefresh } from './icons';

/**
 * Retry affordance for the error panel. Every TicketFlow page is `force-dynamic` and fetches from
 * the API on the server, so the honest recovery action is to re-run that server render — `router.refresh()`
 * re-requests the current route's Server Components (and their API calls), which is exactly what a
 * transient "API not reachable" or a 5xx needs. It never fabricates success: if the API still answers
 * with an error, the panel simply re-renders with that error again.
 */
export function RetryButton({ label = 'Try again' }: { label?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function retry() {
    if (busy) return;
    setBusy(true);
    try {
      await router.refresh();
    } finally {
      // Keep the spinner up briefly even if refresh resolves instantly, so the click always feels heard.
      window.setTimeout(() => setBusy(false), 400);
    }
  }

  return (
    <button type="button" onClick={() => void retry()} disabled={busy} className={buttonClass('outline', 'sm')}>
      <IconRefresh className={busy ? 'animate-spin' : ''} />
      {busy ? 'Retrying…' : label}
    </button>
  );
}
