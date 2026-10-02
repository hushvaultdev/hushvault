-- GitHub Actions OIDC pull (issue #43): which workflow may read which environment.
--
-- A rule grants READ-ONLY access to exactly one environment. Matching is on individual OIDC claims
-- (repository, ref / environment), never on the `sub` string: `sub` can be customised per repository,
-- the individual claims cannot. `repository_id` is GitHub's immutable id; when set it must match too,
-- so a repository rename or transfer cannot silently hand the grant to someone else.
CREATE TABLE IF NOT EXISTS oidc_repo_rules (
  id TEXT PRIMARY KEY,                                        -- ocr_...
  org_id TEXT NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  repository TEXT NOT NULL,                                   -- "owner/name", lowercased, exact match
  repository_id TEXT,                                         -- immutable numeric id, optional but recommended
  -- Exactly one subject constraint. ref: "refs/heads/main". environment: a GitHub environment name.
  ref TEXT,
  environment TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  CHECK ((ref IS NOT NULL) <> (environment IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS oidc_repo_rules_org_idx ON oidc_repo_rules (org_id);
CREATE INDEX IF NOT EXISTS oidc_repo_rules_lookup_idx ON oidc_repo_rules (repository);
-- One rule per (environment, repository, constraint): re-adding the same grant is a conflict, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS oidc_repo_rules_unique_idx
  ON oidc_repo_rules (env_id, repository, COALESCE(ref, ''), COALESCE(environment, ''));
