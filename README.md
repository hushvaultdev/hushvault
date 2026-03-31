# HushVault

**Secrets manager built for the edge. $0 to self-host. Ships with what Doppler charges extra for.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-hushvault.dev-blue)](https://hushvault.dev)

---

## Why HushVault?

| Feature | HushVault | Infisical | Doppler |
|---------|-----------|-----------|---------|
| Computed secrets (`${DB_USER}:${DB_PASS}`) | ✅ | ❌ | ✅ |
| Branch inheritance (env inherits from parent) | ✅ | ❌ | ✅ |
| Temporary share URLs (E2E encrypted) | ✅ | ❌ | ✅ |
| Native Cloudflare Pages sync | ✅ | ✅ | ❌ |
| Self-host for $0 (Cloudflare free tier) | ✅ | ❌ | ❌ |
| Open source (MIT) | ✅ | Partial | ❌ |
| Generous free tier | ✅ | Throttled | Gutted |

---

## Quick Start

```bash
# Install CLI
npm install -g hushvault

# Login
hushvault login

# Link your project
cd my-project
hushvault init

# Set a secret
hushvault set DATABASE_URL "postgres://..."

# Run with secrets injected
hushvault run -- npm run dev
```

## Computed Secrets

Reference other secrets in values — compose complex strings without duplication:

```bash
hushvault set DB_USER "myapp"
hushvault set DB_PASS "s3cr3t"
hushvault set DATABASE_URL '${DB_USER}:${DB_PASS}@db.host/myapp'
# → DATABASE_URL resolves to: myapp:s3cr3t@db.host/myapp
```

## Branch Inheritance

Environments form a tree. Children inherit from parents and only override what changes:

```
base (shared vars)
├── staging  (overrides: API_URL)
└── production
    ├── prod-us  (overrides: REGION)
    └── prod-eu  (overrides: REGION)
```

## GitHub Actions

```yaml
- uses: hushvaultdev/secrets-action@v1
  with:
    token: ${{ secrets.HUSHVAULT_TOKEN }}
    project: my-project
    env: production
```

---

## Self-Host on Cloudflare (Free)

```bash
git clone https://github.com/hushvaultdev/hushvault
cd hushvault
pnpm install

# Create D1 database and KV namespace
wrangler d1 create hushvault-db
wrangler kv:namespace create SECRETS_KV

# Update wrangler.toml with the IDs, then deploy
wrangler deploy
```

Total cost: **$0/month** on Cloudflare free tier.

---

## Stack

- **API:** [Hono](https://hono.dev) + [Cloudflare Workers](https://workers.cloudflare.com)
- **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1) + [Drizzle ORM](https://orm.drizzle.team)
- **Secrets Storage:** [Cloudflare KV](https://developers.cloudflare.com/kv) (AES-256-GCM encrypted)
- **Dashboard:** Next.js on [Cloudflare Pages](https://pages.cloudflare.com)
- **CLI:** Commander.js + node-keytar (OS keychain)
- **Encryption:** Envelope encryption via WebCrypto API

---

## License

MIT — see [LICENSE](LICENSE)
