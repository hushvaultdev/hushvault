-- 0007: single-use tokens for email verification and password reset (issue #26), and a
-- per-user "sessions valid after" marker used later to invalidate JWTs after a reset.
-- Only the SHA-256 hash of a token is stored, never the token itself.

CREATE TABLE IF NOT EXISTS auth_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  token_hash TEXT NOT NULL UNIQUE,
  -- Address the token was issued for; consuming it requires users.email to still match.
  email TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);
CREATE INDEX IF NOT EXISTS auth_tokens_expires_idx ON auth_tokens (expires_at);

-- Unix seconds. 0 = no session has been invalidated. SQLite has no ADD COLUMN IF NOT EXISTS;
-- wrangler's migration tracking guarantees this runs once (same pattern as 0005).
ALTER TABLE users ADD COLUMN sessions_valid_after INTEGER NOT NULL DEFAULT 0;
