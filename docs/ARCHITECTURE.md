# HushVault Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENTS                               │
│  CLI (apps/cli)         │  Dashboard (Next.js)  │  CI/CD  │
│  OS Keychain (keytar)  │  Browser session       │  GH Action │
└──────────────┬─────────────────────────────────────────┘
               │ HTTPS
               ▼
┌─────────────────────────────────────────────────────────┐
│              HONO API (Cloudflare Workers)               │
│  Auth middleware (JWT or API key) + per-IP rate limits   │
│  /api/auth     /api/projects    /api/environments        │
│  /api/secrets  /api/share       /api/audit               │
│  /api/integrations/secret-scanner     /health            │
└──────┬───────────────────────────┬──────────────────────┘
       │                           │
       ▼                           ▼
┌─────────────┐           ┌─────────────────────┐
│ Cloudflare  │           │   Cloudflare KV      │
│    D1       │           │   (SECRETS_KV)       │
│  (metadata) │           │  Encrypted blobs     │
│  - users    │           │  key: secret:{id}    │
│  - projects │           │  val: iv:ciphertext  │
│  - envs     │           │  (base64, plain str) │
│  - secrets  │           │  history key:        │
│    (no val) │           │  secrethist:{histId} │
│  - audit    │           └─────────────────────┘
└─────────────┘
```

## Encryption Architecture

```
ENCRYPTION_MASTER_KEY (env var, AES-256)
    │
    │ wrap (AES-256-GCM)
    ▼
Data Encryption Key (DEK, random per secret, AES-256)
    │
    │ encrypt (AES-256-GCM)
    ▼
Secret Value (plaintext)
```

- `wrappedDek` stored in D1 (alongside secret metadata; superseded ones in `secret_history`)
- `encryptedValue` stored in KV as a plain `base64(iv):base64(ciphertext+tag)` string under `secret:{id}` (superseded values under `secrethist:{historyId}`)
- One master key for the whole deployment (no per-organisation keys)
- Master key lives in Cloudflare Worker secrets (never in code or D1)
- To rotate master key: re-encrypt all DEKs with new master key (no re-encryption of values needed)

## Branch Inheritance

Environments form a tree via `parentEnvId`:

```
base (id: env_base)
├── staging (parentEnvId: env_base)
└── production (parentEnvId: env_base)
    ├── prod-us (parentEnvId: env_production)
    └── prod-eu (parentEnvId: env_production)
```

Resolution at `GET /api/environments/:id/resolved`:
1. Walk tree from current env to root (same project only; max depth 10, cycles rejected with 422)
2. Child values override parent values for the same name
3. Return the merged list (with `?values=true`, decrypted and computed values are included)

## Computed Secrets

Stored with `is_computed = true` and `template = "${DB_USER}:${DB_PASS}@host"`.

Resolution happens server-side in the Worker (`apps/api/src/lib/resolve.ts`) when `/resolved?values=true`
is requested: each `${NAME}` placeholder is substituted from the resolved (inherited) set. The server decrypts
secret values to do this, so secrets are not zero-knowledge with respect to the server. Circular, missing,
invalid or oversized references return 422 `COMPUTED_SECRET_ERROR`.

## Zero-Knowledge Share Links

```
Client generates:  shareKey = random AES-256 key
Encrypts value with shareKey → base64url(iv || ciphertext+tag)
Sends to API:      POST /api/share { encryptedPayload, expiresAt?, maxViews? }
API stores:        encryptedPayload in D1 (share_links), returns { token, url }
URL returned:      {url}#{base64url(shareKey)}  (the client appends the fragment)

Recipient opens URL:
  1. Fragment never sent to server
  2. Browser JS extracts shareKey from fragment
  3. Fetches ciphertext from GET /api/share/{token}
  4. Decrypts locally with shareKey
```

## API Routes

See [API.md](API.md) for the complete, code-derived reference (methods, roles, bodies, errors, rate limits).
Mounted prefixes: `/api/auth`, `/api/projects`, `/api/environments`, `/api/secrets`, `/api/share`,
`/api/audit`, `/api/integrations/secret-scanner`, and `/health`.

## Data Flow: CLI `hushvault run -- npm dev`

1. CLI reads `.hushvault.json` (project config, walks up dirs)
2. Gets the token from `HUSHVAULT_TOKEN`, else the OS keychain (node-keytar)
3. Resolves the environment (id, slug or name) via `GET /api/environments?projectId=...`
4. `GET /api/environments/{envId}/resolved?values=true` returns plaintext values over HTTPS (inheritance and computed secrets already applied; decrypted by the API, not the CLI)
5. Merges with `process.env` (unless `--no-inherit`)
6. Spawns child process with merged env

## Secret Sync Engine (issue #40)

One-way push of a resolved environment (HushVault -> target) through a provider that implements
`SyncProvider` (`apps/api/src/integrations/sync-types.ts`). Code: `apps/api/src/integrations/sync-engine.ts`;
environment resolution (inheritance, AAD-bound decrypt, computed secrets) is shared with
`GET /api/environments/:id/resolved` in `apps/api/src/lib/resolve-environment.ts`. Tables (migration `0011`):
`sync_targets`, `sync_items` (ledger), `sync_runs`.

- **Plan** (`planSync`): resolve, apply the target's prefix/deny filter, drop the reserved bootstrap names
  (`ENCRYPTION_MASTER_KEY`, `ENCRYPTION_KEY_V<n>`, `JWT_SECRET`; reported under `skip`), check the provider's limits
  (`TOO_MANY_ITEMS`, `VALUE_TOO_LARGE`, `NAME_INVALID` blockers, before any write), list the target's names and classify:
  create / update / skip / delete / conflict. A name on the target that is not in the ledger is a **conflict** and is never touched.
  A ledger name missing from the target is re-created (drift healing).
- **Ledger and deletes**: `sync_items` holds only names the provider confirmed. Deletion on the target happens only for ledger names,
  only when the per-target `delete_removed` toggle is on (default off).
- **Fingerprints**: `HMAC-SHA256(HKDF-SHA256(JWT_SECRET, salt = target.fingerprint_salt, info = "hushvault-sync-fp-v1"), name || 0x00 || value)`,
  WebCrypto only. Values are never stored. Rotating `JWT_SECRET` changes every fingerprint, which only causes one extra idempotent re-push per item.
- **Run** (`runSync`): single flight per target (partial unique index on `sync_runs` for queued/running plus a lease; an expired lease is
  closed as `TIMEOUT`; a second concurrent call returns the active run). Ops are chunked by `limits.maxItems` (sets first, deletes last);
  the ledger is updated per chunk for items the provider confirmed, so a retry resumes. Status is `succeeded`, `partial` or `failed`
  with counts. Provider error bodies are never stored, only a `SyncErrorCode`.
- **Fail closed**: any resolution failure (computed-secret error, decryption, chain) ends the run as `COMPUTED_ERROR` before a provider call.
- **Failure handling**: `PROVIDER_AUTH`, `PROVIDER_VALIDATION`, `TARGET_NOT_FOUND` mark the target `needs_attention` and are not retried.
  `PROVIDER_RATE_LIMIT`, `PROVIDER_ERROR`, `TIMEOUT` set `next_retry_at` (exponential backoff 30 s x 2^(n-1), capped at 15 min, jittered,
  max 5 attempts). The engine only sets it; the scheduler that acts on it is M4.
- **Audit**: `secret.read_bulk` (environment) for every read, `sync.run.started|succeeded|failed` (run id only). `actorType` is `user` for a
  manual run with an actor, otherwise `system`.
- Deleting an integration connection cascades to its targets, ledger and runs.
