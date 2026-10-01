# Deployment Guide

HushVault's API is a Cloudflare Worker (`apps/api`) with a D1 database, a KV
namespace and a Durable Object (`RateLimiter`). It has two deployed
environments, defined in `apps/api/wrangler.toml`:

| Env          | Worker name             | D1                     | Domain (configured)         | Deployed from |
|--------------|-------------------------|------------------------|-----------------------------|---------------|
| `staging`    | `hushvault-api-staging` | `hushvault-db-staging` | `api-staging.hushvault.dev` | branch `dev`  |
| `production` | `hushvault-api`         | `hushvault-db`         | `api.hushvault.dev`         | branch `main` |

Top-level config is what `wrangler dev` uses (local simulated D1/KV/DO).
Wrangler bindings, `vars` and `routes` are **non-inheritable**, so each env block
declares its own; a block that omits them deploys without them
(<https://developers.cloudflare.com/workers/wrangler/environments/>).

Runbook for backups, key loss, incidents and monitoring: [OPERATIONS.md](OPERATIONS.md).

## Prerequisites

- Cloudflare account and a zone for `hushvault.dev` in that account (for custom domains).
- Node 22 and pnpm (`corepack enable`), then `pnpm install` at the repo root.
- Locally, authenticate with `pnpm --filter @hushvault/api exec wrangler login`
  (CI uses an API token instead, see below).

All commands below run from `apps/api` unless noted; `wrangler` means
`pnpm exec wrangler`.

## First-time setup checklist

### 1. Create the Cloudflare resources (twice: staging and production)

```bash
wrangler d1 create hushvault-db-staging
wrangler d1 create hushvault-db
wrangler kv namespace create hushvault-secrets-staging
wrangler kv namespace create hushvault-secrets
```

Copy each returned `database_id` / KV `id` into `apps/api/wrangler.toml`,
replacing the matching `REPLACE_WITH_*` value in `[env.staging]` /
`[env.production]`. The top-level (local dev) IDs are already the non-placeholder
`local-dev-unused`; wrangler dev never contacts them. CI refuses to deploy while
**any** `REPLACE_WITH` string remains in the file.

Never let staging and production share a D1 or KV id.

### 2. Set secrets (per environment)

```bash
# 32 random bytes, base64: the envelope-encryption master key (KEK)
openssl rand -base64 32          # -> paste into ENCRYPTION_MASTER_KEY
# 64 random bytes, base64: JWT signing secret
openssl rand -base64 64 | tr -d '\n'   # -> paste into JWT_SECRET

wrangler secret put ENCRYPTION_MASTER_KEY --env staging
wrangler secret put JWT_SECRET            --env staging
# repeat with DIFFERENT values for --env production
```

Use different values per environment. **Back up the production
`ENCRYPTION_MASTER_KEY` offline before the first real secret is stored**
(see OPERATIONS.md: losing it makes all stored secrets unrecoverable).

Optional secrets (the OAuth routes return 503 until set):
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

Secrets can only be set on a Worker that exists. If `wrangler secret put` reports
the Worker does not exist yet, deploy once first (step 5) and then set secrets.
(Not verified against current docs; `wrangler secret put` may also offer to create it.)

Local development: copy the names into `apps/api/.dev.vars` (git-ignored).

### 3. OAuth apps

Create one OAuth app per provider per environment.

| Provider | Redirect / callback URL                                     |
|----------|-------------------------------------------------------------|
| GitHub   | `https://<api-host>/api/auth/github/callback`               |
| Google   | `https://<api-host>/api/auth/google/callback`               |

`<api-host>` is `api.hushvault.dev` (production) or `api-staging.hushvault.dev`
(staging). Put the client id/secret in the secrets from step 2.

### 4. Web app URL, CORS and domains

- `WEB_APP_URL` (a plain var in `wrangler.toml`) is the post-login redirect target.
  It is preset to `https://app.hushvault.dev` (production) and
  `https://staging.hushvault.dev` (staging); change it if your dashboard lives elsewhere.
- CORS is a hard-coded allow-list in `apps/api/src/index.ts`
  (`hushvault.dev`, `app.hushvault.dev`, `beta.hushvault.dev`, localhost). A new web
  origin (including the staging dashboard URL) must be added there; that is a code change.
- Custom domains are declared with `[[env.*.routes]] custom_domain = true`. On deploy
  Cloudflare creates the DNS record and certificate; the zone must be in the
  account and the API token needs *Zone > Workers Routes > Write* for it
  (<https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>,
  <https://developers.cloudflare.com/workers/authorization/workers/>).
  If a hostname already has a conflicting DNS record, delete it first.
  Don't want custom domains yet? Delete the `routes` blocks and set `workers_dev = true`.

### 5. First deploy and migrations (manual, once)

```bash
pnpm db:migrate:staging                  # wrangler d1 migrations apply DB --remote --env staging
pnpm deploy:staging                      # wrangler deploy --env staging
curl -i https://api-staging.hushvault.dev/health
```

Repeat with `:production`. The first deploy of each env runs the Durable Object
migration `v1` (`new_sqlite_classes = ["RateLimiter"]`). New Durable Object
classes must be SQLite-backed
(<https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/>).
Each env has its own migration entry and its own Worker, hence its own DO namespace;
each migration tag is applied once per environment
(<https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/>).

`/health` runs `SELECT 1` against D1 and returns 503 when the DB is unreachable.

### 6. GitHub configuration (CI/CD)

Settings > Environments: create `staging` and `production`.

For **each** environment add:

- Secret `CLOUDFLARE_API_TOKEN`: an account API token. The Cloudflare Workers
  GitHub Actions guide says to start from the **Edit Cloudflare Workers** template
  and scope it to the one account
  (<https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/>).
  The pipeline also runs `wrangler d1 migrations apply`, so the token additionally
  needs D1 edit permission, and Zone > Workers Routes > Write if routes are
  deployed. *Exact permission names for D1 were not verified in the docs; test on
  staging first.* Use a separate token per environment.
- Secret `CLOUDFLARE_ACCOUNT_ID`.
- Variable `API_BASE_URL` (not a secret), e.g. `https://api.hushvault.dev`; used by the post-deploy smoke test.

On `production` also enable **Required reviewers** (and optionally restrict
deployment branches to `main`). This cannot be configured from the repo; without
it production deploys run unattended right after CI passes.

## How CI/CD works

`.github/workflows/deploy-api.yml`:

1. **Pull request touching `apps/api/**` or `packages/shared/**`**: `wrangler deploy --dry-run`
   for both envs (bundles the Worker and validates config; no credentials, no deploy).
2. **Push to `main` / `dev`**: the `CI` workflow runs. When it completes
   successfully, `deploy-api.yml` is triggered via `workflow_run` and:
   1. checks out the exact commit CI tested (`workflow_run.head_sha`);
   2. skips if that commit is no longer the branch tip (a newer run will deploy);
   3. installs with a frozen lockfile;
   4. **fails if `apps/api/wrangler.toml` still contains `REPLACE_WITH`**;
   5. fails if the env's token/account/`API_BASE_URL` are missing;
   6. `wrangler d1 migrations apply DB --remote --env <env>`;
   7. `wrangler deploy --env <env>`;
   8. smoke test: `GET $API_BASE_URL/health` must return 200 (12 tries, 10 s apart), otherwise the job fails.
   Deploys are serialized per environment (`concurrency`, no cancellation).
   `main` maps to `production`, `dev` to `staging`.

Why `workflow_run`: a plain `push` trigger would race CI and deploy untested code.
Caveats: `workflow_run` always uses the workflow file from the default branch, so
edits to `deploy-api.yml` take effect once merged to `main`; only `push` events from
this repository deploy (forks are excluded).

Migrations run *before* the new code is deployed. Keep every migration
backward compatible with the currently running code (add columns/tables first;
remove or rename in a later release).
Migration files `0001`-`0003` and `0005` use plain `ALTER TABLE`; that is fine
because wrangler tracks applied migrations in the `d1_migrations` table and never
re-runs one. Do not edit applied migration files; add a new `NNNN_*.sql`.
`wrangler d1 migrations apply` captures a backup before applying and, in CI
(non-interactive), skips the confirmation prompt
(`wrangler d1 migrations apply --help`, wrangler 4.92.0).

Package scripts (`apps/api/package.json`): `db:migrate` / `db:migrate:local`
(local), `db:migrate:staging|production`, `db:migrations:list:staging|production`,
`deploy:dry-run`, `deploy:staging|production`.

## Rollback

Worker code:

```bash
wrangler deployments list --env production   # find a good version
wrangler rollback [VERSION_ID] --env production --message "reason"
```

`wrangler rollback` creates a new deployment of an earlier version, live
immediately on all routes/domains; only the 100 most recent versions are available.
It is refused if a Durable Object class lifecycle change happened between the two
versions, or if a bound KV/R2/queue no longer exists
(<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>,
<https://developers.cloudflare.com/workers/wrangler/commands/workers/>).

**Rollback does not revert D1 migrations.** Because migrations are additive and run
before deploy, the previous code normally still works against the new schema. If a
migration itself was destructive or wrong, restore with D1 Time Travel
(see OPERATIONS.md) or ship a corrective forward migration.

## Verifying a deploy

```bash
curl -fsS https://api.hushvault.dev/health
wrangler tail --env production          # live logs
```
