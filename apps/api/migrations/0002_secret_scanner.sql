-- Secret scanning support: soft-revocation audit trail for API keys.
--
-- When GitHub's secret scanning partner program reports a leaked hv_live_* key
-- (POST /api/integrations/secret-scanner/github), the matching api_keys row is
-- invalidated by setting expires_at to "now" (honoured by the auth middleware)
-- and these columns record when/why for the audit log + owner notification.
--
-- SQLite has no "ADD COLUMN IF NOT EXISTS"; this migration is applied once.
-- Re-running it errors ("duplicate column"), which is the expected guard.

ALTER TABLE api_keys ADD COLUMN revoked_at INTEGER;
ALTER TABLE api_keys ADD COLUMN revoked_reason TEXT;

-- Speeds up lookups of revoked keys for reporting / dashboard surfaces.
CREATE INDEX IF NOT EXISTS api_keys_revoked_idx ON api_keys (revoked_at);
