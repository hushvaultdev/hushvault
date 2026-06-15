-- Adds OAuth provider columns to users for GitHub (and future Google) sign-in.
-- OAuth-only users store empty strings for password_hash/salt (password login
-- is impossible since the derived hash never matches an empty string).

ALTER TABLE users ADD COLUMN provider TEXT;
ALTER TABLE users ADD COLUMN provider_id TEXT;

-- Unique so a provider identity maps to exactly one user row. In SQLite,
-- NULLs are distinct, so password users (provider/provider_id NULL) don't clash.
CREATE UNIQUE INDEX IF NOT EXISTS users_provider_idx ON users (provider, provider_id);
