-- Base schema. Everything the API needs before the ALTER-based migrations
-- (0001+) run. Timestamps are ISO-8601 TEXT (the API writes
-- `new Date().toISOString()`); booleans are INTEGER 0/1.
--
-- Migrations 0001-0003 ADD columns that are intentionally NOT declared here
-- (users.provider/provider_id, api_keys.revoked_*, organisations.audit_retention_days).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys (user_id);

CREATE TABLE IF NOT EXISTS organisations (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'team', 'enterprise')),
  stripe_customer_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS members_org_idx ON members (org_id);
CREATE INDEX IF NOT EXISTS members_user_idx ON members (user_id);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS projects_org_idx ON projects (org_id);

CREATE TABLE IF NOT EXISTS environments (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_env_id TEXT REFERENCES environments(id) ON DELETE SET NULL,
  color TEXT DEFAULT '#6366f1',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS environments_project_idx ON environments (project_id);

CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  key_version TEXT NOT NULL DEFAULT 'v1',
  is_computed INTEGER NOT NULL DEFAULT 0,
  template TEXT,
  dependencies TEXT DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS secrets_env_idx ON secrets (env_id);
CREATE INDEX IF NOT EXISTS secrets_project_idx ON secrets (project_id);
CREATE INDEX IF NOT EXISTS secrets_name_idx ON secrets (name);

-- Previous versions of a secret. The encrypted value blob lives in KV under
-- `secrethist:{id}`; only the wrapped DEK is kept here.
CREATE TABLE IF NOT EXISTS secret_history (
  id TEXT PRIMARY KEY NOT NULL,
  secret_id TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
  wrapped_dek TEXT NOT NULL,
  key_version TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  changed_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS secret_history_secret_idx ON secret_history (secret_id);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY NOT NULL,
  token TEXT NOT NULL UNIQUE,
  encrypted_payload TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  max_views INTEGER NOT NULL DEFAULT 1,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_links_token_idx ON share_links (token);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  ip TEXT,
  user_agent TEXT,
  timestamp TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_org_idx ON audit_log (org_id);
CREATE INDEX IF NOT EXISTS audit_log_timestamp_idx ON audit_log (timestamp);
