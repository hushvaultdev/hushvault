# HushVault Core Product Skill

Use this skill when working on any part of the HushVault codebase.

## Product Context

**HushVault** is a Cloudflare-native secrets manager SaaS. Think Doppler's UX with Infisical's pricing model, built entirely on Cloudflare's free tier stack.

**Core differentiators:**
1. Computed secrets — `${DB_USER}:${DB_PASS}@host` interpolation with dependency graph
2. Branch inheritance — environments form a tree; children inherit and override
3. Temporary share URLs — E2E encrypted, key in fragment (zero-knowledge)
4. Native Cloudflare Pages sync — auto-pushes on save
5. `$0/month` self-host — Workers + D1 + KV free tier

## Architecture Summary

```
CLI (Commander.js)  ──fetch──→  Hono API (Workers)  ──Drizzle──→  D1 (metadata)
  OS Keychain ←─ node-keytar                        ──encrypt──→  KV (secret blobs)
Dashboard (Next.js) ──fetch──→  same API
GitHub Actions ──→ hushvaultdev/secrets-action ──→ same API
```

## Key Files

| What | Where |
|------|-------|
| API entrypoint + Env type | `apps/api/src/index.ts` |
| Envelope encryption | `apps/api/src/crypto/envelope.ts` |
| Database schema (Drizzle) | `apps/api/src/db/schema.ts` |
| All route files | `apps/api/src/routes/` |
| CLI commands | `apps/cli/src/commands/` |
| Auth token storage | `apps/cli/src/config/auth.ts` |
| Project config (.hushvault.json) | `apps/cli/src/config/project.ts` |
| Shared types | `packages/shared/src/` |

## Env Type

All Cloudflare bindings are typed via `Env` in `apps/api/src/index.ts`:

```typescript
type Env = {
  DB: D1Database
  SECRETS_KV: KVNamespace
  ENVIRONMENT: string
  ENCRYPTION_MASTER_KEY: string  // base64 AES-256 key
  JWT_SECRET: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}
```

## Encryption Pattern

Always use `encryptSecret` / `decryptSecret` from `apps/api/src/crypto/envelope.ts`.
Never store plaintext. The KV stores `{ encryptedValue, wrappedDek }`.

```typescript
import { encryptSecret, decryptSecret } from '../crypto/envelope.js'

// Store
const { encryptedValue, wrappedDek } = await encryptSecret(plaintext, masterKey)

// Retrieve
const plaintext = await decryptSecret(encryptedValue, wrappedDek, masterKey)
```

## Computed Secrets

When `isComputed = true`, the `value` column contains a template like `${DB_USER}:${DB_PASS}@host`.
Resolution happens at fetch-time by substituting referenced secrets.
Dependency tracking: `dependencies` column is JSON array of secret names referenced.

## Branch Inheritance

Environments have `parentEnvId`. Resolution: walk up the tree, child values override parent.
Implement in `apps/api/src/routes/environments.ts` `/resolved` endpoint.

## Zero-Knowledge Share Links

Share links: encryption key in URL fragment (never reaches server).
Server stores ciphertext only. Client decrypts in-browser.
See `apps/api/src/routes/share.ts` for structure.

## Pricing Model

| Tier | Price | Limits |
|------|-------|--------|
| Free | $0 | 3 projects, 100 secrets, 3 environments |
| Pro | $12/mo | 10 projects, 1,000 secrets, unlimited environments |
| Team | $99/mo | Unlimited, SSO, audit log, SCIM |
| Enterprise | Custom | Custom domains, SLAs, support |

## Current Phase

Phase 1 (MVP, Weeks 1-8): Auth, CRUD secrets, CLI `run` command, Cloudflare Pages sync.
Phase 2 (Weeks 9-16): Computed secrets, branch inheritance, share links, GitHub Action.
Phase 3 (Weeks 17-24): Dashboard UI, Stripe billing, SSO, public launch.
