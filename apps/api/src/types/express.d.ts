import type { Logger } from 'pino';
import type { AuthenticatedUser } from '../modules/auth/types.js';

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request; taken from a valid inbound `x-request-id` or generated. */
      id: string;
      /** Request-scoped logger carrying `requestId` as a binding. */
      log: Logger;
      /** Populated by the authenticate middleware; absent on public routes. */
      user?: AuthenticatedUser;
      /** High-resolution start time for duration accounting. */
      startedAtNs: bigint;
    }
  }
}

export {};
