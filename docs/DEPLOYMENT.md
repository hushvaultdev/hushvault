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

## Beta / Dev Branch Deployment

The `dev` branch is configured as the beta preview path.

- `dev` branch pushes should deploy the API using `wrangler deploy --env dev`.
- On Cloudflare Pages, map the `dev` branch to the beta preview site and attach the `beta.hush*` custom domain.
- Use the `N4K4R` Cloudflare account for both the worker and Pages projects.
- The `main` branch remains the production deployment path with the full custom domain.

This gives you a real beta channel for `dev`, while `main` continues to drive the full production rollout.

---

## GitHub Secret Scanning Partner Registration (Manual)

The `POST /api/integrations/secret-scanner/github` callback is live, but GitHub
only calls it once HushVault is registered with the GitHub Secret Scanning
Partner Program. This step is manual and cannot be automated — it requires
out-of-band coordination with GitHub.

One-time action items:

1. Email GitHub from `security@hushvault.dev` to join the partner program
   (free): https://docs.github.com/code-security/secret-scanning/secret-scanning-partner-program
2. Register the token pattern `hv_live_[A-Za-z0-9_-]{43}` (the `hv_live_` prefix
   plus the base64url-encoded 32 random bytes minted by `createApiKey`).
3. Provide the callback URL: `https://api.hushvault.dev/api/integrations/secret-scanner/github`
4. GitHub publishes the ECDSA P-256 signing keys at
   `https://api.github.com/meta/public_keys/secret_scanning`; the callback fetches
   and verifies against these automatically — no secret to store on our side.

Until registration completes, the endpoint simply receives no traffic. No
deploy-time secret or binding is required for this feature.

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

## Rate Limiting & Abuse Prevention

Defence is layered. The Worker enforces per-IP limits in code (see
`apps/api/src/middleware/rate-limit.ts`); Cloudflare's WAF should enforce a
coarser perimeter layer **before** requests reach the Worker.

### Worker-enforced limits (already in code)

| Scope | Route(s) | Limit (per IP) |
|-------|----------|----------------|
| `auth-login` | `POST /api/auth/login` | 10 / min |
| `auth-register` | `POST /api/auth/register` | 5 / min |
| `auth-oauth` | `GET /api/auth/{github,google}{,/callback}` | 20 / min |
| `share-access` | `GET /api/share/:token` | 20 / min |
| `secret-read` | `GET /api/secrets`, `GET /api/secrets/:name` | 120 / min |
| `secret-write` | `POST/PATCH/DELETE /api/secrets` | 60 / min |
| `global-api` | all `/api/*` (safety net) | 600 / min |

Rate-limited responses carry `X-RateLimit-Limit` / `X-RateLimit-Remaining`
(CORS preflight `OPTIONS` requests are skipped, so they do not); `429`s add
`Retry-After` (seconds) and a JSON body
`{ "error": "RATE_LIMIT_EXCEEDED", "message": "...", "resetAt": "..." }`.

### Cloudflare WAF rules (configure in the dashboard before launch)

These run globally before the Worker executes. Configure under
**Security → WAF → Rate limiting rules**:

```
Rule 1 — Login:    (http.request.uri.path eq "/api/auth/login")
                   → 5 req / IP / min, action: 429 (Retry-After: 60)
Rule 2 — Register: (http.request.uri.path eq "/api/auth/register")
                   → 3 req / IP / 10 min
Rule 3 — Share:    (http.request.uri.path matches "^/api/share/")
                   → 20 req / IP / min
Rule 4 — Auth bot: (http.request.uri.path matches "^/api/auth/")
                   → Turnstile / JS challenge (managed challenge)
```

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
