# HushVault — Claude Code Instructions

**Cloudflare-native secrets manager SaaS.** $0 to self-host. Built for edge-first teams.

---

## What We're Building

HushVault manages application secrets with envelope encryption (AES-256-GCM), branch inheritance, computed secrets, and one-click Cloudflare Pages sync. The entire backend runs on Cloudflare Workers + D1 + KV — no servers, no VMs.

**Users:** Developers who want Doppler-quality secrets management at Infisical prices ($0 self-host).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API | Cloudflare Workers + Hono |
| DB | Cloudflare D1 (SQLite) + Drizzle ORM |
| Secrets Storage | Cloudflare KV (AES-256-GCM encrypted blobs) |
| Dashboard | Next.js 14 + Cloudflare Pages |
| CLI | Commander.js + node-keytar (OS keychain) |
| Crypto | WebCrypto API (envelope encryption) |
| Monorepo | Turborepo + pnpm workspaces |

---

## Project Structure

```
hushvault/
├── apps/
│   ├── api/          # Hono API on Cloudflare Workers
│   ├── cli/          # Commander.js CLI (npm: hushvault)
│   └── web/          # Next.js dashboard on Cloudflare Pages
├── packages/
│   └── shared/       # Shared types, Hono AppType, crypto utils
├── .claude/          # Claude Code configuration
├── CLAUDE.md         # This file
└── SKILL.md          # Core product skill
```

---

## Critical Rules

### Security (NON-NEGOTIABLE)
- **Never** log, `console.log`, or embed secrets/keys in error messages or responses
- **Never** use hardcoded keys, IVs, or salts — always generate with `crypto.getRandomValues()`
- **Never** implement custom cryptography — use WebCrypto (`crypto.subtle`) only
- **Always** use parameterized queries via Drizzle ORM (never raw SQL string interpolation)
- **Always** validate and sanitize all user input at API boundaries
- **Always** use envelope encryption: KEK (master key) wraps DEK, DEK encrypts secret value

### Cloudflare Workers Constraints
- **No** Node.js APIs — use WebCrypto, not `node:crypto`
- **No** Argon2 — CPU time limits; use PBKDF2-SHA256 (100,000 iterations)
- **Use** `Env` type for all Cloudflare bindings (D1Database, KVNamespace)
- **Use** `nodejs_compat` flag in wrangler.toml for CLI-adjacent packages only

### TypeScript
- Strict mode everywhere — `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`
- All shared types live in `packages/shared/src/types/`
- Import from `@hushvault/shared`, never relative cross-package paths
- No `any` — use proper types or `unknown` with guards

### Code Style
- Named exports only (no default exports) — better monorepo tree-shaking
- 2-space indentation
- Conventional commits: `feat:`, `fix:`, `chore:`, `refactor:`, `docs:`

---

## Commands

```bash
pnpm dev              # Start all apps in dev mode (Turborepo)
pnpm build            # Build all packages
pnpm test             # Run all tests (Vitest)
pnpm type-check       # TypeScript check across monorepo
pnpm lint             # ESLint across monorepo

# API (apps/api)
wrangler dev          # Local Workers dev server
wrangler deploy       # Deploy to production
wrangler d1 execute hushvault-db --file=migrations/xxxx.sql  # Run migration

# CLI (apps/cli)
pnpm --filter @hushvault/cli build  # Build CLI
node dist/index.js --help           # Test locally
```

---

## API Conventions

Routes live in `apps/api/src/routes/`. Each file exports a Hono router.

```typescript
// Pattern for route files
const router = new Hono<{ Bindings: Env }>()

router.get('/:id', async (c) => {
  const { id } = c.req.param()
  // ...
  return c.json({ data: result })
})

export { router as secretsRouter }
```

Error responses always follow:
```typescript
return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
```

---

## Database Conventions

Schema lives in `apps/api/src/db/schema.ts`. Drizzle migrations via `wrangler d1`.

- All tables use `text('id').primaryKey()` with `nanoid()` IDs (never auto-increment integers)
- Timestamps: `createdAt` / `updatedAt` as ISO strings
- Soft deletes where applicable: `deletedAt` text field
- Branch inheritance: `parentEnvId` text reference

---

## Encryption Architecture

```
Master Key (ENCRYPTION_MASTER_KEY env var, base64)
    ↓ AES-256-GCM wrap
Data Encryption Key (DEK, random per secret)
    ↓ AES-256-GCM encrypt
Secret Value (plaintext)
```

All crypto is in `apps/api/src/crypto/envelope.ts`. Do not duplicate crypto logic elsewhere.

---

## Skills

Read the skills for specialised tasks:

- [SKILL.md](SKILL.md) — Core product context and patterns
- [skills/crypto-audit/SKILL.md](skills/crypto-audit/SKILL.md) — Audit encryption code
- [skills/wrangler-deploy/SKILL.md](skills/wrangler-deploy/SKILL.md) — Deploy to Cloudflare
- [skills/db-migrate/SKILL.md](skills/db-migrate/SKILL.md) — Create and apply D1 migrations
- [skills/security-review/SKILL.md](skills/security-review/SKILL.md) — Full security review
- [skills/monorepo-check/SKILL.md](skills/monorepo-check/SKILL.md) — Validate build health

---

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — System design and data flow
- [docs/ENCRYPTION.md](docs/ENCRYPTION.md) — Envelope encryption implementation
- [docs/API.md](docs/API.md) — REST API reference
- [docs/CLI.md](docs/CLI.md) — CLI command reference
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — Deploy, migrate, rotate keys

---

## What NOT to Do

- Do not add auth middleware outside `apps/api/src/middleware/auth.ts`
- Do not store plaintext secrets anywhere (DB, KV, logs, responses)
- Do not use `fetch()` to call internal services — use Hono RPC with `@hushvault/shared` AppType
- Do not add `console.log` in production paths (use structured error returns)
- Do not modify the D1 schema directly — always create a migration

---

**Last Updated:** March 31, 2026
**Org:** hushvaultdev
**Repo:** hushvaultdev/hushvault
