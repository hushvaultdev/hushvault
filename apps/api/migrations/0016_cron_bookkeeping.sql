-- 0016: the cron's own bookkeeping (issue #87). Additive: two new tables, no
-- existing table or column is touched, and both statements are re-runnable.
--
-- Why D1 and not "just work it out each tick": two jobs on the minute cron need to
-- remember one small thing between ticks, and both are cheap only because they do.
--
-- system_state is a tiny keyed scratchpad for exactly that. Nothing secret is ever
-- stored in it: only timestamps, opaque error codes and a KV list cursor.
--   key_rotation.bootstrap_failed_at
--     bootstrap() runs on every tick while encryption_keys has no 'active' row. When
--     its key check fails it wrote nothing, so a wedged deployment repeated three
--     full table scans every minute, 1,440 times a day, forever. Recording the failed
--     attempt lets the next tick skip it until a minimum retry interval has passed.
--   housekeeping.orphan_blob_cursor
--     where the orphaned-blob reconciliation pass got to in KV's key listing, so each
--     tick scans a bounded page and the sweep still covers the whole namespace.
CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- orphan_blob_candidates: the grace period that makes deleting a KV blob safe.
--
-- The secret create and update paths write the blob to KV and then commit D1, inside
-- one request (migration 0014 explains why that order is the safe one). So a blob with
-- no D1 row pointing at it is EITHER rubbish left by a failed D1 write OR a blob whose
-- row is about to be inserted, and KV cannot tell them apart: list() reports no write
-- time, and pre-0014 blobs carry no metadata.
--
-- A key therefore has to be seen unreferenced twice, far enough apart that no request
-- could still be in flight, before it may be deleted. This table holds the first
-- sighting. It is a cache, not a record: losing a row only restarts the wait, and a row
-- whose key has since gone from KV is pruned on age.
CREATE TABLE IF NOT EXISTS orphan_blob_candidates (
  kv_key TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS orphan_blob_candidates_seen_idx ON orphan_blob_candidates (first_seen_at);
