-- 0006: master-key (KEK) rotation state (issue #27).
-- Rotation re-wraps data-encryption keys (DEKs) from one KEK version to another.
-- secrets.key_version / secret_history.key_version already exist (0000_init).
-- Nothing here stores key material: check_value is an encryption of a fixed,
-- non-secret string under the key, used to detect a wrong or mistyped key.

CREATE TABLE IF NOT EXISTS encryption_keys (
  version TEXT PRIMARY KEY,
  check_value TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'decrypt_only', 'retired')),
  created_at TEXT NOT NULL,
  activated_at TEXT,
  retired_at TEXT
);

CREATE TABLE IF NOT EXISTS key_rotations (
  id TEXT PRIMARY KEY,
  from_version TEXT NOT NULL,
  to_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'completed', 'completed_with_errors', 'failed')),
  phase TEXT NOT NULL DEFAULT 'secrets' CHECK (phase IN ('secrets', 'history')),
  secrets_cursor TEXT,
  history_cursor TEXT,
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

-- At most one rotation may be running at a time.
CREATE UNIQUE INDEX IF NOT EXISTS key_rotations_one_running ON key_rotations(status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS key_rotation_failures (
  rotation_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK (table_name IN ('secrets', 'secret_history')),
  row_id TEXT NOT NULL,
  error_code TEXT NOT NULL,
  PRIMARY KEY (rotation_id, table_name, row_id)
);
