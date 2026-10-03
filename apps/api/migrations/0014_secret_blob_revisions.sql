-- 0014: immutable, revisioned KV blob keys for secret values (issue #80).
--
-- The problem this fixes: a value change wrote the new ciphertext over
-- `secret:{id}` in KV and only then updated D1. If the D1 write failed, KV held
-- the NEW ciphertext while D1 still held the OLD wrapped DEK, so the secret
-- became permanently undecryptable — and with it every read of the whole
-- environment, because resolveEnvironment fails as a unit. The rollback could
-- not work either: it was a second write to the same KV key within the same
-- request, inside KV's documented one-write-per-second-per-key window.
--
-- The fix is to stop overwriting. Each value change writes a KV key that has
-- never been written before, `secret:{id}:{blob_rev}`, and D1 then moves the
-- pointer. D1 is the single source of truth; a failed D1 write leaves an
-- orphaned blob and a still-readable secret, which needs no rollback.
--
-- blob_rev = 0 means the pre-0014 unversioned key `secret:{id}`, so existing
-- rows keep working untouched and are migrated one at a time by their next
-- value change. There is no backfill and no data movement here.
ALTER TABLE secrets ADD COLUMN blob_rev INTEGER NOT NULL DEFAULT 0;

-- Which blob holds this historical value.
--   NULL    -> a pre-0014 copy at `secrethist:{history_id}`
--   integer -> the secret's own revision `secret:{secret_id}:{blob_rev}`
--              (0 = the unversioned `secret:{secret_id}`)
-- New history rows point at the revision that already exists instead of
-- copying the ciphertext to a second key, which halves the KV writes per
-- value change and removes the second same-key write entirely.
ALTER TABLE secret_history ADD COLUMN blob_rev INTEGER;

-- Rotation walks these three tables filtering on key_version with no index, so
-- a deployment whose rotation is wedged re-scanned all three every minute.
CREATE INDEX IF NOT EXISTS secrets_key_version_idx ON secrets(key_version);
CREATE INDEX IF NOT EXISTS secret_history_key_version_idx ON secret_history(key_version);
CREATE INDEX IF NOT EXISTS integration_connections_key_version_idx ON integration_connections(key_version);
