-- Integrations M4 (issue #42): automatic sync triggers.
--
-- sync_on_change: sync shortly after a secret changes in the target's environment or one it inherits from.
-- schedule_minutes: reconcile every N minutes (15, 60, 360 or 1440), NULL = no schedule. Both default to off.
-- SQLite has no ADD COLUMN IF NOT EXISTS; wrangler's migration tracking runs this file once.
ALTER TABLE sync_targets ADD COLUMN sync_on_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_targets ADD COLUMN schedule_minutes INTEGER;

-- Outbox: one pending row per target (changes coalesce while it waits), claimed by the cron sweep.
-- The row carries ids only, never values.
CREATE TABLE IF NOT EXISTS sync_outbox (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL REFERENCES sync_targets(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  claimed_at TEXT,
  done_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS sync_outbox_one_pending ON sync_outbox (target_id) WHERE done_at IS NULL;
CREATE INDEX IF NOT EXISTS sync_outbox_due_idx ON sync_outbox (due_at) WHERE done_at IS NULL;
