-- 0003 local demo identity.
--
-- This is deliberately a *small* identity system for a local lab (ADR-0008 / spec): password hashing
-- plus server-side sessions whose bearer tokens are stored only as SHA-256 hashes. There are no
-- default accounts: `npm run seed` creates synthetic customers and `npm run seed:lab` prints a
-- one-time local admin password.

CREATE TABLE app_users (
  id            uuid PRIMARY KEY DEFAULT app.new_id(),
  email         text NOT NULL,
  -- NULL is allowed: token-only demo identities (used by load tests) have no password.
  password_hash text,
  display_name  text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'CUSTOMER' CHECK (role IN ('CUSTOMER', 'LAB_ADMIN')),
  created_at    timestamptz NOT NULL DEFAULT app.now(),
  updated_at    timestamptz NOT NULL DEFAULT app.now(),
  CONSTRAINT app_users_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Case-insensitive uniqueness without requiring the citext extension (PostgreSQL does not allow
-- expressions inside a table-level UNIQUE constraint, so this is a unique expression index).
CREATE UNIQUE INDEX app_users_email_lower_unique ON app_users (lower(email));

CREATE TABLE sessions (
  id         uuid PRIMARY KEY DEFAULT app.new_id(),
  user_id    uuid NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
  -- SHA-256 hex of the random token handed to the client; the raw token is never stored.
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT app.now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at) WHERE revoked_at IS NULL;

CREATE TRIGGER app_users_touch_updated_at
  BEFORE UPDATE ON app_users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
