# Wrangler Deploy Skill

Deploy the HushVault API to Cloudflare Workers.

## When to Use

Use `/wrangler-deploy` to:
- Deploy a new version of `apps/api` to production
- Deploy to a staging environment for testing
- Apply D1 migrations before deploying a schema change

## Pre-Deploy Checklist

Before deploying, verify:
1. All tests pass: `pnpm test` from repo root
2. TypeScript compiles: `pnpm type-check`
3. No `.dev.vars` secrets accidentally added to source
4. `wrangler.toml` has correct `database_id` and KV `id`
5. Any new secrets are set via `wrangler secret put` (not in toml)

## Deploy Steps

### 1. Build
```bash
cd apps/api
pnpm build
```

### 2. Apply migrations (if schema changed)
```bash
# Check pending migrations
ls migrations/

# Apply to production D1
wrangler d1 execute hushvault-db --file=migrations/NNNN_description.sql
```

### 3. Set any new secrets
```bash
# Only needed when adding NEW secrets — not on every deploy
wrangler secret put NEW_SECRET_NAME
```

### 4. Deploy
```bash
wrangler deploy
```

### 5. Verify
```bash
# Health check
curl https://api.hushvault.dev/health

# Expected: {"status":"ok","version":"x.y.z"}
```

## Rollback

Cloudflare keeps previous deployment versions. To rollback:
```bash
wrangler rollback
```

## Staging Environment

If a `[env.staging]` block exists in `wrangler.toml`:
```bash
wrangler deploy --env staging
```

## Secrets Management

Production secrets are set once via `wrangler secret put` and stored in Cloudflare's encrypted secret store. They are NOT in `wrangler.toml` or `.dev.vars`.

Current production secrets:
- `ENCRYPTION_MASTER_KEY` — AES-256 master key (base64)
- `JWT_SECRET` — JWT signing secret
- `STRIPE_SECRET_KEY` — Stripe payments (Phase 3)
- `STRIPE_WEBHOOK_SECRET` — Stripe webhooks (Phase 3)
