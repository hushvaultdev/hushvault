-- Uniqueness the API relies on but the base schema did not enforce.
--
-- * A secret name must be unique within an environment; otherwise
--   GET /api/secrets/:name returned an arbitrary row among duplicates.
-- * Project slugs are unique per organisation, environment slugs per project.
--
-- Routes must translate violations of these indexes into 409 CONFLICT.

CREATE UNIQUE INDEX IF NOT EXISTS secrets_env_name_uniq ON secrets (env_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS projects_org_slug_uniq ON projects (org_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS environments_project_slug_uniq ON environments (project_id, slug);
