# Deployment Guide

HushVault runs entirely on Cloudflare, and **CI/CD runs on Cloudflare Workers
Builds** (no GitHub or GitLab CI minutes). Workers Builds connects a Git
repository (GitHub or GitLab.com; self-hosted instances are not supported) to a
Worker, builds on every push, and deploys.
<https://developers.cloudflare.com/workers/ci-cd/builds/>

There are two deployable apps and two environments, so **four Workers**:

| App | Env | Worker name | Production branch | Root directory | Domain |
|---|---|---|---|---|---|
| API | `dev` | `hushvault-api-dev` | `dev` | `apps/api` | `api-beta.hushvault.dev` (in `wrangler.toml`) |
| API | `production` | `hushvault-api` | `main` | `apps/api` | `api.hushvault.dev` (in `wrangler.toml`) |
| Web | `dev` | `hushvault-web-dev` | `dev` | `apps/web` | `beta.hushvault.dev` (dashboard, manual) |
| Web | `production` | `hushvault-web` | `main` | `apps/web` | `hushvault.dev` (dashboard, manual) |

Domains: production is `hushvault.dev`, dev is `beta.hushvault.dev`. The web
domains are added by hand in the dashboard rather than in `wrangler.toml`, because
attaching a Custom Domain to the apex can replace existing DNS records for it.
The `hushvault.dev` zone is in the same Cloudflare account (N4K4R; checked via the API 2026-10-01).

Per environment, the API uses its own D1 database and KV namespace (created
2026-10-01, IDs in `apps/api/wrangler.toml`, tracked in issue #21):

| Env | D1 | KV |
|---|---|---|
| `dev` | `hushvault-db-dev` | `hushvault-secrets-dev` |
| `production` | `hushvault-db` | `hushvault-secrets` |

Wrangler bindings, `vars` and `routes` are **non-inheritable**: each `[env.*]`
block declares its own, and a block that omits them deploys without them
(<https://developers.cloudflare.com/workers/wrangler/environments/>). Worker names
are set explicitly in the config because the dashboard Worker name must match the
`name` in the Wrangler file or the build fails.

Runbook for backups, key loss, incidents and monitoring: [OPERATIONS.md](OPERATIONS.md).
Web-specific notes: [apps/web/DEPLOY.md](../apps/web/DEPLOY.md).

## Branch flow

```
feature branch --PR--> dev --(verified on dev)--> main
                        |                          |
                  deploys *-dev Workers     deploys production Workers
```

Every push to a connected branch triggers a build. **A failing build does not
deploy**; the previous deployment keeps serving.

## What a build does

Per Worker, in the dashboard under **Settings > Build** (verify these field names
in the dashboard; the docs list: build command, deploy command, preview command,
root directory, API token, build variables and secrets):

| Worker | Build command | Deploy command |
|---|---|---|
| `hushvault-api-dev` | `pnpm install --frozen-lockfile && pnpm run verify` | `pnpm run deploy:dev` |
| `hushvault-api` | `pnpm install --frozen-lockfile && pnpm run verify` | `pnpm run deploy:production` |
| `hushvault-web-dev` | `pnpm install --frozen-lockfile && pnpm run verify && pnpm run build:cf` | `pnpm run deploy:dev` |
| `hushvault-web` | `pnpm install --frozen-lockfile && pnpm run verify && pnpm run build:cf` | `pnpm run deploy:production` |

- `verify` (API) runs type-check and the unit tests for the API, the packages it
  depends on, and the GitHub Action in `apps/secrets-action`; (web) type-check, lint
  and the web + shared tests. Defined in each app's `package.json`.
- API deploy scripts run **D1 migrations first, then deploy**
  (`wrangler d1 migrations apply DB --remote --env <env>` then `wrangler deploy --env <env>`).
  Use `deploy:dev:code-only` / `deploy:production:code-only` to skip migrations.
- Set **Root directory** to `apps/api` or `apps/web`, and **build watch paths**
  so an API change does not rebuild the web Worker and vice versa
  (<https://developers.cloudflare.com/workers/ci-cd/builds/build-watch-paths/>;
  include `apps/<app>/**`, `packages/shared/**`, `pnpm-lock.yaml`).
  For the **API** Workers also include `apps/secrets-action/**`: the GitHub Action has
  no Worker of its own, so its tests ride the API `verify` and only run when the API
  build does. Without that watch path, an action-only change ships untested.
- Web only: set the **build variable** `NEXT_PUBLIC_API_URL` (inlined at build time).
- Node: Workers Builds defaults to Node 24.18.0 and preinstalls 22.23.2 and 24.18.0;
  `.nvmrc` in this repo pins major `22`. The API tests use `node:sqlite`
  (Node >= 22.13).
  (<https://developers.cloudflare.com/changelog/post/2026-07-30-workers-builds-nodejs-24/>)

### Pull-request checks without CI minutes (design choice, verify on first run)

Enable **Settings > Build > Branch control > Enable Preview Builds**. Preview
builds run for every non-production branch: the build command (including the
tests) runs, then the **preview command**. Set the preview command to a no-op
such as `echo "verification only"` so no isolated Preview is created. A failing
test fails the build and shows as a failed check on the GitHub commit/PR
(GitHub integration reports check runs and PR comments). This is untested in this
repo: confirm the check appears and fails when a test is broken.

### The deploy token and D1 migrations

By default Workers Builds generates an API token with: Account Settings (read),
Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit),
Zone Workers Routes (edit), User Details and Memberships (read)
(<https://developers.cloudflare.com/workers/ci-cd/builds/configuration/#api-token>).
**D1 is not in that list**, so `wrangler d1 migrations apply` in the deploy command
will probably be refused. This is an inference from the documented permission list,
not a tested failure. Two ways to handle it:

1. Create your own user API token that also has **D1 edit** and select it as the
   Worker's build token (the docs allow choosing your own token; exact D1 permission
   name not verified), or
2. Use the `*:code-only` deploy commands and run migrations by hand:
   `pnpm --filter @hushvault/api db:migrate:dev` (after `wrangler login`).

## First-time setup checklist

### 1. Cloudflare resources

Done (issue #21). IDs are in `apps/api/wrangler.toml`. To recreate elsewhere:
`wrangler d1 create <name>` and `wrangler kv namespace create <title>` and paste the
IDs into the matching `[env.*]` block. Never share a D1 or KV between dev and production.

### 2. Create the four Workers and connect the repo

For each row of the table above: **Workers & Pages > Create application > Import a
repository**, pick this repo, and name the Worker **exactly** as in the table. Then
set root directory, production branch, build/deploy commands, watch paths and
build variables as described above. (Dashboard flow per
<https://developers.cloudflare.com/workers/ci-cd/builds/>; I could not drive the
dashboard, so the click path is unverified.)

Create the `dev` branch first (`git branch dev main && git push origin dev`).

### 3. Set secrets (per environment, different values)

Dashboard: Worker > **Settings > Variables & Secrets**, or
`wrangler secret put <NAME> --env <env>`.

```bash
openssl rand -base64 32                 # ENCRYPTION_MASTER_KEY (256-bit KEK)
openssl rand -base64 64 | tr -d '\n'    # JWT_SECRET
```

Required: `ENCRYPTION_MASTER_KEY`, `JWT_SECRET`. Optional (the OAuth routes return
503 until set): `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.

**Plain vars, not secrets** (they live in `wrangler.toml`, per environment, and are listed here
because they were previously documented only inside an integration guide):

| Var | Why it matters |
|---|---|
| `API_PUBLIC_URL` | This deployment's own API origin, and the default GitHub OIDC audience. The Action refuses to run unless the audience host matches its `api-url` host, so if this is unset the dev deployment demands the production audience and rejects every token. |
| `GITHUB_OIDC_AUDIENCE` | Overrides the above. Only set it if a different audience is deliberately required. |
| `GITHUB_OIDC_ISSUER`, `GITHUB_OIDC_JWKS_URL` | Override GitHub's defaults. Leave unset in normal use. |
| `ENCRYPTION_ACTIVE_KEY_VERSION` | Which key-ring version new writes use. See docs/ENCRYPTION.md. |
| `ENFORCE_AAD` | Refuses rows still on the pre-AAD blob format. **Check `legacyEncVersionRows` on `GET /api/security/key-rotation` is 0 before turning this on** — otherwise every read of an affected environment fails as a unit. |
| `HUSHVAULT_SYNC_DENY_SCRIPTS`, `HUSHVAULT_SYNC_DENY_ACCOUNT_IDS` | Extra sync targets that may never be written. |

**Rotating `JWT_SECRET`** also invalidates every sync fingerprint (they are derived from it), so
the next run of each target re-pushes every value it manages. That is safe — it can never turn
into a delete — but it does re-send every secret to the provider and spend provider quota.

**Back up the production `ENCRYPTION_MASTER_KEY` offline before the first real
secret is stored**: losing it makes all stored secrets unrecoverable (OPERATIONS.md).

### 4. OAuth apps

| Provider | Redirect / callback URL |
|---|---|
| GitHub | `https://<api-host>/api/auth/github/callback` |
| Google | `https://<api-host>/api/auth/google/callback` |

### 5. Web URL, CORS and domains

- `WEB_APP_URL` (a `vars` entry per env in `apps/api/wrangler.toml`) is the post-login
  redirect target, the share-link host and an **allowed CORS origin**: the API trusts
  the origin of its own `WEB_APP_URL` in addition to the fixed production list, so a
  new environment needs the variable, not a code change.
  Dev is `https://beta.hushvault.dev`, production is `https://hushvault.dev`.
- API routes (`api-beta.hushvault.dev`, `api.hushvault.dev`) are declared with
  `custom_domain = true`; the `hushvault.dev` zone must be in the same account. If it
  is not, delete the route blocks and set `workers_dev = true`. `api-beta` is a
  single-level subdomain on purpose: I believe Cloudflare's free universal certificate
  covers only one subdomain level (unverified, please check)
  (<https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>).

### 6. First migration and deploy

Push to `dev`. If your build token cannot run D1 migrations (see above), first run
`pnpm --filter @hushvault/api db:migrate:dev` yourself. Then:

```bash
curl -i https://<dev-api-host>/health
```

`/health` probes **both** stores a secret read needs and returns 503 when either is down:
`SELECT 1` against D1, and a read of the never-written key `health:probe` against KV (a read, so
it cannot consume KV's daily write quota). The `checks` object says which one failed — a missing
KV binding shows as `checks.kv: "unconfigured"`, which is worth checking on a first deploy.
See docs/OPERATIONS.md § 3 for what it does and does not prove.
The first deploy of each env runs the Durable Object migration `v1`
(`new_sqlite_classes = ["RateLimiter"]`); new DO classes must be SQLite-backed
(<https://developers.cloudflare.com/changelog/post/2026-07-09-restrict-new-kv-backed-namespaces/>).

## Transactional email (issue #26)

Email verification and password reset send mail through **Cloudflare Email Service** (Workers
`send_email` binding, public beta, needs Workers Paid; docs: developers.cloudflare.com/email-service).
The code is provider-neutral (`apps/api/src/lib/email.ts`); with no binding configured nothing is sent
and the endpoints still respond normally.

1. Owner (issue #75): onboard `hushvault.dev` under Compute > Email Service > Email Sending > Onboard
   Domain (the domain must use Cloudflare DNS), and confirm the DNS records and daily quota.
2. In `apps/api/wrangler.toml`, uncomment the `[[env.<env>.send_email]]` block (name `EMAIL`, pinned to
   `allowed_sender_addresses`) and make sure `MAIL_FROM` matches an address on the onboarded domain, then deploy.
   The binding config was checked with `wrangler deploy --dry-run` (wrangler 4.92.0); behaviour on a real
   deploy and real sends is not verified yet.
3. Smoke test: before the domain is onboarded you can only send to verified destination addresses in the account.

**Migration `0007_email_tokens.sql`** (auth token table and `users.sessions_valid_after`) must be applied to each
database with a D1-capable token, like `0006`.

## Migrations

**Migration `0018_multi_org.sql`** (multi-org foundation, issue #82) is **additive and applied in the
usual order — before the new code is deployed.** It adds `api_keys.org_id` and
`refresh_tokens.org_id` (both nullable), the `org_invites` table, and four indexes. It drops,
renames and rebuilds nothing, and no statement in the currently deployed Worker names any of them,
so the old code keeps working unchanged against the migrated database. `0017` is still the only
migration that reverses the order; this one is not an exception to that rule.

What an operator needs to know:

1. **Order.** `pnpm --filter @hushvault/api db:migrate:dev` (then `:production`), *then* deploy. The
   reverse order also works but leaves a longer NULL window (see 3).
2. **Backfill.** The migration fills both new columns from the row owner's single membership
   (`members ... ORDER BY created_at ASC LIMIT 1`). That expression is correct here and nowhere else:
   before this change nothing creates a second membership, so every user has at most one. This is the
   last use of it in the repo.
3. **The NULL window.** Between applying the migration and the deploy going live, the old code still
   inserts `api_keys` and `refresh_tokens` rows without an org. Those rows fail closed under the new
   code and are **not** repaired by anything:
   - a refresh family with no org → `401` with `reason: "org_unresolved"`, the family is revoked and
     the cookie cleared. **Everyone who signed in during that window signs in once more.** Nothing
     else is lost. Keep the window short (deploy right after migrating) and it is a handful of users.
   - an API key created during that window → `401 KEY_ORG_UNRESOLVED` on every request. It must be
     **re-created** (`POST /api/auth/api-keys`); there is no way to repair it, because there is no
     record of which org it was meant for. Tell CI owners before migrating if keys are being minted.
4. **An API key whose backfill found no membership.** Its `org_id` stays `NULL` and the key is dead
   with `401 KEY_ORG_UNRESOLVED`. This is a key belonging to a user with no `members` row at all — an
   account whose membership was deleted without the key being revoked. Such a key was *already*
   unusable before this change (the old lookup also returned nothing and answered `401`), so nothing
   that worked stops working. To find them before migrating:

   ```sql
   SELECT k.id, k.user_id, k.name FROM api_keys k
    WHERE k.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.user_id = k.user_id);
   ```
5. **No reverse migration.** Rolling the code back while `0018` is applied is safe (the old code
   ignores the new columns), but any key created by the new code names an org the old code will not
   read — it falls back to the owner's earliest membership, which is the behaviour being removed. Roll
   forward.

The `org_invites` table ships here, unused, because issue #82 Lane B builds the invite endpoints on it
and one migration for the whole change beats a second `ALTER` later. Its one OPEN invite per address
per org is a **partial** unique index (`WHERE accepted_at IS NULL AND revoked_at IS NULL`), so
accepting or revoking frees the address — a plain unique constraint would have to be loosened by a
table rebuild, which `.claude/rules/database-schema.md` shows is not safely available.

**Migration `0017_drop_secret_history.sql` must be applied *after* the new code is deployed —
it is the first migration that reverses the usual order.** Everything else here is additive and
is applied first; this one removes a table the previously deployed Worker still queries. Apply it
while the old code is live and `PATCH /api/secrets/:id` (the history insert), `DELETE
/api/secrets/:id`, `DELETE /api/projects/:id`, `GET /api/security/key-rotation` and the key-rotation
cron's bootstrap all fail on `no such table: secret_history`. The other order is safe: the new
code never names the table, so it runs correctly against a database that still has it — the rows
simply stop changing. So: deploy, confirm the version is live, then
`pnpm --filter @hushvault/api db:migrate:dev` (then `:production`).

Two further notes on it. It also rewrites any rotation stored mid-flight at `phase = 'history'`
to `connections` with a NULL cursor; a job that reaches the new code before the migration is
handled in code (it re-drives `secrets` from a cursor already at the end of that table and
advances normally), so neither order wedges a rotation. And it destroys the wrapped DEKs of every
superseded secret value: no replaced value is recoverable afterwards, by restore or otherwise.
Export first if you want those rows — see OPERATIONS.md § 2 and issue #84.

**Migration `0016_cron_bookkeeping.sql`** (`system_state` and `orphan_blob_candidates`, issue
#87) is additive and applied in the usual order. Until it is applied the minute cron logs
`housekeeping.tick_step_failed` with `step: "orphan_blobs"` each tick and no orphaned KV blob is
collected; the audit, share-link and token sweeps, key rotation and every route are unaffected
(`system_state` reads and writes swallow their own errors by design, so rotation's bootstrap
backoff just does not persist).

**Migrations `0011_sync.sql` and `0012_sync_triggers.sql`** (sync engine tables; automatic-trigger columns and outbox) are applied the same way. Without `0012` the sync routes and the minute cron's sync sweep fail (logged as `sync.tick_step_failed`) but secrets, sign-in and key rotation are unaffected.

**Migration `0010_integration_connections.sql`** (integration credential vault; also rebuilds the two small key-rotation tables with a wider CHECK, copying their rows) should be applied before the code that uses it: until then the key-rotation cron logs `key_rotation.tick_failed` each minute (its first query reads the new table) and `/api/integrations/*` returns 500; secrets and auth are unaffected. Apply with `pnpm --filter @hushvault/api db:migrate:dev` (then `:production`).

**Migrations `0008_aad_enc_version.sql` (AAD ciphertext format) and `0009_refresh_tokens.sql` (refresh tokens, issue #77)** must be applied to a database *before* the code that uses them is deployed: without `0008` every secret read/write fails, without `0009` login and register fail. Apply with `pnpm --filter @hushvault/api db:migrate:dev` (then `:production`). Optional var `ENFORCE_AAD=true` refuses pre-AAD rows once none remain (see `docs/ENCRYPTION.md`). The web dashboard now keeps the access token in memory and relies on the API's `__Host-hv_refresh` cookie, so the web and API origins must share a registrable domain (`hushvault.dev`); local dev should use `localhost` for both.

**Rollback warning:** once any `enc_version = 2` secret exists, the pre-AAD code cannot read it (and an old Worker that PATCHes such a row would leave it unreadable). Roll forward, not back, after the first v2 write.

**Migration `0006_key_rotation.sql`** (key rotation tables, issue #27) must be applied to each database. The `*:code-only` deploy commands do not run migrations, so apply it by hand with a token that has D1 edit (`pnpm --filter @hushvault/api db:migrate:dev` / `db:migrate:production`). Until it is applied the new cron handler logs `key_rotation.tick_failed` and does nothing, and `GET /api/security/key-rotation` returns 500; everything else works.

Migrations run *before* the new code is deployed: keep each one backward compatible
with the code that is currently running (add first; remove or rename in a later
release). A migration that *removes* something is the exception and must be applied
after the deploy, called out above — `0017` is the only one so far. An additive
migration whose new column the old code leaves NULL (`0015`, `0018`) still needs the
new code to say what a NULL means, and the answer must be "refuse", not "fall back". `0001`-`0003` and `0005` use plain `ALTER TABLE`; that is fine because
wrangler tracks applied migrations in `d1_migrations` and never re-runs one. Do not
edit applied files; add a new `NNNN_*.sql`. `wrangler d1 migrations apply` captures a
backup before applying and skips the confirmation prompt when non-interactive
(`wrangler d1 migrations apply --help`, wrangler 4.92.0).

Package scripts (`apps/api/package.json`): `db:migrate` / `db:migrate:local`,
`db:migrate:dev|production`, `db:migrations:list:dev|production`, `deploy:dry-run`,
`deploy:dev|production` (migrate + deploy), `deploy:dev:code-only` /
`deploy:production:code-only`, `verify`.

## What is *not* covered by this pipeline

- **Playwright e2e** and **`pnpm audit`** no longer run in CI (issue #32): e2e needs
  browsers that Workers Builds probably cannot provide (unverified), and the audit
  fails on advisory-database drift unrelated to a change, so it must not gate deploys.
  Run `pnpm test:e2e` locally before merging to `main`.
- Build limits for Workers Builds were not verified; check
  <https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/>.

## Rollback

```bash
wrangler deployments list --env production
wrangler rollback [VERSION_ID] --env production --message "reason"
```

`wrangler rollback` creates a new deployment of an earlier version, live immediately;
only the 100 most recent versions are available, and it is refused if a Durable Object
class lifecycle change happened between the two versions or a bound KV/R2/queue no
longer exists
(<https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/>).
**Rollback does not revert D1 migrations.** Because migrations are additive, the
previous code normally still works against the new schema; otherwise restore with D1
Time Travel (OPERATIONS.md) or ship a corrective forward migration.

## Verifying a deploy

```bash
curl -fsS https://<api-host>/health
wrangler tail --env production          # live logs
```
