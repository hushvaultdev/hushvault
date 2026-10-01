# HushVault REST API

Reference for the HTTP API served by the Worker in `apps/api`. Everything here is derived from the route
source (`apps/api/src/routes/*.ts`), `middleware/auth.ts`, `middleware/rate-limit.ts` and `lib/*.ts`. If the
code and this file disagree, the code wins; please fix the doc.

HushVault is pre-release. Details marked **(may change)** are implementation details that are being worked on
and should not be relied on.

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Roles](#roles)
- [Rate limits](#rate-limits)
- Endpoints: [Auth](#auth) | [Projects](#projects) | [Environments](#environments) | [Secrets](#secrets) | [Share links](#share-links) | [Audit](#audit) | [Secret-scanner callback](#secret-scanner-callback) | [Health](#health)
- [Audit actions](#audit-actions)
- [Known inconsistencies](#known-inconsistencies)

## Conventions

Base URL: your Worker (for example `http://localhost:8787` under `wrangler dev`). Examples below use
`$HUSHVAULT_API_URL` and `$TOKEN` placeholders; never paste real tokens into shell history or docs.

Request and response bodies are JSON.

```jsonc
// success
{ "data": ... }                       // lists may add siblings: "total", "nextCursor"
// error
{ "error": "NOT_FOUND", "message": "Secret not found" }
```

Error codes are SCREAMING_SNAKE_CASE. Codes used by the routes: `UNAUTHORIZED` (401), `FORBIDDEN` (403),
`PLAN_UPGRADE_REQUIRED` (403), `NOT_FOUND` (404), `CONFLICT` (409), `VALIDATION_ERROR` (400),
`PAYLOAD_TOO_LARGE` (413), `INVALID_ENVIRONMENT_CHAIN` (422), `COMPUTED_SECRET_ERROR` (422),
`RATE_LIMIT_EXCEEDED` (429), `INTERNAL_ERROR` / `DECRYPTION_FAILED` (500), `NOT_IMPLEMENTED` (501),
`OAUTH_NOT_CONFIGURED` (503). Error messages never contain secret values.

One response does not follow this shape: an unknown path returns `404 {"error":"Not found"}` (no `message`).
Unhandled exceptions return a generic 500 that never exposes internals; at the time of writing the work-in-progress
code returns `{"error":"INTERNAL_ERROR","message":"Something went wrong","requestId":"..."}` (older builds returned
`{"error":"Internal server error"}`). **(may change)**

Request-body validation: routes that use the Zod validator without a custom hook (auth, projects,
environments, share, audit) return the validator's default 400 body (a Zod failure object, not
`{error,message}`). Secrets routes use a hook and return `400 VALIDATION_ERROR` with the first issue message.
Clients should treat any 400 as "invalid input".

IDs are prefixed random strings: `usr_`, `org_`, `prj_`, `env_`, `sec_`, `sech_` (history), `key_`, `sh_`,
`tok_`, `audit_`.

CORS (`/api/*`): allowed origins are `https://hushvault.com`, `https://hushvault.com`,
`https://beta.hushvault.com`, plus `http://localhost:3000` and `http://127.0.0.1:3000` when the deployment's
`ENVIRONMENT` is not `production` **(may change)**; allowed headers are
`Content-Type` and `Authorization`. The CLI and curl are not subject to CORS.

## Authentication

Send `Authorization: Bearer <token>` where the token is either:

1. **A JWT** from `POST /api/auth/login`, `POST /api/auth/register` or the OAuth callback. HS256, issuer
   `hushvault`, audience `hushvault-api`, valid for 7 days. The `role` and `orgId` are baked into the token at
   issue time and are not re-read from the database per request.
2. **An API key** (`hv_live_...`) from `POST /api/auth/api-keys`. Only a SHA-256 hash is stored. The key acts as
   its owner, with the org and role of the owner's earliest membership, looked up on each request. Revoked or
   expired keys get `401`.

Missing/invalid credentials: `401 UNAUTHORIZED` (`Authentication required`, `Invalid credentials`, or
`API key expired`). Endpoints without "Auth" below need no token.

## Roles

Roles are hierarchical: `viewer < member < admin < owner`. Insufficient role returns
`403 FORBIDDEN` (`You do not have permission to perform this action`). Every query is scoped to the caller's
`orgId`; resources of other organisations return `404`.

| Capability | viewer | member | admin | owner |
|------------|:------:|:------:|:-----:|:-----:|
| List/get projects, list environments | yes | yes | yes | yes |
| Read secrets (list names, get decrypted value, `resolved?values=true`) | yes | yes | yes | yes |
| Create/update/delete secrets | no | yes | yes | yes |
| Create share links | no | yes | yes | yes |
| Create/update/delete projects | no | no | yes | yes |
| Create environments | no | no | yes | yes |
| Set audit retention (`PUT /api/audit/retention`) | no | no | yes | yes |
| Read audit log, retention, export | yes | yes | yes | yes |
| Manage own API keys | yes | yes | yes | yes |

Notes: viewers can read plaintext secret values. Audit read endpoints have no role gate (export is gated by
plan instead, see below). Registration creates the user as `owner` of a new organisation. There are no
endpoints yet for inviting members or changing roles.

## Rate limits

Per-client-IP fixed 60-second windows (identity: `cf-connecting-ip`, falling back to `x-forwarded-for`; the
counter's backing store is being reworked). Limits stack: every `/api/*` request counts against `global-api`, plus the route scope.
CORS preflight (`OPTIONS`) skips the global limit. **(may change: limits and internals are being reworked)**

| Scope | Applies to | Limit / min |
|-------|------------|-------------|
| `global-api` | all `/api/*` | 600 |
| `auth-login` | `POST /api/auth/login` | 10 |
| `auth-register` | `POST /api/auth/register` | 5 |
| `auth-oauth` | `GET /api/auth/{github,google}` and `.../callback` | 20 |
| `secret-read` | `GET /api/secrets`, `GET /api/secrets/:name`, `GET /api/environments/:id/resolved` | 120 |
| `secret-write` | `POST/PATCH/DELETE /api/secrets` | 60 |
| `share-access` | `GET /api/share/:token` | 20 |

Rate-limited responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`. When exceeded:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 23
X-RateLimit-Remaining: 0

{"error":"RATE_LIMIT_EXCEEDED","message":"Too many requests. Please slow down and try again shortly.","resetAt":"2026-01-01T00:00:00.000Z"}
```

---

## Auth

Prefix `/api/auth`.

### POST /api/auth/register

No auth. Scope `auth-register`.

Body: `email` (email, max 254), `password` (12-128 chars), `organisationName` (2-120 chars).

`201` `{ "data": { "userId", "orgId", "token" } }`. The user is created as `owner` of a new organisation on the
`free` plan, with `email_verified = 0` (no verification flow exists yet). Errors: `409 CONFLICT`
(`Email is already registered`), `400` validation.

```bash
curl -X POST "$HUSHVAULT_API_URL/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"<at-least-12-chars>","organisationName":"Acme"}'
```

### POST /api/auth/login

No auth. Scope `auth-login`. Body: `email`, `password` (1-128).

`200` `{ "data": { "token", "userId", "orgId", "role" } }`. Uses the user's earliest membership. Errors:
`401 UNAUTHORIZED` (`Invalid credentials`; also returned for unknown emails and OAuth-only accounts, with the
same PBKDF2 cost to avoid timing leaks; `Membership not found` if the user has no membership).

```bash
curl -X POST "$HUSHVAULT_API_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"<password>"}'
```

### POST /api/auth/api-keys

Auth (any role). Body: `name` (2-80), `expiresAt` (optional ISO-8601 datetime, must be in the future).

`201` `{ "data": { "id", "apiKey", "name", "expiresAt" } }`. `apiKey` is shown exactly once. Errors:
`400 VALIDATION_ERROR` (`expiresAt must be in the future`).

```bash
curl -X POST "$HUSHVAULT_API_URL/api/auth/api-keys" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"ci-deploy","expiresAt":"2027-01-01T00:00:00.000Z"}'
```

### GET /api/auth/api-keys

Auth (any role). Lists the caller's own keys, newest first; never returns raw keys or hashes.

`200` `{ "data": [ { "id", "name", "createdAt", "lastUsedAt", "expiresAt", "revokedAt" } ] }` (camelCase,
ISO strings or `null`).

### DELETE /api/auth/api-keys/:id

Auth (any role). Deletes one of the caller's own keys. `200` `{ "data": { "revoked": true } }`. `404 NOT_FOUND`
(`API key not found`) if it does not exist or belongs to someone else. (The row is deleted; keys revoked by
the secret scanner are soft-revoked instead.)

### OAuth sign-in (GitHub and Google)

These are browser redirect flows for the web dashboard; they do not return JSON on the happy path. Scope
`auth-oauth`.

- `GET /api/auth/github` and `GET /api/auth/google`: `302` to the provider's authorize URL with a signed
  `state`. If the provider's client id/secret are not configured: `503 OAUTH_NOT_CONFIGURED`
  (`GitHub sign-in is not configured` / `Google sign-in is not configured`).
- `GET /api/auth/github/callback` and `GET /api/auth/google/callback` (query `code`, `state`): always respond
  `302` to `{WEB_APP_URL}/auth/callback#...` (`WEB_APP_URL` defaults to `http://localhost:3000`), except the
  `503` above when unconfigured. The session is handed over in the URL **fragment**, never in cookies or query
  strings.

Success fragment: `#token=<jwt>&userId=...&orgId=...&role=...`.

Failure fragment: `#error=<code>`, where code is one of:

| `error=` | Meaning |
|----------|---------|
| `github_denied` / `google_denied` | User cancelled at the provider |
| `invalid_state` | Missing `code`/`state`, or `state` failed verification |
| `exchange_failed` | Provider code exchange failed (also other provider error codes on Google) |
| `no_verified_email` | Provider returned no verified email |
| `account_exists_unverified` | An unverified password account already uses that email; HushVault refuses to link or log in (anti pre-account-takeover). An `auth.oauth.link_refused` audit event is written. |
| `membership_missing` | The matched user has no organisation membership |

Account matching: by provider identity first; otherwise by email if that account is verified (the provider is
then linked); otherwise a new user and organisation (`<name>'s workspace`, `owner`) are created with
`email_verified = 1`.

### POST /api/auth/github-oidc

Not implemented. Always `501 NOT_IMPLEMENTED`.

---

## Projects

Prefix `/api/projects`. All routes require auth.

| Method | Path | Min role | Body | Success |
|--------|------|----------|------|---------|
| GET | `/` | viewer | none | `200` `{data: [ {id,name,slug,description,created_at,updated_at} ]}` newest first |
| POST | `/` | admin | `name` (2-120), `slug?` (2-80), `description?` (max 500) | `201` `{data:{id,name,slug,description}}` |
| GET | `/:id` | viewer | none | `200` `{data:{id,name,slug,description,created_at,updated_at}}` |
| PATCH | `/:id` | admin | `name?`, `slug?`, `description?` (string or `null` to clear) | `200` `{data:{id,name,slug,description}}` |
| DELETE | `/:id` | admin | none | `200` `{data:{deleted:true}}` |

- Slugs are normalised to lowercase `a-z0-9-` (max 80). If `slug` is omitted it is derived from `name`. A slug
  that normalises to empty falls back to a generated one on create and to the current slug on update.
- Errors: `404 NOT_FOUND` (`Project not found`), `409 CONFLICT` (`A project with this slug already exists`;
  slugs are unique per organisation).
- DELETE cascades to environments, secrets and history rows in D1, then deletes the matching KV blobs
  (`secret:{id}`, `secrethist:{historyId}`) on a best-effort basis.

```bash
curl -X POST "$HUSHVAULT_API_URL/api/projects" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"My App"}'
```

---

## Environments

Prefix `/api/environments`. All routes require auth. There is no endpoint to update or delete an environment
yet.

### GET /api/environments

Min role viewer. Optional query `projectId`. `200` `{ "data": [ {id,project_id,name,slug,parent_env_id,color,created_at} ] }`
for all environments in the caller's organisation (filtered by project when given), newest first.

### POST /api/environments

Min role **admin**. Body:

| Field | Rules |
|-------|-------|
| `projectId` | required, must belong to the caller's org |
| `name` | 2-80 |
| `slug` | optional, 2-80; derived from `name` if omitted; normalised like project slugs |
| `parentEnvId` | optional; must be an environment in the same project (branch inheritance) |
| `color` | optional hex colour `#rgb` or `#rrggbb`; default `#6366f1` |

`201` `{ "data": { id, projectId, name, slug, parentEnvId, color } }`. Errors: `404 NOT_FOUND` (`Project not
found`), `400 VALIDATION_ERROR` (`Parent environment not found`), `409 CONFLICT` (slug already exists in the
project).

### GET /api/environments/:id/resolved

Min role viewer. Scope `secret-read`. Returns the secrets of an environment with branch inheritance applied.

Query: `values=true` to include values (any other value, or omitted, returns metadata only).

Inheritance: the chain is the environment plus its ancestors via `parentEnvId` (all must be in the same
project; max depth 10). For each secret **name**, the definition from the environment closest to the requested
one wins. Results are sorted by name.

`200`:

```json
{
  "data": {
    "environmentId": "env_...",
    "values": true,
    "secrets": [
      { "id": "sec_...", "name": "DATABASE_URL", "isComputed": true,
        "template": "postgres://${DB_USER}:${DB_PASS}@db.internal/app",
        "inheritedFrom": null, "value": "postgres://app:...@db.internal/app" }
    ]
  }
}
```

- `inheritedFrom` is `null` when the secret is defined in the requested environment, else the id of the
  ancestor environment that supplied it.
- `value` is present only when `values=true`. Without it nothing is decrypted and no audit event is written.
  With it, an `secret.read_bulk` audit event is written.

Computed secrets (`isComputed: true`): `template` may contain `${NAME}` placeholders (`NAME` must match
`[A-Za-z_][A-Za-z0-9_]*`). Each is replaced by the final value of the secret with that name in the **resolved**
set (so inheritance applies and placeholders can reference computed secrets, evaluated recursively). All
secrets in the resolved set are evaluated; one broken computed secret fails the whole request. Limits: 64
levels of nesting, 262,144 characters per value.

Errors:

| Status | Code | When |
|--------|------|------|
| 404 | `NOT_FOUND` | Environment not found in the caller's org |
| 422 | `INVALID_ENVIRONMENT_CHAIN` | Parent chain is circular, deeper than 10, or points outside the project |
| 422 | `COMPUTED_SECRET_ERROR` | (`values=true` only) circular reference, reference to a missing secret, invalid placeholder name, too deep, or too large. The message names secrets, never values. |
| 500 | `DECRYPTION_FAILED` | (`values=true` only) a blob is missing or cannot be decrypted |

```bash
curl "$HUSHVAULT_API_URL/api/environments/$ENV_ID/resolved?values=true" -H "Authorization: Bearer $TOKEN"
```

---

## Secrets

Prefix `/api/secrets`. All routes require auth.

Secret names must match `^[A-Za-z_][A-Za-z0-9_]*$` and be 1-128 characters (they become environment variable
names). Values (and templates) are limited to 65,536 bytes (UTF-8); larger returns
`400 VALIDATION_ERROR` (`Secret value exceeds 64KB limit`). Values are envelope-encrypted (see
[ENCRYPTION.md](ENCRYPTION.md)); the API never returns a stored value except through the read endpoints below.

| Method | Path | Min role | Scope | Success |
|--------|------|----------|-------|---------|
| GET | `/?envId=` or `/?projectId=` | viewer | secret-read | `200` `{data: [ {id,project_id,env_id,name,is_computed,template,created_at,updated_at} ]}`, no values |
| GET | `/:name?envId=` | viewer | secret-read | `200` `{data:{id,name,envId,projectId,value,isComputed,template}}` |
| POST | `/` | member | secret-write | `201` `{data:{id,name,projectId,envId,isComputed,template}}` |
| PATCH | `/:id` | member | secret-write | `200` `{data:{id,name,isComputed,template}}` |
| DELETE | `/:id` | member | secret-write | `200` `{data:{deleted:true}}` |

Details:

- **List**: requires `envId` or `projectId` (else `400 VALIDATION_ERROR`, `envId or projectId is required`).
  Lists the secrets defined directly in that scope (no inheritance); use `/resolved` for inheritance.
  `is_computed` is `0`/`1`.
- **Get**: looks up the named secret in exactly that environment (no inheritance, computed templates are not
  evaluated; `value` is the stored value, or the template text for computed secrets). Requires `envId`
  (`400`). `404 NOT_FOUND` (`Secret not found` / `Secret value not found`), `500 DECRYPTION_FAILED`. Writes a
  `secret.read` audit event.
- **Create** body: `projectId`, `envId`, `name`, and at least one of `value` / `template`; optional
  `isComputed` (boolean). If `value` is absent, `template` is stored as the encrypted value. Errors:
  `404 NOT_FOUND` (`Project not found` / `Environment not found`), `409 CONFLICT`
  (`A secret with this name already exists in this environment`), `400`.
- **Update** body: any of `name`, `value`, `isComputed`, `template` (at least one; `projectId`/`envId` cannot
  change). Re-encryption (new DEK) happens only when new plaintext is supplied (`value`, or `template` on a
  computed secret). When a value is replaced, the previous encrypted blob is kept as history (KV
  `secrethist:{historyId}`, D1 `secret_history`). Renames or flag changes alone do not touch the stored value.
  Errors: `404`, `409` on a name clash.
- **History**: recorded as described above, but there is currently **no API endpoint to list or restore
  versions**.
- **Delete** removes the secret, its history rows and the KV blobs.

```bash
# create
curl -X POST "$HUSHVAULT_API_URL/api/secrets" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"prj_...","envId":"env_...","name":"DATABASE_URL","value":"<value>"}'

# computed
curl -X POST "$HUSHVAULT_API_URL/api/secrets" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"projectId":"prj_...","envId":"env_...","name":"DSN","isComputed":true,"template":"${DB_USER}@${DB_HOST}"}'

# read one (single quotes keep the shell from touching anything)
curl "$HUSHVAULT_API_URL/api/secrets/DATABASE_URL?envId=env_..." -H "Authorization: Bearer $TOKEN"
```

---

## Share links

Prefix `/api/share`. The client encrypts the value itself (the CLI uses AES-256-GCM with a one-time key) and
uploads only the ciphertext; the key travels in the URL fragment and never reaches the server. The server
cannot decrypt the payload. **(may change: share endpoint details are being worked on; the shape below is the
stable contract.)**

### POST /api/share

Auth, min role member. Body:

| Field | Rules |
|-------|-------|
| `encryptedPayload` | required string, 1-65,536 chars |
| `expiresAt` | optional ISO-8601 datetime; default 1 hour from now. Must be in the future; the current work-in-progress code also caps it at 7 days (`400 VALIDATION_ERROR`) **(may change)** |
| `maxViews` | optional integer 1-100; default 1 |

`201` `{ "data": { "token": "tok_...", "url": "<web-base>/share/tok_..." } }` (`<web-base>` is the dashboard's base URL; deployment-configured). The `url` has no key
fragment; the client appends `#<key>`. Writes a `share.create` audit event.

```bash
curl -X POST "$HUSHVAULT_API_URL/api/share" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"encryptedPayload":"<base64url-ciphertext>","maxViews":1,"expiresAt":"2027-01-01T00:00:00.000Z"}'
```

### GET /api/share/:token

No auth. Scope `share-access`. `200` `{ "data": { "encryptedPayload": "..." } }` and the view counter is
incremented. `404 NOT_FOUND` (`Share link not found`) for unknown tokens, and (`Share link unavailable`) once
expired or `maxViews` has been reached.

---

## Audit

Prefix `/api/audit`. All routes require auth; reads have no minimum role. All queries are scoped to the
caller's organisation and to its retention window (older rows are never returned).

Retention by plan: `free` 7 days, `pro` 90, `team` 365, `enterprise` unlimited; unknown plans are treated as 7.
An organisation can set a shorter override. New organisations are on `free`; there is no billing, so
plan changes are manual today.

Rows use the raw column names (snake_case): `id, org_id, actor_id, actor_type, action, resource_type,
resource_id, ip, user_agent, timestamp`. `actor_type` is `user`, `api_key` or `system`.

### GET /api/audit

Query (all optional): `from`, `to` (ISO datetimes), `action` (max 64), `actorId` (max 128), `cursor` (max 64).

`200` `{ "data": [rows], "nextCursor": "<last id>" | null, "total": <count> }`. Page size is 100, newest
first. Pass `nextCursor` as `cursor` for the next page (an unknown cursor is ignored and returns the first
page). `total` is the count for the filters before pagination.

```bash
curl "$HUSHVAULT_API_URL/api/audit?action=secret.read&from=2026-01-01T00:00:00.000Z" -H "Authorization: Bearer $TOKEN"
```

### GET /api/audit/export

Compliance export, **Team and Enterprise plans only** (`403 PLAN_UPGRADE_REQUIRED` otherwise). Query: the same
filters as the list (no `cursor`) plus `format` = `json` (default) or `csv`. At most 50,000 rows, newest first.

- `json`: `Content-Type: application/json`, attachment `audit-log-YYYY-MM-DD.json`,
  body `{ "data": [rows], "total": n, "exportedAt": "..." }`.
- `csv`: `text/csv; charset=utf-8`, attachment `audit-log-YYYY-MM-DD.csv`, CRLF line endings, header
  `id,timestamp,action,actor_id,actor_type,resource_type,resource_id,ip,user_agent`. Fields beginning with
  `= + - @` tab or CR get a leading `'` (spreadsheet formula-injection guard).

### GET /api/audit/retention

`200` `{ "data": { "plan", "planMaxDays", "overrideDays", "effectiveDays" } }` (`-1` means unlimited).

### PUT /api/audit/retention

Min role **admin** (checked in the handler; others get `403 FORBIDDEN` `Insufficient permissions`). Body:
`{ "overrideDays": <integer 1-3650> | null }`; `null` clears the override. A value above the plan maximum is
rejected with `400 VALIDATION_ERROR`. Returns the same shape as GET.

---

## Secret-scanner callback

### POST /api/integrations/secret-scanner/github

GitHub secret-scanning partner callback. **No bearer auth.** Authenticity comes from GitHub's ECDSA P-256
signature over the raw body, in headers `GITHUB-PUBLIC-KEY-IDENTIFIER` and `GITHUB-PUBLIC-KEY-SIGNATURE`,
verified against GitHub's published public keys. Still subject to the global rate limit.

Body: JSON array of `{ "token", "type", "url"?, "source"? }` (max 1000). For each token HushVault hashes it and
looks for a matching API key. A match is revoked (reason `leaked_in_github`), an `auth.api_key.revoke` system
audit event and a `notify.api_key_revoked` audit event are written (the notification is an audit-log stub today; no email or Slack is sent).

`200` JSON array of `{ "token_raw", "token_type", "label" }` with `label` `true_positive` (a HushVault key,
newly or previously revoked) or `false_positive` (unknown token). Malformed entries are skipped.

Errors: `401 UNAUTHORIZED` (`Missing signature headers`, `Unknown signing key`, `Invalid signature`),
`400 VALIDATION_ERROR` (body not an array), `413 PAYLOAD_TOO_LARGE`.

---

## Health

- `GET /health` (no auth, not under `/api`, so the global limiter does not apply): `200`
  `{ "status": "ok", "version": "0.0.1" }`, or `503 { "status": "degraded", "reason": "database" }` if D1 is
  unreachable. Note: this is not the `{data}` envelope.
- `GET /`: `200 { "name": "HushVault API", "version": "0.0.1", "status": "ok" }`.
- `GET /.well-known/security.txt`: plain-text security contact.

---

## Audit actions

Written by the API today: `auth.login`, `auth.login.github`, `auth.login.google`, `auth.api_key.create`,
`auth.api_key.revoke`, `auth.oauth.link_refused`, `notify.api_key_revoked`, `project.create`, `project.update`, `project.delete`,
`environment.create`, `secret.read`, `secret.read_bulk`, `secret.create`, `secret.update`, `secret.delete`,
`share.create`. Not audited: registration, listing endpoints, share views.

## Known inconsistencies

These are real quirks of the current API, documented rather than hidden:

- **snake_case vs camelCase.** List and get-by-id rows for projects, environments, secrets and audit entries
  are raw database rows in snake_case (`project_id`, `parent_env_id`, `is_computed`, `created_at`). Create,
  update, resolved and single-secret responses are camelCase (`projectId`, `parentEnvId`, `isComputed`).
  `GET /api/auth/api-keys` is camelCase even though it is a list. Audit rows are snake_case on purpose to
  match the dashboard.
- **`is_computed`** is `0`/`1` in snake_case rows and a boolean elsewhere.
- **Validation error shape** differs between routes (see [Conventions](#conventions)); the unknown-path 404
  has no `message`.
- **`PUT /api/audit/retention`** checks the role inline and returns `Insufficient permissions`, a different
  message from `requireRole`. On the `enterprise` plan (unlimited, internally `-1`) any numeric override is
  currently rejected as exceeding the plan limit; use `null`.
- **API-key DELETE** removes the row, while the scanner soft-revokes (`revoked_at`); `revokedAt` in the list
  is therefore only set for scanner-revoked keys.
- **Secret history** is recorded but not readable through the API.
- **Roles in JWTs** are fixed at issue time (7 days); a role change does not affect existing JWTs.
- **`GET /api/secrets/:name`** takes a name while PATCH/DELETE take an id.
