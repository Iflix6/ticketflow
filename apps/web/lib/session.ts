import { serverApi, isApiCallError } from './server-api';
import type { SessionUser } from './types';

/**
 * Server-side session read for pages and layouts. `undefined` means "not signed in" — 401 from
 * GET /auth/session — and nothing else swallows an API failure: a database outage must render as
 * an error, not as a signed-out page that tempts the user to "just log in again" forever.
 */
export async function getSessionUser(): Promise<SessionUser | undefined> {
  try {
    const res = await serverApi<{ user: SessionUser }>('/api/v1/auth/session');
    return res.user;
  } catch (error) {
    if (isApiCallError(error) && error.status === 401) return undefined;
    throw error;
  }
}
