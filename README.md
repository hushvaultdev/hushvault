# HushVault

**Secrets manager built for the edge. $0 to self-host on Cloudflare. Pre-release.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-hushvault.dev-blue)](https://hushvault.dev)

---

## Status

**HushVault is pre-release software. It is not production-ready and has not had an independent security audit.**

**What works today**

- Secrets CRUD with envelope encryption (AES-256-GCM via WebCrypto; KEK wraps a per-secret DEK)
- Branch inheritance: per-environment parent/child resolution
- Computed secrets: `${NAME}` templates evaluated server-side
- Role-based access control (viewer / member / admin / owner) and API keys
- Audit log API
- GitHub and Google OAuth sign-in
- One-time share links (API only; there is no web page for opening a link yet)
- GitHub secret-scanning callback (revokes leaked HushVault API keys)
- Email verification and password reset (on the dev deployment; production rollout pending)
- Short-lived sessions with rotating refresh tokens, and ciphertext bound to its record (AAD)
- CLI: `login`, `init`, `set`, `get`, `run`, `share`
- Cloudflare Workers secrets sync: beta, manual runs from the dashboard, CLI (`hushvault sync`) and API, one-way Worker secrets only, not yet verified against a live Cloudflare account (see `docs/integrations/cloudflare-workers.md`)
- Web dashboard: sign-in, projects, secrets, audit log

**Planned, not built**

- Integrations still planned: GitHub Actions, Cloudflare Pages, Slack, webhooks (status in `packages/shared/src/integrations.ts`)
- Stripe billing, hosted paid plans, and plan-limit enforcement
- SSO/SAML
- Team invites and member management
- Rotation of secret values and compromise-response re-encryption (master-key rotation exists; see docs/ENCRYPTION.md)
- Public web page for opening share links
- Compliance attestations (e.g. SOC 2). None are held today.

---

## Where HushVault Came From

HushVault started as a developer-first alternative to expensive secrets managers. The goal is to offer the workflow features teams actually use (computed secrets, branch inheritance, share links, and Cloudflare-native architecture) while keeping self-hosting easy and affordable on the Cloudflare free tier.

---

## Local Development

Requirements: Node.js **>= 22.13** (the API tests use `node:sqlite`, which needs no flags from 22.13) and pnpm >= 9.

```bash
git clone https://github.com/hushvaultdev/hushvault
cd hushvault
pnpm install

# API: local secrets and local D1 schema
cd apps/api
cp .dev.vars.example .dev.vars   # then fill in ENCRYPTION_MASTER_KEY and JWT_SECRET
wrangler d1 migrations apply hushvault-db --local
cd ../..

pnpm dev          # starts all apps (API via wrangler dev, web via next dev)
pnpm test         # API/CLI unit tests (Node >= 22.13)
pnpm type-check
pnpm lint
pnpm build
```

`ENCRYPTION_MASTER_KEY` must be a base64-encoded 32-byte key (for example `openssl rand -base64 32`). OAuth sign-in is optional and needs the GitHub/Google variables described in `.dev.vars.example`.

## CLI Usage

Build the CLI from source (`pnpm --filter hushvault build`, then `node apps/cli/dist/index.js`):

```bash
hushvault login
cd my-project
hushvault init
hushvault set DATABASE_URL "postgres://..."
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

Planned. The `hushvaultdev/secrets-action` action and GitHub Actions sync do not exist yet.

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

Self-hosting targets the Cloudflare free tier, so it should cost $0/month for small workloads. Also run `wrangler d1 migrations apply hushvault-db` from `apps/api` and set secrets with `wrangler secret put`. Review the status above before relying on it.

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
