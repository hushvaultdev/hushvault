# HushVault Core Product Skill

Use this skill when working on any part of the HushVault codebase.

## Product Context

**HushVault** is a Cloudflare-native secrets manager SaaS. Think Doppler's UX with Infisical's pricing model, built entirely on Cloudflare's free tier stack.

**Core differentiators:**
1. Computed secrets — `${DB_USER}:${DB_PASS}@host` interpolation with dependency graph
2. Branch inheritance — environments form a tree; children inherit and override
3. Temporary share URLs — E2E encrypted, key in fragment (zero-knowledge)
4. Cloudflare Workers secrets sync (beta, one-way, with opt-in automatic triggers). Cloudflare **Pages** sync is planned, not built.
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

All Cloudflare bindings are typed via `Env` in `apps/api/src/index.ts`. **Read it there** — the
copy that used to live in this file drifted by about fifteen bindings (the rate-limiter Durable
Object, the email binding, the key-ring and AAD vars, the GitHub OIDC vars, the sync denylists)
before anyone noticed.

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
Dependencies are derived at resolve time from the template, not stored. (An early design had a `dependencies` column; the live schema has none.)

## Branch Inheritance

Environments have `parentEnvId`. Resolution: walk up the tree, child values override parent.
Implement in `apps/api/src/routes/environments.ts` `/resolved` endpoint.

## Zero-Knowledge Share Links

Share links: the key is generated client-side and travels only in the URL fragment, so it never reaches the server. This is the one part of HushVault that is genuinely zero-knowledge; stored secrets are not (the server holds the master key).
Server stores ciphertext only. Client decrypts in-browser.
See `apps/api/src/routes/share.ts` for structure.

## Pricing Model

**Do not copy a price sheet here.** `apps/web/src/lib/plans.ts` is the single source of truth, and
it is explicit that only the self-hosted Free tier exists: there is no billing, no plan-limit
enforcement beyond a few gates, no SSO and no SCIM, and every other tier's price is provisional.
A table in this file duplicated those numbers with no "planned" marker, which read as a product
commitment in a public repository.

## Status and roadmap

Tracked in GitHub issues, not here — the roadmap epic is
[#18](https://github.com/hushvaultdev/hushvault/issues/18), and `README.md` carries the
what-works-today list. A phase plan written in this file went six months stale without anyone
noticing.
