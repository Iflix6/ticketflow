import { cookies } from 'next/headers';
import type { ApiErrorBody } from './types';

/**
 * API access from the web app. Two transports, one contract:
 *
 * - Server Components call `serverApi` — direct to API_BASE_URL with the visitor's Cookie header
 *   forwarded verbatim, so `req.user` on the API is exactly who the browser proved it is. No token
 *   is ever minted here; the session cookie IS the credential.
 * - Client components call `browserApi` against `/api/v1/...`, which `next.config.ts` proxies to
 *   the API on the web app's own origin (first-party cookie; see the comment there).
 *
 * Failure philosophy: a non-2xx throws `ApiCallError` carrying the documented error envelope —
 * pages render the real `error.code`/`message` instead of inventing a fake success, which is the
 * pack's "no misleading success before server confirmation" rule expressed in code.
 */

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://127.0.0.1:4000';

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

async function toApiCallError(res: Response): Promise<ApiCallError> {
  let code = `http_${res.status}`;
  let message = res.statusText;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await res.json()) as ApiErrorBody;
    if (body.error !== undefined) {
      code = body.error.code;
      message = body.error.message;
      details = body.error.details;
    }
  } catch {
    // Non-JSON error body (proxy layer, etc.) — the status is still the truth we surface.
  }
  return new ApiCallError(res.status, code, message, details);
}

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

export async function browserApi<T>(path: string, options: ServerApiOptions = {}): Promise<T> {
  const res = await browserApiRaw<T>(path, options);
  return res.json;
}

/**
 * Same as `browserApi` but exposes the HTTP status: the checkout contract answers 201/200/202 with
 * DIFFERENT body types (booking vs booking vs still-pending reservation), and the UI must branch on
 * the status the server actually used — guessing from the body alone would be the dishonest kind of
 * "meaningful loading/error states" the spec forbids.
 */
export async function browserApiRaw<T>(
  path: string,
  options: ServerApiOptions = {},
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { accept: 'application/json', ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'same-origin',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  if (!res.ok) throw await toApiCallError(res);
  return { status: res.status, json: (await res.json()) as T };
}

export function isApiCallError(error: unknown): error is ApiCallError {
  return error instanceof ApiCallError;
}
