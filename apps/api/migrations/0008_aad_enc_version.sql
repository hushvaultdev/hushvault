-- Ciphertext format version. 1 = legacy (no additional authenticated data), 2 = AES-GCM bound to the
-- record context (project, environment, secret id). New writes are always 2. The format of the KV blob
-- must agree with this column. Set ENFORCE_AAD=true once no version-1 rows remain:
--   SELECT COUNT(*) FROM secrets WHERE enc_version = 1; SELECT COUNT(*) FROM secret_history WHERE enc_version = 1;
-- SQLite has no ADD COLUMN IF NOT EXISTS; wrangler's migration tracking runs this once (same as 0005/0007).
ALTER TABLE secrets ADD COLUMN enc_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE secret_history ADD COLUMN enc_version INTEGER NOT NULL DEFAULT 1;
