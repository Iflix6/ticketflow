import type { ReactNode } from 'react';
import { isApiCallError } from '../lib/api';
import { RetryButton } from './RetryButton';
import { IconAlert, IconInbox } from './icons';

/**
 * One error panel for every page. It renders what the API actually said — but phrased for a human
 * first and with the machine code kept as a small, secondary line, because "something went wrong"
 * pages hide bugs while raw `code: message` dumps intimidate people who can still act on the fix.
 * The API-down hint is derived from the failure class (TypeError = fetch never connected), not from
 * a guess, and every panel offers an honest retry (re-runs the server fetch) rather than a fake
 * recovery. Kept a Server Component; only <RetryButton/> crosses to the client.
 */

interface ErrorView {
  heading: string;
  detail: string;
  hint?: string;
  code?: string;
  retryLabel: string;
}

function describe(error: unknown): ErrorView {
  if (isApiCallError(error)) {
    const serverSide = error.status >= 500;
    return {
      heading: serverSide ? 'The API hit an internal error' : 'The API rejected the request',
      detail: error.message,
      code: `${error.code} · HTTP ${error.status}`,
      retryLabel: 'Try again',
    };
  }
  if (error instanceof TypeError) {
    return {
      heading: "Can't reach the API",
      detail: 'The web app could not open a connection to the API.',
      hint: 'Start it with `npm run dev:api` (PostgreSQL must be up: `npm run db:up`).',
      retryLabel: 'Retry connection',
    };
  }
  if (error instanceof Error) {
    return { heading: 'Something went wrong', detail: error.message, retryLabel: 'Try again' };
  }
  return { heading: 'Something went wrong', detail: 'Unknown failure', retryLabel: 'Try again' };
}

export function ErrorPanel({ error }: { error: unknown }) {
  const v = describe(error);
  return (
    <div role="alert" className="overflow-hidden rounded-xl2 border border-danger/30 bg-panel shadow-1">
      <div className="flex gap-4 p-5">
        <span
          aria-hidden
          className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-danger/10 text-danger ring-1 ring-danger/25"
        >
          <IconAlert className="size-5" />
        </span>
        <div className="min-w-0 space-y-1">
          <p className="font-semibold text-ink">{v.heading}</p>
          <p className="text-sm text-muted">{v.detail}</p>
          {v.hint !== undefined && <p className="font-mono text-xs text-muted">{v.hint}</p>}
          {v.code !== undefined && <p className="font-mono text-[11px] text-muted/80">{v.code}</p>}
          <div className="pt-2.5">
            <RetryButton label={v.retryLabel} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Empty state: the calm counterpart to the error panel. A dashed surface with a soft icon badge so a
 * "nothing here yet" screen reads as intentional, not broken. `children` carries the honest guidance
 * (e.g. "run `npm run seed`"); the icon is overridable per context but defaults to a neutral inbox.
 */
export function EmptyState({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl2 border border-dashed border-edge bg-elevated/40 px-6 py-12 text-center">
      <span aria-hidden className="grid h-11 w-11 place-items-center rounded-full bg-panel text-muted ring-1 ring-edge">
        {icon ?? <IconInbox className="size-5" />}
      </span>
      <div className="max-w-prose text-sm text-muted">{children}</div>
    </div>
  );
}
