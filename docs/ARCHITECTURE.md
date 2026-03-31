# HushVault Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────┐
│                    CLIENTS                               │
│  CLI (npm: hushvault)  │  Dashboard (Next.js)  │  CI/CD  │
│  OS Keychain (keytar)  │  Browser session       │  GH Action │
└──────────────┬─────────────────────────────────────────┘
               │ HTTPS
               ▼
┌─────────────────────────────────────────────────────────┐
│              HONO API (Cloudflare Workers)               │
│  Auth middleware (JWT)                                   │
│  /api/auth     /api/projects    /api/environments        │
│  /api/secrets  /api/share                                │
└──────┬───────────────────────────┬──────────────────────┘
       │                           │
       ▼                           ▼
┌─────────────┐           ┌─────────────────────┐
│ Cloudflare  │           │   Cloudflare KV      │
│    D1       │           │   (SECRETS_KV)       │
│  (metadata) │           │  Encrypted blobs     │
│  - users    │           │  key: secret:{id}    │
│  - projects │           │  val: {              │
│  - envs     │           │    encryptedValue,   │
│  - secrets  │           │    wrappedDek        │
│    (no val) │           │  }                   │
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

- `wrappedDek` stored in D1 (alongside secret metadata)
- `encryptedValue` stored in KV
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
1. Walk tree from current env to root, collecting all secrets
2. Child values override parent values for the same key
3. Return merged map

## Computed Secrets

Stored with `isComputed = true`, `template = "${DB_USER}:${DB_PASS}@host"`, `dependencies = ["DB_USER", "DB_PASS"]`.

Resolution: fetch all dependency secrets, substitute `${KEY}` placeholders.
Executed client-side (CLI) to preserve zero-knowledge property.

## Zero-Knowledge Share Links

```
Client generates:  shareKey = random AES-256 key
Encrypts value with shareKey → ciphertext
Sends to API:      POST /api/share { ciphertext }
API stores:        ciphertext in D1, returns slug
URL returned:      https://hushvault.dev/share/{slug}#{base64(shareKey)}

Recipient opens URL:
  1. Fragment never sent to server
  2. Browser JS extracts shareKey from fragment
  3. Fetches ciphertext from API using slug
  4. Decrypts locally with shareKey
```

## API Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | /api/auth/login | No | Email/password → JWT |
| POST | /api/auth/register | No | Create account |
| GET | /api/projects | JWT | List user's projects |
| POST | /api/projects | JWT | Create project |
| GET | /api/projects/:id/environments | JWT | List environments |
| GET | /api/environments/:id/secrets | JWT | List secret keys (no values) |
| GET | /api/environments/:id/resolved | JWT | Resolved secrets map (with values) |
| POST | /api/secrets | JWT | Create secret |
| PUT | /api/secrets/:id | JWT | Update secret value |
| DELETE | /api/secrets/:id | JWT | Delete secret |
| POST | /api/share | JWT | Create share link |
| GET | /api/share/:slug | No | Fetch encrypted share payload |

## Data Flow: CLI `hushvault run -- npm dev`

1. CLI reads `.hushvault.json` (project config, walks up dirs)
2. Gets JWT from OS keychain (node-keytar)
3. `GET /api/environments/{envId}/resolved` → encrypted secret map
4. Decrypts each secret value locally
5. Merges with `process.env`
6. Spawns child process with merged env
