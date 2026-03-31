---
description: Cloudflare Workers runtime constraints and Wrangler configuration rules
globs:
  - "apps/api/**/*.ts"
  - "apps/api/wrangler.toml"
---

# Cloudflare Workers Rules

## Runtime Constraints

- **No Node.js APIs** unless `nodejs_compat` flag is set AND the API is supported in Workers
- **WebCrypto only** — `crypto.subtle`, not `require('crypto')` or `node:crypto`
- **No filesystem** — no `fs`, `path.resolve` against the local filesystem
- **CPU time limit** — avoid computationally expensive operations (no Argon2, limit PBKDF2 iterations to 100,000)
- **No `process.env`** — use `c.env.MY_VAR` (Bindings and Vars from wrangler.toml)
- **Execution context** — `ctx.waitUntil()` for fire-and-forget tasks; `ctx.passThroughOnException()` for error recovery

## Accessing Bindings

```typescript
// In a Hono route handler:
const db = drizzle(c.env.DB)              // D1
const kv = c.env.SECRETS_KV             // KV
const masterKey = c.env.ENCRYPTION_MASTER_KEY  // Secret var

// In wrangler.toml: bindings are auto-typed via Env interface
```

## wrangler.toml Patterns

```toml
[[d1_databases]]
binding = "DB"
database_name = "hushvault-db"
database_id = "REPLACE_WITH_ACTUAL_ID"

[[kv_namespaces]]
binding = "SECRETS_KV"
id = "REPLACE_WITH_ACTUAL_ID"

[vars]
ENVIRONMENT = "production"

# Secrets (never in toml):
# wrangler secret put ENCRYPTION_MASTER_KEY
# wrangler secret put JWT_SECRET
```

## Local Development

Use `.dev.vars` for local secrets (git-ignored):
```
ENCRYPTION_MASTER_KEY=base64encodedkey
JWT_SECRET=your-dev-secret
```

Run locally: `wrangler dev` (in `apps/api/`)

## Deploy

```bash
# Deploy to production
wrangler deploy

# Set secrets (one-time or rotation)
wrangler secret put ENCRYPTION_MASTER_KEY
wrangler secret put JWT_SECRET
```

## D1 Local vs Production

- Local dev: `wrangler dev` uses a local SQLite file (automatic)
- Production: Cloudflare's D1 (replicated SQLite at the edge)
- Run migrations locally first, then production
