# HushVault — Claude Code Instructions

**Cloudflare-native secrets manager SaaS.** $0 to self-host. Built for edge-first teams.

---

## What We're Building

HushVault manages application secrets with envelope encryption (AES-256-GCM), branch inheritance, computed secrets, and one-way Cloudflare Workers secrets sync (beta). The entire backend runs on Cloudflare Workers + D1 + KV — no servers, no VMs. Cloudflare **Pages** sync is planned, not built — see `packages/shared/src/integrations.ts`, which is the single source of truth for what ships.

**Users:** Developers who want Doppler-quality secrets management at Infisical prices ($0 self-host).

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| API | Cloudflare Workers + Hono |
| DB | Cloudflare D1 (SQLite); raw prepared statements. Drizzle is used for the schema definition only |
| Secrets Storage | Cloudflare KV (AES-256-GCM encrypted blobs) |
| Dashboard | Next.js 15 on Cloudflare Workers via OpenNext (`@opennextjs/cloudflare`) |
| CLI | Commander.js + `keytar` (OS keychain; unmaintained upstream, needs a pnpm build approval) |
| Crypto | WebCrypto API (envelope encryption) |
| Monorepo | Turborepo + pnpm workspaces |

---

## Project Structure

```
hushvault/
├── apps/
│   ├── api/             # Hono API on Cloudflare Workers
│   ├── cli/             # Commander.js CLI (not published to npm yet)
│   ├── secrets-action/  # GitHub Action (OIDC); dependency-free, runs src/index.js
│   └── web/             # Next.js dashboard on Cloudflare Workers (OpenNext)
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
- **Always** bind every user value: `DB.prepare(...).bind(...)`, never string interpolation.
  D1 queries are written as raw prepared statements — Drizzle is imported in exactly one file
  (`apps/api/src/db/schema.ts`) for the table definitions, and no route builds a `drizzle()`
  instance. Interpolation into SQL is allowed only for fixed internal fragments (a column list,
  a known table name), never for anything a caller supplied.
- **Always** validate and sanitize all user input at API boundaries
- **Always** use envelope encryption: KEK (master key) wraps DEK, DEK encrypts secret value

### Cloudflare Workers Constraints
- **No** Node.js APIs — use WebCrypto, not `node:crypto`. The API Worker sets
  `no_nodejs_compat` + `no_nodejs_compat_v2`, because at a compatibility date of 2026-08-04 or
  later Workers would otherwise enable Node compat by default; an accidental `node:*` import
  therefore warns at build time and fails at runtime rather than quietly working.
- **No** Argon2 — CPU time limits; use PBKDF2-SHA256. Currently 100,000 iterations, which is
  below OWASP's current recommendation of 600,000 for PBKDF2-HMAC-SHA256; see docs/ENCRYPTION.md
- **Use** `Env` type for all Cloudflare bindings (D1Database, KVNamespace)
- The web Worker does use `nodejs_compat` (OpenNext requires it); the API Worker does not

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
pnpm lint             # ESLint — apps/web only (api, cli and shared have no lint task yet)

# API (apps/api)
wrangler dev          # Local Workers dev server
pnpm deploy:dry-run   # Validate the Worker bundle + bindings (no credentials)
pnpm db:migrate:dev   # Apply D1 migrations to the dev database (needs wrangler login)
# Deploys are NOT manual: pushing to `dev`/`main` triggers Cloudflare Workers Builds.

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

- All tables use `text('id').primaryKey()` with ids from `createPrefixedId(prefix)` — 16 random
  bytes from `crypto.getRandomValues`, base64url, with a type prefix (`prj_`, `env_`, `sec_`,
  `tok_`). Never auto-increment integers, which leak the record count. `nanoid` is not used
  anywhere in the source.
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
- [docs/OPERATIONS.md](docs/OPERATIONS.md) — Runbooks, backup/restore, key loss
- [docs/INTEGRATIONS.md](docs/INTEGRATIONS.md) — Sync engine and provider status
- [docs/integrations/](docs/integrations/) — Per-provider guides (Cloudflare Workers, GitHub OIDC)
- [docs/FAQ.md](docs/FAQ.md) — User-facing questions
- [apps/web/DEPLOY.md](apps/web/DEPLOY.md) — Dashboard Worker deployment

---

## Work Tracking (ALWAYS)

**Every activity is tracked in GitHub Issues** in `hushvaultdev/hushvault` — no exceptions.
- Before starting work, find or create the issue for it (search first to avoid duplicates);
  attach it to the roadmap epic (#18) as a sub-issue when it belongs to go-live work.
- Record decisions, discovered problems, "not verified" items and follow-ups as issues,
  not only in chat or PR descriptions. Reference the issue in commits and PRs
  (`Closes #N` in the PR body).
- Update the issue's checklist/body as work lands; close it when done.
- Labels available: `go-live`, `enhancement`, `documentation`, `question`, `bug` (put the finer
  category in the title prefix: `[Security]`, `[API]`, `[CI/CD]`, `[Infra]`, `[Docs]`, ...).
- The GitHub MCP tools cannot add issues to a GitHub Project board or create labels; attach
  items to the project in the GitHub UI (or via an auto-add workflow in the project settings).

## CI/CD

All CI/CD runs on **Cloudflare Workers Builds** (GitHub-connected; GitLab later) — we do not
use GitHub or GitLab CI minutes. Do not add GitHub Actions/GitLab CI workflows. The build
command runs type-check + tests; a failing build does not deploy. See `docs/DEPLOYMENT.md`.
Environments: `dev` (`beta.hushvault.dev`, `api-beta.hushvault.dev`) and `production`
(`hushvault.dev`, `api.hushvault.dev`).

## What NOT to Do

- Do not add auth middleware outside `apps/api/src/middleware/auth.ts`
- Do not store plaintext secrets anywhere (DB, KV, logs, responses)
- Do not use `fetch()` to call internal services — use Hono RPC with `@hushvault/shared` AppType
- Do not add `console.log` in production paths (use structured error returns)
- Do not modify the D1 schema directly — always create a migration

---

**Last Updated:** October 3, 2026
**Org:** hushvaultdev
**Repo:** hushvaultdev/hushvault
