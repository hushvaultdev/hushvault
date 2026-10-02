-- Secret sync (issue #40): sync targets, the ledger of names HushVault created, and run history.
--
-- Deleting an integration connection CASCADES to its sync targets (and from there to their ledger and
-- runs). A target without its credential could never run, and keeping it around as "needs attention"
-- forever would hide that sync silently stopped; removing it makes the revoke visible. Losing the ledger
-- is safe: it only ever restricts deletes, so with no ledger HushVault deletes nothing on the target.
-- Everything here is idempotent (IF NOT EXISTS) so a re-apply is harmless.
CREATE TABLE IF NOT EXISTS sync_targets (
  id TEXT PRIMARY KEY,                                       -- ist_...
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES integration_connections(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  resource_json TEXT NOT NULL DEFAULT '{}',                  -- provider identifiers only
  name_filter_json TEXT NOT NULL DEFAULT '{}',               -- { prefix?, deny? }
  delete_removed INTEGER NOT NULL DEFAULT 0,                 -- per-target toggle, OFF by default
  fingerprint_salt TEXT NOT NULL,                            -- random, not secret; salts the HKDF for fingerprints
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'needs_attention')),
  last_run_at TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS sync_targets_org_idx ON sync_targets (org_id, deleted_at);
CREATE INDEX IF NOT EXISTS sync_targets_env_idx ON sync_targets (env_id);
CREATE INDEX IF NOT EXISTS sync_targets_connection_idx ON sync_targets (connection_id);

-- Ledger: a name appears here only after the provider confirmed HushVault wrote it. Only these names may
-- ever be deleted on the target. fingerprint is an HMAC, never the value.
CREATE TABLE IF NOT EXISTS sync_items (
  target_id TEXT NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  last_pushed_at TEXT NOT NULL,
  PRIMARY KEY (target_id, name)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id TEXT PRIMARY KEY,                                       -- isr_...
  target_id TEXT NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'change', 'schedule')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  counts_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  actor_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  next_retry_at TEXT,
  lease_until TEXT
);
CREATE INDEX IF NOT EXISTS sync_runs_target_idx ON sync_runs (target_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sync_runs_retry_idx ON sync_runs (next_retry_at) WHERE next_retry_at IS NOT NULL;
-- Single flight: at most one queued/running run per target. A second INSERT fails with UNIQUE.
CREATE UNIQUE INDEX IF NOT EXISTS sync_runs_one_active ON sync_runs (target_id) WHERE status IN ('queued', 'running');
