# Wrangler Deploy Skill

Deploy the HushVault API/web to Cloudflare. **Normal deploys are not manual:**
pushing to `dev` or `main` triggers Cloudflare Workers Builds, which verifies and
deploys (see `docs/DEPLOYMENT.md`). Use this skill for first-time setup, manual
migrations, dry runs and rollbacks.

## Environments

| Env | API Worker | Branch | API domain | Web domain |
|---|---|---|---|---|
| `dev` | `hushvault-api-dev` | `dev` | `api-beta.hushvault.dev` | `beta.hushvault.dev` |
| `production` | `hushvault-api` | `main` | `api.hushvault.dev` | `hushvault.dev` |

Wrangler config: `apps/api/wrangler.toml` (`[env.dev]`, `[env.production]`).
Bindings are non-inheritable, so each env block declares its own D1/KV/Durable Object.

## Pre-deploy checklist

1. `pnpm type-check` and `pnpm test` pass (the Workers Builds build command runs
   `pnpm run verify`, so a failing test blocks the deploy).
2. No secrets in source (`.dev.vars` is git-ignored).
3. New secrets set per environment (dashboard Variables & Secrets, or
   `wrangler secret put NAME --env <env>`), never in `wrangler.toml`.
4. A new migration file `apps/api/migrations/NNNN_*.sql` if the schema changed
   (never edit applied ones; migrations must be backward compatible).

## Commands (from `apps/api`)

```bash
pnpm deploy:dry-run                 # bundle + validate bindings, no credentials needed
pnpm db:migrate:local               # apply migrations to the local simulated D1
pnpm db:migrations:list:dev         # what is pending on dev
pnpm db:migrate:dev                 # apply migrations to the dev D1 (needs wrangler login)
pnpm deploy:dev                     # migrate + deploy dev (what Workers Builds runs)
pnpm deploy:dev:code-only           # deploy without migrating
pnpm deploy:production              # same for production
```

Verify: `curl https://api.hushvault.dev/health` (dev: `https://api-beta.hushvault.dev/health`).

## Rollback

```bash
wrangler deployments list --env production
wrangler rollback [VERSION_ID] --env production --message "reason"
```

Rollback does not revert D1 migrations; ship a corrective forward migration or use
D1 Time Travel (see `docs/OPERATIONS.md`).

## Secrets

Required per environment: `ENCRYPTION_MASTER_KEY` (AES-256 master key, base64; **back up
the production value offline**) and `JWT_SECRET`. Optional: GitHub/Google OAuth client
id+secret, `STRIPE_*`. Use different values for dev and production.
