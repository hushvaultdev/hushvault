-- Audit log compliance: per-org retention override.
--
-- Adds an optional audit_retention_days column to organisations. null means
-- "use the plan default" (see AUDIT_RETENTION_DAYS in
-- apps/api/src/lib/audit-retention.ts). A non-null value can only shorten
-- retention below the plan allowance, never extend it past the tier.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`, matching the existing migration
-- style (0001_oauth_users.sql). Re-running this on a DB that already has the
-- column will error harmlessly; apply once per database.

ALTER TABLE organisations ADD COLUMN audit_retention_days INTEGER;

-- Audit log queries and exports scan by org + time window; this composite
-- index keeps retention-filtered range scans fast as the table grows.
CREATE INDEX IF NOT EXISTS audit_log_org_timestamp_idx ON audit_log (org_id, timestamp);
