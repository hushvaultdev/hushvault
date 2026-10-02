-- Integrations (issue #39): encrypted credential vault + key rotation coverage for it.
--
-- integration_connections holds an outbound credential (e.g. a Cloudflare API token) as ciphertext only:
-- encrypted_credential + wrapped_dek, bound by AAD to (org_id, id), under the same key ring as secrets so the
-- rotation engine re-wraps it. No endpoint returns the credential. Deleting a row deletes the credential.
CREATE TABLE IF NOT EXISTS integration_connections (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  label TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  encrypted_credential TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  key_version TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_verified_at TEXT
);
CREATE INDEX IF NOT EXISTS integration_connections_org_idx ON integration_connections (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_label_idx ON integration_connections (org_id, provider, label);

-- The rotation engine gets a third phase for connections. SQLite cannot alter a CHECK constraint, so the two
-- small rotation tables are rebuilt with the wider constraints (their rows are copied unchanged).
CREATE TABLE key_rotations_new (
  id TEXT PRIMARY KEY,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'completed_with_errors', 'failed')),
  phase TEXT NOT NULL DEFAULT 'secrets' CHECK (phase IN ('secrets', 'history', 'connections')),
  secrets_cursor TEXT,
  history_cursor TEXT,
  connections_cursor TEXT,
  rewrapped INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  lease_owner TEXT,
  last_error_code TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
INSERT INTO key_rotations_new (id, from_version, to_version, status, phase, secrets_cursor, history_cursor, rewrapped, skipped, failed, lease_until, lease_owner, last_error_code, started_at, updated_at, completed_at)
  SELECT id, from_version, to_version, status, phase, secrets_cursor, history_cursor, rewrapped, skipped, failed, lease_until, lease_owner, last_error_code, started_at, updated_at, completed_at FROM key_rotations;
DROP TABLE key_rotations;
ALTER TABLE key_rotations_new RENAME TO key_rotations;
CREATE UNIQUE INDEX IF NOT EXISTS key_rotations_one_running ON key_rotations(status) WHERE status = 'running';

CREATE TABLE key_rotation_failures_new (
  rotation_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('secrets', 'secret_history', 'integration_connections')),
  row_id TEXT NOT NULL,
  error_code TEXT NOT NULL,
  PRIMARY KEY (rotation_id, table_name, row_id)
);
INSERT INTO key_rotation_failures_new (rotation_id, table_name, row_id, error_code) SELECT rotation_id, table_name, row_id, error_code FROM key_rotation_failures;
DROP TABLE key_rotation_failures;
ALTER TABLE key_rotation_failures_new RENAME TO key_rotation_failures;
