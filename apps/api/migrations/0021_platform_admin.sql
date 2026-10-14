-- 0021: platform admins + time-boxed comp grants (issue #102, #103).
--
-- WHY A SEPARATE TABLE, NOT A ROLE ON `members`. Platform-admin identity must never be reachable
-- from org membership: an org `owner` is not a platform admin, and a platform admin's power is not
-- scoped to any one organisation. `members.role` answers "what can this person do INSIDE this org";
-- `platform_admins` answers "can this person act on ANY org's billing state at all", a different
-- question with a much higher blast radius, so it gets its own table and its own middleware
-- (requirePlatformAdmin), never a role string that could be confused with the org hierarchy.
--
-- WHY `plan_expires_at` ON `organisations`, NOT A SEPARATE GRANTS TABLE. A comp grant IS a
-- time-boxed plan: the plan column already drives every entitlement (entitlements.ts), so the
-- simplest correct model is "this plan expires at this time, then reverts to free" rather than a
-- second source of truth that has to be kept in sync with `plan`. NULL means the current plan does
-- not expire (free, or a plan set by an operator/Stripe with no end date).
ALTER TABLE organisations ADD COLUMN plan_expires_at TEXT;

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  granted_at TEXT NOT NULL,
  -- Who granted this. NULL only for the first admin, seeded by migration/operator before anyone
  -- else exists to grant it.
  granted_by TEXT REFERENCES users(id)
);
