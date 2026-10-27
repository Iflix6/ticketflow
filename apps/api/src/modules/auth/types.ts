export const USER_ROLES = ['CUSTOMER', 'LAB_ADMIN'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/** Identity as seen by request handlers. Deliberately minimal: no PII beyond the local demo email. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: UserRole;
}

export interface TokenPayload {
  readonly sub: string;
  readonly email: string;
  readonly role: UserRole;
  /** Expiry as epoch seconds (checked against server time, not the client's). */
  readonly exp: number;
}
