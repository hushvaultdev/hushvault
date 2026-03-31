# Deployment Guide

## Prerequisites

- Cloudflare account (free tier sufficient)
- `wrangler` CLI: `npm install -g wrangler`
- `pnpm` installed: `npm install -g pnpm`
- Wrangler authenticated: `wrangler login`

## First-Time Setup

### 1. Create D1 Database
```bash
wrangler d1 create hushvault-db
```
Copy the `database_id` from output. Update `apps/api/wrangler.toml`:
```toml
[[d1_databases]]
binding = "DB"
database_name = "hushvault-db"
database_id = "PASTE_ID_HERE"
```

### 2. Create KV Namespace
```bash
wrangler kv:namespace create SECRETS_KV
```
Copy the `id`. Update `apps/api/wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "SECRETS_KV"
id = "PASTE_ID_HERE"
```

### 3. Generate and Set Secrets
```bash
# Generate master key
node -e "const k = new Uint8Array(32); crypto.getRandomValues(k); console.log(Buffer.from(k).toString('base64'))"

# Set in Wrangler
wrangler secret put ENCRYPTION_MASTER_KEY   # paste generated key
wrangler secret put JWT_SECRET              # generate another random string
```

### 4. Run Initial Migrations
```bash
cd apps/api

# Apply all migrations in order
wrangler d1 execute hushvault-db --file=migrations/0001_initial_schema.sql
```

### 5. Deploy API
```bash
cd apps/api
wrangler deploy
```

### 6. Deploy Dashboard (Cloudflare Pages)
Connect `hushvaultdev/hushvault` repo to Cloudflare Pages:
- Build command: `pnpm --filter @hushvault/web build`
- Output directory: `apps/web/.next`
- Root directory: `/` (repo root)

---

## Routine Deployments

```bash
# From repo root:
cd apps/api && wrangler deploy
```

GitHub Actions handles this automatically on push to `main` (see `.github/workflows/deploy-api.yml`).

---

## Secret Rotation Schedule

| Secret | Rotate Every | Method |
|--------|-------------|--------|
| `ENCRYPTION_MASTER_KEY` | 12 months | See ENCRYPTION.md — requires re-wrapping DEKs |
| `JWT_SECRET` | 6 months | `wrangler secret put JWT_SECRET` — invalidates all sessions |
| `STRIPE_SECRET_KEY` | 12 months | Rotate in Stripe dashboard, then `wrangler secret put` |
| `STRIPE_WEBHOOK_SECRET` | When rotating Stripe key | Same process |

## Rotating JWT_SECRET

1. Generate new secret
2. `wrangler secret put JWT_SECRET`
3. Deploy
4. All existing JWTs are immediately invalidated — users must log in again

## Monitoring

After each deployment, verify:
```bash
curl https://api.hushvault.dev/health
# Expected: {"status":"ok"}
```

## Rollback

```bash
wrangler rollback
```

This reverts to the previous Worker version. Does NOT rollback D1 migrations.
For D1 rollback, write a compensating migration.

---

## Local Development

```bash
# Install deps
pnpm install

# Set local secrets (git-ignored)
cat > apps/api/.dev.vars << 'EOF'
ENCRYPTION_MASTER_KEY=YOUR_LOCAL_TEST_KEY
JWT_SECRET=local-dev-secret
ENVIRONMENT=development
EOF

# Start API locally
cd apps/api && wrangler dev

# Start dashboard locally
cd apps/web && pnpm dev
```

CLI can be tested against local API:
```bash
cd apps/cli
HUSHVAULT_API_URL=http://localhost:8787 node dist/index.js --help
```
