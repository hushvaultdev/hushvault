-- 0020: a durable record that an account erasure happened (issue #81, GDPR accountability).
--
-- THE GAP THIS CLOSES. Account deletion writes a `user.delete` audit row into every SURVIVING org
-- the user belonged to. But a sole-member account — one person, one org, nobody else — erases that
-- org and its `audit_log` along with it, so the deletion left NO trail anywhere. That is wrong for
-- an erasure flow: the right to erasure (GDPR Art. 17) removes the personal data, but an operator
-- must still be able to show that a request was honoured (the accountability principle). A trail
-- that vanishes with the data cannot do that.
--
-- WHY A SEPARATE TABLE, NOT audit_log. `audit_log.org_id` is NOT NULL and every row cascades with
-- its org; there is no org to anchor a solo erasure to. This table is anchored to nothing — no
-- foreign key — so it outlives every org and user it refers to. That is the point: it must survive
-- exactly the deletes that erase everything else.
--
-- WHAT IT MAY HOLD — AND MAY NOT. Only what demonstrates the erasure, never the data erased:
--   * erased_user_id  — the opaque `usr_...` id. After the user row is gone this links to nothing
--     (no name, no email, no mapping survives), so it is not identifying on its own; it lets an
--     operator correlate a later "did you erase my account <id>?" without retaining personal data.
--   * erased_at, orgs_erased, actor_type — a timestamp, a count, an enum.
-- NEVER an email, a display name, an IP, a user agent, or anything that re-introduces the personal
-- data the erasure removed. An IP/user-agent would make this a record OF the person, not of the act.
--
-- ADDITIVE, applied BEFORE the deploy (usual order): nothing deployed names this table, and the new
-- code's INSERT needs it to exist first. Nothing is dropped or rebuilt.
CREATE TABLE IF NOT EXISTS erasure_log (
  id TEXT PRIMARY KEY NOT NULL,
  erased_user_id TEXT NOT NULL,
  erased_at TEXT NOT NULL,
  orgs_erased INTEGER NOT NULL DEFAULT 0,
  actor_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS erasure_log_user_idx ON erasure_log (erased_user_id);
CREATE INDEX IF NOT EXISTS erasure_log_at_idx ON erasure_log (erased_at);
