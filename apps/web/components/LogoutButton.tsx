'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { browserApi } from '../lib/api';

/** Logout is honest about its outcome: the button only disappears once the server confirms. */
export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onClick() {
    setBusy(true);
    setFailed(false);
    try {
      await browserApi('/api/v1/auth/session/logout', { method: 'POST' });
      router.push('/');
      router.refresh();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="rounded-lg border border-edge px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-ink disabled:opacity-50"
      >
        {busy ? 'Signing out…' : 'Sign out'}
      </button>
      {failed && (
        <span role="status" className="text-xs text-danger">
          Sign-out failed; you are still signed in.
        </span>
      )}
    </span>
  );
}
