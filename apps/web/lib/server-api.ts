import 'server-only';
import { cookies } from 'next/headers';
import { toApiCallError } from './api';

/**
 * Server-side API access for Server Components: direct to API_BASE_URL with the visitor's Cookie
 * header forwarded verbatim, so `req.user` on the API is exactly who the browser proved it is.
 * No token is ever minted here; the session cookie IS the credential. Kept separate from the
 * browser helpers because `next/headers` must never enter a client-component module graph, and
 * `server-only` makes any accidental future import a build error rather than a runtime one.
 */

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

export interface ServerApiOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Extra headers (Idempotency-Key on mutations). */
  headers?: Record<string, string>;
  /** Secrets (the raw session token on rotate/logout) must never come from a page's props. */
  cookieOverride?: string;
}

export async function serverApi<T>(path: string, options: ServerApiOptions = {}): Promise<T> {
  const jar = await cookies();
  const forwarded = jar
    .getAll()
    .map((c) => `${c.name}=${encodeURIComponent(c.value)}`)
    .join('; ');
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  const cookie = options.cookieOverride ?? forwarded;
  if (cookie) headers.cookie = cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: 'no-store',
  });
  if (!res.ok) throw await toApiCallError(res);
  return (await res.json()) as T;
}

export { ApiCallError, isApiCallError } from './api';
