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
- Role-based access control (viewer / member / admin / owner) and API keys. Note: there is no way to add a second person to an organisation yet, so every account is a single-member organisation and the roles are not reachable in practice
- Audit log API
- GitHub and Google OAuth sign-in
- One-time share links: create with the CLI or API, open at `/share/<token>` in the dashboard (the value is encrypted in the browser before upload and decrypted in the recipient's browser; the server never sees the key)
- GitHub secret-scanning callback (revokes leaked HushVault API keys)
- Email verification and password reset (on the dev deployment; production rollout pending)
- Short-lived sessions with rotating refresh tokens, and ciphertext bound to its record (AAD)
- CLI: `login`, `init`, `set`, `get`, `run`, `share`
- Cloudflare Workers secrets sync: beta, manual runs from the dashboard, CLI (`hushvault sync`) and API, one-way Worker secrets only, not yet verified against a live Cloudflare account (see `docs/integrations/cloudflare-workers.md`)
- Web dashboard: sign-in, projects, secrets, audit log

**Planned, not built**

- Integrations still planned: Cloudflare Pages, Slack, webhooks (status in `packages/shared/src/integrations.ts`)
- GitHub Actions: the API side is built (OIDC token exchange, per-repository access rules) and the
  action itself lives in `apps/secrets-action/`, but it is **not released** — there is no published
  `hushvaultdev/secrets-action` tag to reference from a workflow yet
- Stripe billing and hosted paid plans. A few plan gates *are* already enforced (audit export,
  audit retention, max 2 sync targets on Free) — and with no billing, every organisation is on
  Free forever, so `GET /api/audit/export` currently returns 403 for everyone with no way to
  unlock it
- SSO/SAML
- Team invites and member management
- Rotation of secret values and compromise-response re-encryption (master-key rotation exists; see docs/ENCRYPTION.md)
- Compliance attestations (e.g. SOC 2). None are held today.

---

## Where HushVault Came From

HushVault started as a developer-first alternative to expensive secrets managers. The goal is to offer the workflow features teams actually use (computed secrets, branch inheritance, share links, and Cloudflare-native architecture) while keeping self-hosting easy and affordable on the Cloudflare free tier.

---

## Local Development

Requirements: Node.js **>= 22.13** (the API tests use `node:sqlite`, which needs no flags from 22.13) and pnpm **>= 10** (pnpm 9 blocks dependency build scripts differently, which breaks the CLI's keychain).

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

Code complete, **not released**. The API accepts a GitHub OIDC token and exchanges it for a
short-lived, environment-scoped read token (`POST /api/auth/github-oidc`), access is granted
per repository with an explicit rule, and the action is in `apps/secrets-action/`.

What is missing is only distribution: there is no published `hushvaultdev/secrets-action` tag, so
no workflow can `uses:` it yet. See [docs/integrations/github-oidc.md](docs/integrations/github-oidc.md).

---

## Self-Host on Cloudflare (Free)

```bash
git clone https://github.com/hushvaultdev/hushvault
cd hushvault
pnpm install

cd apps/api

# Create the D1 database and the KV namespace, then put their ids in wrangler.toml
wrangler d1 create hushvault-db
wrangler kv namespace create SECRETS_KV

# Required secrets (never in wrangler.toml)
wrangler secret put ENCRYPTION_MASTER_KEY   # openssl rand -base64 32 — back this up offline
wrangler secret put JWT_SECRET

# Apply migrations (DB is the binding name, not the database name), then deploy
wrangler d1 migrations apply DB --remote
wrangler deploy
```

Then deploy the dashboard from `apps/web` (`pnpm run build:cf && wrangler deploy`) and set
`WEB_APP_URL` and `API_PUBLIC_URL` in `apps/api/wrangler.toml` to your own hostnames.

Two caveats on cost, stated plainly because the headline says $0:

- The API Worker requires a **Durable Object** (`RATE_LIMITER`) and a **Cron Trigger** that runs
  every minute. Check current Workers pricing for your account before assuming $0; we have not
  verified the free-tier limits against this workload.
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) is written for *this* project's Cloudflare account
  (hardcoded `hushvault.dev` hostnames and pre-created resource ids), not as a third-party
  self-hosting guide. Read it as a reference, not a recipe.

Review the status section above before relying on any of this.

---

## Stack

- **API:** [Hono](https://hono.dev) + [Cloudflare Workers](https://workers.cloudflare.com)
- **Database:** [Cloudflare D1](https://developers.cloudflare.com/d1) (raw prepared statements; [Drizzle](https://orm.drizzle.team) for the schema definition only)
- **Secrets Storage:** [Cloudflare KV](https://developers.cloudflare.com/kv) (AES-256-GCM encrypted)
- **Dashboard:** Next.js 15 on [Cloudflare Workers](https://workers.cloudflare.com) via [OpenNext](https://opennext.js.org/cloudflare)
- **CLI:** Commander.js + `keytar` (OS keychain; unmaintained upstream — see docs/CLI.md)
- **Encryption:** Envelope encryption via WebCrypto API

---

## License

MIT — see [LICENSE](LICENSE)
