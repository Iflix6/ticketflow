import { isApiCallError } from '../lib/api';

/**
 * One error panel for every page. It renders what the API actually said (code + message +
 * request id when present) because "something went wrong" pages hide bugs. The API-down hint is
 * derived from the failure class (TypeError = fetch never connected), not from a guess.
 */
export function ErrorPanel({ error }: { error: unknown }) {
  let title = 'The API reported an error';
  let detail = 'Unknown failure';
  let hint: string | undefined;

  if (isApiCallError(error)) {
    title = `${error.code} (HTTP ${error.status})`;
    detail = error.message;
  } else if (error instanceof TypeError) {
    title = 'API not reachable';
    detail = String(error.message);
    hint = 'Start it with `npm run dev:api` (PostgreSQL must be up: `npm run db:up`).';
  } else if (error instanceof Error) {
    detail = error.message;
  }

  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 p-4 text-sm">
      <p className="font-semibold text-red-800">{title}</p>
      <p className="mt-1 text-red-700">{detail}</p>
      {hint !== undefined && <p className="mt-1 text-red-600">{hint}</p>}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">{children}</p>;
}
