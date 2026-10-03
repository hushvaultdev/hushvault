-- 0015: share links get an owning organisation (issue #80).
--
-- The share-access audit row used to be derived at read time from created_by's first
-- membership. share_links.created_by is ON DELETE SET NULL, so deleting the creating user
-- (offboarding, an erasure request) turned every share link they left behind into a silently
-- readable secret-delivery endpoint: the view counter still decremented, the ciphertext was
-- still returned, and the organisation saw nothing. Recording the owner at creation makes the
-- audit row independent of whether the creator still exists, and gives revocation and listing
-- something to scope to. ON DELETE CASCADE also means an organisation's share links go with
-- it, which they previously did not.
ALTER TABLE share_links ADD COLUMN org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE;

-- Backfill what can still be attributed. A link whose creator is already gone stays NULL, and
-- the read path refuses to serve a NULL: an unauditable secret delivery is worse than a link
-- that reports itself unavailable.
UPDATE share_links
   SET org_id = (
     SELECT m.org_id FROM members m
      WHERE m.user_id = share_links.created_by
      ORDER BY m.created_at ASC LIMIT 1
   )
 WHERE org_id IS NULL AND created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS share_links_org_idx ON share_links (org_id, expires_at);
