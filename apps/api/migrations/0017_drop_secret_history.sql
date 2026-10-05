-- 0017: drop secret_history (issue #84).
--
-- The decision, not a patch: secret_history was write-only. Every value change wrote a row;
-- no endpoint ever read one. There was no retention window, no list, no restore and no purge,
-- so every historical secret value was retained forever as ciphertext with no "forget" path --
-- a compliance liability for a secrets manager, with no function to pay for it. Rotation also
-- spent a whole phase re-wrapping it, and it was normally the largest of the three rotated
-- tables. Exposing it (a versions API plus retention) was the alternative; the owner chose to
-- remove it. See issue #84 and docs/API.md.
--
-- WHAT THIS DESTROYS. The wrapped DEKs of every superseded value. After this migration those
-- values are unrecoverable by any means: the ciphertext may still sit in KV, but without its
-- wrapped DEK nothing can decrypt it, so the "recover a pre-restore value by hand" path in
-- OPERATIONS.md section 2 is gone. That is the accepted cost of the decision, written down
-- here so a later reader does not have to infer it. Take an export first if you want the rows.
--
-- RE-RUNNABILITY. Statements 1 and 2 are re-runnable. `ALTER TABLE ... DROP COLUMN` is not
-- (SQLite has no IF EXISTS for it), which is fine: `wrangler d1 migrations apply` tracks which
-- files have run, so this file is applied exactly once. It is ordered last on purpose -- if a
-- D1 build rejects DROP COLUMN the first two statements have already done the work that
-- matters, and the file can be re-applied with the last statement removed.

-- 1. The table itself. Nothing references secret_history (it is a leaf: it references secrets,
--    not the other way round), so this needs no table rebuild and dangles no foreign key.
--    Its indexes go with it.
DROP TABLE IF EXISTS secret_history;

-- 2. A rotation mid-flight on the `history` phase would name a phase this deployment no longer
--    walks. The engine falls back to the first phase for an unrecognised one, so it cannot wedge
--    either way, but leaving the stale value there means the status endpoint reports a phase that
--    does not exist. Move it on to `connections`: `secrets` is already finished at that point
--    (phases run in order), and a NULL cursor restarts `connections` from the beginning, which is
--    what the normal phase transition does too. The convergence pass at the end of the job
--    re-checks every remaining table regardless, so nothing can be skipped by this.
UPDATE key_rotations SET phase = 'connections', connections_cursor = NULL WHERE phase = 'history';

-- 3. The retired phase's cursor column. Safe to drop in place: history_cursor is not part of a
--    primary key, a unique or CHECK constraint, or any index -- the only index on key_rotations
--    is the partial unique `key_rotations_one_running` on `status`, which this does not touch. So
--    no rebuild, and in particular no rename of a table that other tables reference (the hazard
--    .claude/rules/database-schema.md warns about, and that 0010 got the wrong way round).
--
-- The CHECK constraints that still name the dropped phase are deliberately left alone:
--   key_rotations.phase       CHECK (phase IN ('secrets', 'history', 'connections'))
--   key_rotation_failures.table_name CHECK (... IN ('secrets', 'secret_history', ...))
-- SQLite cannot alter a CHECK, so narrowing either one means rebuilding the table -- and
-- key_rotations carries that partial unique index, which a rebuild has to recreate correctly or
-- silently lose single-flight. A constraint that permits a value no code writes costs nothing,
-- so both stay, and apps/api/src/db/schema.ts keeps them to match. Narrow them only if
-- key_rotations has to be rebuilt for some other reason.
ALTER TABLE key_rotations DROP COLUMN history_cursor;
