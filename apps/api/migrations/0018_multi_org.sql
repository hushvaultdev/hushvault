-- 0018: multi-org foundation (issue #82, docs/plans/multi-org-and-invites.md Lane A).
--
-- Every credential now NAMES the organisation it acts in, instead of the API re-deriving one
-- from the holder's memberships at each use. Three call sites did the latter as
-- `members ... ORDER BY created_at ASC LIMIT 1`, which is only correct while nobody has a
-- second membership -- exactly what invites end. An API key would then act in its owner's
-- EARLIEST org whatever org it was made in, and a refresh would silently move a session from
-- org B to org A (with org A's role) inside 15 minutes.
--
-- ORDER OF APPLY: this file is additive and goes in the usual place -- BEFORE the new code is
-- deployed. It adds two nullable columns, one table and four indexes; it drops, renames and
-- rebuilds nothing, and no currently deployed statement names any of them. The 0017 exception
-- in docs/DEPLOYMENT.md does not apply here.
--
-- RE-RUNNABILITY: statements 3-9 are re-runnable; the two `ALTER TABLE ... ADD COLUMN`s are
-- not (SQLite has no ADD COLUMN IF NOT EXISTS). That is fine -- `wrangler d1 migrations apply`
-- tracks which files have run and never re-runs one. Apply it that way, never with
-- `d1 execute --file=`.
--
-- WHY THE NEW COLUMNS ARE NULLABLE: SQLite cannot add a NOT NULL column to a populated table
-- without a non-NULL default, and there is no correct default for "which org". So both are
-- nullable and the CODE treats NULL as unusable rather than falling back to a membership:
--   * api_keys.org_id IS NULL      -> 401 KEY_ORG_UNRESOLVED (re-create the key)
--   * refresh_tokens.org_id IS NULL -> the refresh fails, the family is revoked and the cookie
--     cleared, so the holder signs in once more.
-- A NULL is reachable in exactly one window: between this migration and the deploy, the old
-- code still writes rows without an org. That window is minutes long and costs one re-login
-- (or one re-created key, if a key is minted inside it). Failing closed there is the point:
-- the alternative is the cross-org fallback this change exists to remove.

-- 1. The org an API key acts in. CASCADE so deleting an organisation takes its keys with it
--    (api_keys already cascades from users; it had no link to an org at all before).
ALTER TABLE api_keys ADD COLUMN org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE;

-- 2. The org a refresh-token family is bound to. Carried unchanged through every rotation, so a
--    rotation cannot move a session between orgs; switching orgs starts a NEW family.
ALTER TABLE refresh_tokens ADD COLUMN org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE;

-- 3-4. Backfill. `ORDER BY created_at ASC LIMIT 1` is correct HERE and nowhere else: before this
--    change there is no endpoint that creates a second membership (the only INSERTs into members
--    are self-signup and OAuth signup, each making a fresh org), so every user has at most one.
--    This is the last use of that expression -- it records the single answer that was already
--    being recomputed per request, rather than continuing to guess.
--
--    A row whose user has NO membership keeps org_id NULL and its credential stops working. For
--    api_keys that is the orphan case the code now refuses by design; see the operator note in
--    docs/DEPLOYMENT.md.
UPDATE api_keys
   SET org_id = (
     SELECT m.org_id FROM members m
      WHERE m.user_id = api_keys.user_id
      ORDER BY m.created_at ASC LIMIT 1
   )
 WHERE org_id IS NULL;

UPDATE refresh_tokens
   SET org_id = (
     SELECT m.org_id FROM members m
      WHERE m.user_id = refresh_tokens.user_id
      ORDER BY m.created_at ASC LIMIT 1
   )
 WHERE org_id IS NULL;

-- 5-6. Both new columns are read on the hot auth path by their row's primary key / unique hash,
--    so these indexes are not for lookups: they are what keeps an organisation delete from
--    scanning both tables, and what a later per-org credential listing will use.
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_org_idx ON refresh_tokens (org_id);

-- 7. Invitations. Created here, with the columns and the constraint, rather than in the lane that
--    builds the endpoints (Lane B) -- one migration, one shape, no second ALTER on a table the
--    first migration could have got right.
--
--    The token is never stored: only token_hash = base64url(SHA-256(token)), like auth_tokens and
--    refresh_tokens. `email` is stored already lower-cased by the writer, which is what makes the
--    partial unique index below a per-address constraint rather than a per-spelling one.
--
--    invited_by / accepted_by / revoked_by are ON DELETE SET NULL: offboarding the admin who sent
--    an invite must neither be blocked nor erase the invite's own history.
CREATE TABLE IF NOT EXISTS org_invites (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  revoked_at TEXT,
  revoked_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- 8. One OPEN invite per address per org. Partial, so the address is freed again the moment the
--    invite is accepted or revoked -- a plain UNIQUE (org_id, email) would make the first invite
--    to an address permanent and force a table rebuild to loosen, which
--    .claude/rules/database-schema.md shows is not safely available once anything references the
--    table. Nothing references org_invites yet, which is the other reason to get this right now.
CREATE UNIQUE INDEX IF NOT EXISTS org_invites_open_idx
  ON org_invites (org_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- 9. Listing an org's invites, and the expiry sweep.
CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites (org_id);
CREATE INDEX IF NOT EXISTS org_invites_expires_idx ON org_invites (expires_at);

-- NOT in this file, deliberately: `members_user_idx` on members(user_id). The org list is now a
-- per-request query, but 0000_init.sql already created that index -- so it is a no-op, and
-- re-stating it would only invite the reader to wonder which one wins.
