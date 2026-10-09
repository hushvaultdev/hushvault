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
`RATE_LIMIT_EXCEEDED` (429), `INTERNAL_ERROR` / `DECRYPTION_FAILED` (500),
`OAUTH_NOT_CONFIGURED` (503). Multi-org adds `NOT_A_MEMBER` (403), `MEMBERSHIP_REVOKED` (403 on a normal
request, 401 on refresh), `KEY_ORG_UNRESOLVED` (401), `EMAIL_NOT_VERIFIED` (403), `ALREADY_MEMBER` (409),
`LAST_OWNER` (409) and the invitation codes `INVITE_NOT_FOUND` (404), `INVITE_REVOKED` / `INVITE_EXPIRED` /
`INVITE_ACCEPTED` / `INVITE_EMAIL_MISMATCH` (403). Error messages never contain secret values.

One response does not follow this shape: an unknown path returns `404 {"error":"Not found"}` (no `message`).
Unhandled exceptions return a generic 500 that never exposes internals; at the time of writing the work-in-progress
code returns `{"error":"INTERNAL_ERROR","message":"Something went wrong","requestId":"..."}` (older builds returned
`{"error":"Internal server error"}`). **(may change)**

Request-body validation: routes that use the Zod validator without a custom hook (auth, projects,
environments, share, audit) return the validator's default 400 body (a Zod failure object, not
`{error,message}`). Secrets, organisations, members and invitations use a hook and return
`400 VALIDATION_ERROR` with the first issue message.
Clients should treat any 400 as "invalid input".

IDs are prefixed random strings: `usr_`, `org_`, `mem_`, `inv_`, `prj_`, `env_`, `sec_`, `key_`, `sh_`,
`tok_`, `audit_`.

CORS (`/api/*`): allowed origins are `https://hushvault.dev`, `https://www.hushvault.dev`,
`https://beta.hushvault.dev`, plus `http://localhost:3000` and `http://127.0.0.1:3000` when the deployment's
`ENVIRONMENT` is not `production` **(may change)**; allowed headers are
`Content-Type` and `Authorization`. The CLI and curl are not subject to CORS.

## Authentication

Send `Authorization: Bearer <token>` where the token is either:

1. **A JWT** from `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/refresh` or the OAuth
   callback. HS256, issuer `hushvault`, audience `hushvault-api`, valid for **15 minutes** (`expiresIn: 900`).
   The `role` and `orgId` are baked in at issue time and re-read at each refresh, so a membership change reaches
   the session within one access lifetime. Renew it with a refresh token (see
   [Sessions and refresh tokens](#sessions-and-refresh-tokens)).
2. **An API key** (`hv_live_...`) from `POST /api/auth/api-keys`. Only a SHA-256 hash is stored. The key acts
   as its owner **in the organisation it was created in** (`api_keys.org_id`), with the role that owner has in
   *that* organisation, re-read on each request. Nothing is derived from the owner's other memberships, so a key
   never follows its owner into another org. Revoked or expired keys get `401`.

Missing/invalid credentials: `401 UNAUTHORIZED` (`Authentication required`, `Invalid credentials`, or
`API key expired`). A key that is otherwise valid but has no usable organisation — its `org_id` is `NULL`
(created before migration `0018`), or its owner is no longer a member of that organisation — gets
`401 KEY_ORG_UNRESOLVED` (`This API key has no usable organisation. Create a new key.`). It is deliberately
distinct from `Invalid credentials` so an operator can tell "re-create this key" from "this key is not ours".
Endpoints without "Auth" below need no token.

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
| Revoke a share link (`DELETE /api/share/:id`) | no | yes | yes | yes |
| Create/update/delete projects | no | no | yes | yes |
| Create environments | no | no | yes | yes |
| Set audit retention (`PUT /api/audit/retention`) | no | no | yes* | yes* |
| List the organisation's live share links (`GET /api/share`) | no | no | yes | yes |
| Read audit log, retention, export | no | no | yes | yes |
| Manage own API keys | yes* | yes* | yes* | yes* |

`*` These routes additionally require a **signed-in person**: an API key is refused with `403`.
That covers API-key creation and deletion (a credential must not be able to mint another
credential, or the leaked-key revocation path can be defeated), audit-retention changes, and
every integrations and CI-access route. Audit-retention changes also re-read the caller's
membership per request, so a just-demoted admin loses the lever immediately rather than at the
end of their token's lifetime.

A user may belong to several organisations, with a different role in each. A credential names the
organisation it acts in and never re-derives one: see [Organisations](#organisations). Registration creates the
user as `owner` of a new organisation, and `POST /api/orgs` creates further ones. There are still **no
endpoints for inviting members or changing roles** (issue #82 Lane B), so the only way into a second
organisation today is to create it — but a credential's organisation is now fixed rather than inferred, which
is what makes a second membership safe to add.

Notes: viewers can read plaintext secret values — this is deliberate, and worth knowing before
granting the role. Audit reads are admin-only: the trail carries every member's IP, user agent
and secret-read history, and the export can stream 50,000 rows per call.

## Rate limits

Fixed 60-second windows. The client identity is **only** `cf-connecting-ip` (set by Cloudflare's
edge); `x-forwarded-for` is caller-controlled and is never used, so a request arriving without
`cf-connecting-ip` shares one bucket with every other such request. Some scopes are keyed per
organisation instead, which the table states per row. Limits stack: every `/api/*` request counts
against `global-api`, plus the route scope. CORS preflight (`OPTIONS`) skips the global limit.

A window is aligned to the clock, so a caller can obtain up to 2× the limit across a boundary.

| Scope | Applies to | Keyed on | Limit / min | On limiter outage |
|-------|------------|----------|-------------|-------------------|
| `global-api` | all `/api/*` | IP | 600 | degrades to a per-isolate counter |
| `auth-login` | `POST /api/auth/login` | IP | 10 | 503 |
| `auth-register` | `POST /api/auth/register` | IP | 5 | 503 |
| `auth-oauth` | `GET /api/auth/{github,google}` and `.../callback` | IP | 20 | 503 |
| `auth-refresh` | `POST /api/auth/{refresh,logout}` | IP | 60 | 503 |
| `auth-forgot` | `POST /api/auth/forgot-password`, verification resend | IP | 5 | 503 |
| `auth-token-submit` | `POST /api/auth/{verify-email,reset-password}` | IP | 10 | 503 |
| `org-create` | `POST /api/orgs` | IP | 5 | 503 |
| `org-switch` | `POST /api/orgs/:id/switch` | IP | 60 | 503 |
| `invite-create` | `POST /api/orgs/:id/invites` | **organisation** (the one in the path) | 20 | 503 |
| `invite-accept` | `POST /api/invites/accept` | IP | 10 | 503 |
| `member-write` | `PATCH`/`DELETE` `/api/orgs/:id/members/:userId`, `DELETE /api/orgs/:id/invites/:inviteId` | **organisation** (the one in the path) | 30 | 503 |
| `auth-oidc` | `POST /api/auth/github-oidc` | IP | 30 | 503 |
| `secret-read` | `GET /api/secrets`, `GET /api/secrets/:name`, `GET /api/environments/:id/resolved` | IP | 120 | degrades to a per-isolate counter |
| `secret-write` | `POST/PATCH/DELETE /api/secrets` | IP | 60 | degrades to a per-isolate counter |
| `share-access` | `GET /api/share/:token` | IP | 20 | 503 |
| `audit-read` | `GET /api/audit` | IP | 60 | degrades to a per-isolate counter |
| `audit-export` | `GET /api/audit/export` | **organisation** | 6 | degrades to a per-isolate counter |
| `integration-write` | integration and CI-access mutations | **organisation** | 20 | 503 |
| `integration-run` | `POST /api/integrations/targets/:id/run` | **organisation** | 6 | 503 |
| `integration-preview` | `POST /api/integrations/targets/:id/preview` | **organisation** | 12 | 503 |

The secret and global scopes deliberately do not fail closed: a 503 there would stop every CI
deploy worldwide during a limiter outage, and a rate limit is not what contains a stolen
credential (revocation and the audit row are). They fall back to a per-isolate counter instead,
which is weak but finite.

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

`201` `{ "data": { "userId", "orgId", "token", "expiresIn", "emailVerified", "orgs" } }` (plus `refreshToken`
for `X-HushVault-Client: cli`). `orgs` is the same list as [`GET /api/orgs`](#get-apiorgs) — one entry here, by
construction — so the dashboard's org switcher needs no second round trip. The user is created as `owner` of a
new organisation on the `free` plan, with `email_verified = 0`; a verification email is sent in the background (see
[Email verification and password reset](#email-verification-and-password-reset)). Errors: `409 CONFLICT`
(`Email is already registered`), `400` validation.

```bash
curl -X POST "$HUSHVAULT_API_URL/api/auth/register" -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"<at-least-12-chars>","organisationName":"Acme"}'
```

### POST /api/auth/login

No auth. Scope `auth-login`. Body: `email`, `password` (1-128).

`200` `{ "data": { "token", "expiresIn", "userId", "orgId", "role", "emailVerified", "orgs" } }` (plus
`refreshToken` for `X-HushVault-Client: cli`). The starting organisation is the caller's **earliest
membership**, chosen once here; the session then carries it and nothing re-derives it. `orgs` lists every
organisation the caller belongs to, so the dashboard can offer a switch immediately. Errors:
`401 UNAUTHORIZED` (`Invalid credentials`; also returned for unknown emails and OAuth-only accounts, with the
same PBKDF2 cost to avoid timing leaks; `Membership not found` if the user has no membership).

```bash
curl -X POST "$HUSHVAULT_API_URL/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"dev@example.com","password":"<password>"}'
```

### POST /api/auth/api-keys

Auth (any role). Body: `name` (2-80), `expiresAt` (optional ISO-8601 datetime, must be in the future).

`201` `{ "data": { "id", "apiKey", "name", "orgId", "expiresAt" } }`. `apiKey` is shown exactly once. The key
is bound to `orgId` — the organisation the creating session is acting in — for the rest of its life. To get a
key for another organisation, [switch](#post-apiorgsidswitch) first and create it there. Errors:
`400 VALIDATION_ERROR` (`expiresAt must be in the future`).

```bash
curl -X POST "$HUSHVAULT_API_URL/api/auth/api-keys" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"name":"ci-deploy","expiresAt":"2027-01-01T00:00:00.000Z"}'
```

### GET /api/auth/api-keys

Auth (any role). Lists the caller's own keys, newest first; never returns raw keys or hashes.

`200` `{ "data": [ { "id", "name", "orgId", "createdAt", "lastUsedAt", "expiresAt", "revokedAt" } ] }`
(camelCase, ISO strings or `null`). The list is the caller's own keys across **every** organisation they have
one in, not only the current one — they are the caller's own credentials, and a key whose `orgId` is `null`
(pre-`0018`) no longer authenticates and has to be findable in order to be replaced.

### DELETE /api/auth/api-keys/:id

Auth (any role). Deletes one of the caller's own keys. `200` `{ "data": { "revoked": true } }`. `404 NOT_FOUND`
(`API key not found`) if it does not exist or belongs to someone else. (The row is deleted; keys revoked by
the secret scanner are soft-revoked instead.) The `auth.api_key.revoke` audit row is written against the
**key's** organisation, not the caller's current one.

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

Success fragment: `#token=<jwt>&userId=...&orgId=...&role=...` (the refresh cookie is set on the redirect). The flow start sets an
`HttpOnly` cookie holding a PKCE verifier and sends a `code_challenge` (S256); the callback only proceeds if the
state matches that cookie, so a callback URL replayed in another browser (login CSRF) is `invalid_state`.

Failure fragment: `#error=<code>`, where code is one of:

| `error=` | Meaning |
|----------|---------|
| `github_denied` / `google_denied` | User cancelled at the provider |
| `invalid_state` | Missing `code`/`state`, or `state` failed verification |
| `exchange_failed` | Provider code exchange failed (also other provider error codes on Google) |
| `no_verified_email` | Provider returned no verified email |
| `membership_missing` | The matched user has no organisation membership |

Account matching: by provider identity first; otherwise by email (the provider is linked); otherwise a new user
and organisation (`<name>'s workspace`, `owner`) are created with `email_verified = 1`.

If the matching account was **unverified** (password sign-up never confirmed), the provider-verified owner claims
it: the password hash is wiped, `email_verified = 1`, all earlier sessions and API keys are invalidated, pending
tokens are deleted, `auth.oauth.account_takeover` is audited, and the success fragment carries
`&notice=account_linked`. This defeats pre-registration account takeover.

### Sessions and refresh tokens

Login, register and the OAuth callback also issue a **refresh token** (256-bit, `hvr_...`, only its SHA-256 is
stored). Browsers get it as an `HttpOnly; Secure; SameSite=Strict` cookie (`__Host-hv_refresh`); the CLI sends
the header `X-HushVault-Client: cli` and receives it as `refreshToken` in the response body. Refresh tokens are
single use and rotate: each refresh returns a new one in the same family. Idle lifetime 30 days, absolute 90 days.
Presenting an already-used token (older than a 10 s race window) is treated as theft and revokes the whole family.

A family is **bound to one organisation** (`refresh_tokens.org_id`) for its whole life: a rotation copies the
organisation from the token it consumes, so a refresh can never move a session to a different org. Changing
organisation is [`POST /api/orgs/:id/switch`](#post-apiorgsidswitch), which revokes the old family and starts a
new one. Only the **role** is re-read on refresh, for that organisation, so a demotion still reaches the
session within one access lifetime (15 min).

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /api/auth/refresh` | cookie + `X-HushVault-Client` header, or body `{ refreshToken }` | `200` same shape as login (including `orgs`). `401 INVALID_REFRESH` (cookie cleared), `401 MEMBERSHIP_REVOKED`, `409 REFRESH_RACE` (another tab rotated first; retry with the new cookie). Limited to 60/min per IP. |
| `POST /api/auth/logout` | cookie or body | Revokes the token's family and clears the cookie. Always `200`. |
| `POST /api/auth/logout-all` | Bearer (user JWT) | Ends every session of the user, including live access tokens. |

The cookie is only honoured with the `X-HushVault-Client` header, which a cross-site form cannot set and a
cross-origin fetch cannot send without a CORS preflight. A password reset, an OAuth account claim and
`logout-all` invalidate every earlier refresh token. API keys are unchanged (long-lived, for CI).

Two fail-closed refresh outcomes carry the organisation story, and neither ever falls back to another org the
caller may still belong to:

- `401 MEMBERSHIP_REVOKED` — the caller is no longer a member of the organisation this family is bound to. The
  family is revoked and the cookie cleared. It is a distinct code so the dashboard can send the person back to
  org selection rather than show them an empty project list.
- `401 INVALID_REFRESH` with `reason: "org_unresolved"` — the family has no organisation recorded, i.e. it was
  minted before migration `0018`. The family is revoked; signing in again is the whole fix. Only sessions
  started in the window between applying `0018` and deploying this code can be in this state.

### GitHub Actions OIDC (CI reads, no stored token)

`POST /api/auth/github-oidc` — no auth; the signed GitHub token is the credential. Body `{ token, envId }`. Limited to
30/min per IP, fail closed. `200 { data: { token, expiresIn: 600, expiresAt, envId, orgId } }`. Errors: one opaque
`401 OIDC_REJECTED` for every verification failure, `403 NOT_ALLOWED` when no rule matches, `503` when GitHub's key set
cannot be fetched, `400 VALIDATION_ERROR`.

The returned token is **read-only and scoped to one environment**: the auth middleware allows it to reach only
`GET /api/environments/<that env>/resolved`, and refuses every other route with `403`.

Rules are managed at `/api/ci-access/github/rules` (JWT only, admin+, membership re-read, audited as `ci.rule.create` /
`ci.rule.delete`):

| Endpoint | Body | Notes |
|---|---|---|
| `GET /api/ci-access/github/rules` | — | Rules for the caller's organisation. |
| `POST /api/ci-access/github/rules` | `{ envId, repository, repositoryId?, ref? \| environment? }` | Exactly one of `ref`/`environment`. `409 CONFLICT` for a duplicate, `404` for another organisation's environment, max 100 per organisation. |
| `DELETE /api/ci-access/github/rules/:id` | — | |

See `docs/integrations/github-oidc.md` for the workflow setup and the unverified items.

### Automatic sync triggers

Targets carry `autoSync: { onChange: boolean, scheduleMinutes: 15 | 60 | 360 | 1440 | null }` (default off) on create and
PATCH (`autoSync` may be partial). Runs started by the cron have `trigger` `change` or `schedule` and carry `nextRetryAt` when a
retry is pending. See `docs/INTEGRATIONS.md` ("Automatic triggers").

### Email verification and password reset

Tokens are 256-bit, stored only as SHA-256 hashes, single use, bound to purpose and email. Links use a URL
fragment (`/verify-email#token=...`, `/reset-password#token=...`), so the token never reaches a server log or
Referer; the web pages POST it. Verification links last 24 h, reset links 60 min. Every token failure is the same
`400 INVALID_TOKEN`.

| Endpoint | Auth | Notes |
|----------|------|-------|
| `POST /api/auth/verify-email/send` | Bearer | Resend the verification mail. Always `202`. Limited per user (1/min, 5/h). |
| `POST /api/auth/verify-email` | none | Body `{ token }`. Marks the email verified. |
| `POST /api/auth/forgot-password` | none | Body `{ email }`. Always an identical `202`, whether or not the account exists; sending runs in the background. Limited per IP (5/min) and per email (3/h). |
| `POST /api/auth/reset-password` | none | Body `{ token, password }` (12-128 chars). Sets the password, marks the email verified, invalidates earlier sessions (JWT `iat` before `users.sessions_valid_after` gets `401`), and sends a "password changed" mail. API keys are revoked only if the account was unverified. |

Configuration: `MAIL_FROM`, the `EMAIL` send_email binding (Cloudflare Email Service; without it mail is not sent
and the flows still return their normal responses), `EMAIL_DAILY_BUDGET` (global sends per day, default 200) and
`REQUIRE_VERIFIED_EMAIL` (when set, API-key creation and share-link creation both require a verified email).


## Organisations

Prefix `/api/orgs`. A user can belong to several organisations with a different role in each. The rule the
whole section rests on: **an organisation is chosen explicitly and then carried by the credential.** An access
token names its org, a refresh-token family is bound to one for its whole life, and an API key names the org it
was created in. Nothing re-derives an organisation from the caller's memberships, so no request can quietly act
in the wrong one.

### GET /api/orgs

Auth (any role, API keys included). Every organisation the caller is a member of, oldest membership first.

`200`
```json
{
  "data": [
    { "id": "org_...", "name": "Acme", "slug": "acme-ab12cd", "plan": "free", "role": "owner", "current": true },
    { "id": "org_...", "name": "Beta", "slug": "beta-ef34gh", "plan": "free", "role": "viewer", "current": false }
  ],
  "currentOrgId": "org_..."
}
```

`current` / `currentOrgId` is the organisation the credential presented on *this* request acts in. This is what
the dashboard's switcher reads.

### POST /api/orgs

Auth, **signed-in person only** (an API key gets `403 FORBIDDEN`: a credential is bound to one organisation and
has no use for another). Scope `org-create`. Honours `REQUIRE_VERIFIED_EMAIL`.

Body: `name` (2-120 chars).

`201` `{ "data": { "id", "name", "slug", "plan": "free", "role": "owner" } }`. The caller becomes `owner`. The
slug is derived from the name with the new id's suffix appended, so two organisations of the same name do not
collide. Audited `org.create` against the new organisation.

The caller's session is **not** moved into the new organisation — that is an explicit call to switch.

Errors: `400 VALIDATION_ERROR`, `403 FORBIDDEN` (API key, or `EMAIL_NOT_VERIFIED` when enforced).

### POST /api/orgs/:id/switch

Auth, **signed-in person only** (`403 FORBIDDEN` for an API key). Scope `org-switch`.

Body: `refreshToken` (optional; CLI only — a browser's refresh token comes from the `__Host-hv_refresh` cookie,
which requires the `X-HushVault-Client` header as everywhere else).

`200` `{ "data": { "token", "expiresIn", "userId", "orgId", "role", "orgs" } }` (plus `refreshToken` for
`X-HushVault-Client: cli` when the token was presented in the body). `role` is read from the membership in the
**target** organisation, never inherited from the current session.

Both halves of the session move: a new access token for the target organisation **and a new refresh-token
family bound to it**. The family the caller came in on is revoked, so no token of it survives pointing at the
old organisation. This matters — if only the access token were re-minted, the next refresh (within 15 minutes)
would silently put the session back in the old organisation. The refresh token presented here is not what
authenticates the request, so the revoke is scoped to the caller's own families.

Audited twice: `org.switch_in` against the target organisation and `org.switch_out` against the one being
left (skipped when they are the same), because an audit log is read per organisation and a session leaving
is otherwise invisible to the admins of the org it left. Both rows name the target org as the resource.

Errors: `403 NOT_A_MEMBER` (`You are not a member of that organisation`) — also the answer for an organisation
id that does not exist, because membership is the only question asked; `403 FORBIDDEN` for an API key.

```bash
curl -X POST "$HUSHVAULT_API_URL/api/orgs/$ORG_ID/switch" \
  -H "Authorization: Bearer $TOKEN" -H 'X-HushVault-Client: cli' \
  -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$REFRESH\"}"
```

### Members and invitations

Issue #82 Lane B. These endpoints name their organisation in the **path**, not through the credential, so two
rules apply to all of them.

**Signed-in people only.** Every endpoint in this subsection is `requireHuman`: an API key gets `403 FORBIDDEN`.
A key is a deployment credential bound to one organisation for life, and a leaked CI key must not be able to
invite a new owner, change a role or send mail from the deployment.

**A non-member gets `404 NOT_FOUND` (`Organisation not found`) — byte for byte the answer for an organisation
id that does not exist.** So `/api/orgs/<guess>/members` cannot be used to discover which organisations exist,
who is in them, or whether an id is real. The one exception discloses nothing new: when the credential
presented *itself* names the organisation (`orgId` in the token) and the membership is gone, the answer is
`403 MEMBERSHIP_REVOKED` — the caller's own token already said which organisation it acts in, and this is the
code the dashboard needs in order to send them to the organisation picker. Note the status: `403` here, while
`POST /api/auth/refresh` answers `401 MEMBERSHIP_REVOKED` with the family revoked. The status is what
distinguishes "pick another organisation" from "sign in again".

Roles below are the caller's role in **the organisation in the path**, re-read from `members` on every request —
so a demotion or a removal takes effect at once rather than within an access token's lifetime.

#### POST /api/orgs/:id/invites

Auth, `admin` of `:id`. Scope `invite-create` (per **organisation**). Honours `REQUIRE_VERIFIED_EMAIL`.

Body: `email` (3–254 chars, must parse as an address; trimmed and **lower-cased** before storage), `role`
(`owner` | `admin` | `member` | `viewer`, default `member`).

`201`
```json
{
  "data": {
    "invite": { "id": "inv_...", "orgId": "org_...", "email": "ann@example.com", "role": "member",
                "createdAt": "2026-10-05T...", "expiresAt": "2026-10-12T...", "invitedBy": "usr_..." },
    "acceptUrl": "https://hushvault.dev/invites/accept#token=...&email=ann%40example.com"
  }
}
```

The token is 256 random bits. Only `base64url(SHA-256(token))` is stored, so nothing can read it back out of
the database. It is returned **once**, in this response, and mailed once — there is no endpoint that will show
it again. `acceptUrl` is `null` when `WEB_APP_URL` is not configured. Handing it to the creating admin grants
them nothing new (they chose the address and could invite it again), and the invitation is bound to that
address, so the link cannot add a different account. Every response carries `Cache-Control: no-store`.

Only an owner may invite an `owner`. The invitation expires in **7 days**.

Audited `org.invite.create` against `:id`; the background send adds `org.invite.sent` (actor `system`). A
failed send does not fail the request — see [OPERATIONS § 6](OPERATIONS.md#6-transactional-email).

Errors: `400 VALIDATION_ERROR`; `403 FORBIDDEN` (not an admin, an API key, inviting an owner as an admin, or
`EMAIL_NOT_VERIFIED` when enforced); `404 NOT_FOUND`; `409 ALREADY_MEMBER` (that address is already in the
organisation); `409 CONFLICT` (an open invitation to that address already exists — revoke it to send a new
one; enforced by the partial unique index `org_invites_open_idx`, which only constrains invitations that are
neither accepted nor revoked).

#### GET /api/orgs/:id/invites

Auth, `admin` of `:id`. The invitations still waiting: not accepted, not revoked, not expired. At most 200.

`200` `{ "data": [ { "id", "email", "role", "created_at", "expires_at", "invited_by" } ], "total": 1 }`
(snake_case, like the other list endpoints).

**Neither the token nor its hash is ever returned**, by this endpoint or any other.

#### DELETE /api/orgs/:id/invites/:inviteId

Auth, `admin` of `:id`. Scope `member-write` (per **organisation**).

`200` `{ "data": { "id", "revokedAt" } }`. A soft revoke: the row keeps saying the invitation happened and who
ended it, and the cron sweep collects it later. Revoking frees the address for a new invitation immediately.
Idempotent — a second DELETE answers `200` and files no second audit row.

Audited `org.invite.revoke` against `:id`, only by the request that actually revoked it.

Errors: `404 NOT_FOUND` (no such invitation **in this organisation** — an id belonging to another organisation
reads the same way); `409 CONFLICT` (already accepted; remove the member instead).

#### POST /api/invites/accept

Auth, **signed-in person only**. Scope `invite-accept` (per IP). Mounted outside `/api/orgs` because the
person redeeming a token is not yet a member of the organisation and must not have to name it.

Body: `token` (16–256 chars).

`201` `{ "data": { "orgId", "orgName", "role", "userId" } }` — `role` is the caller's role in the organisation
**as the membership row now reads**, which is their existing role if they were already a member: accepting an
invitation never re-grades somebody's access (that is `PATCH .../members/:userId`).

The caller's **session is not moved** into the organisation they just joined and no token is minted here. An
organisation is chosen explicitly: the dashboard follows this with `POST /api/orgs/:id/switch`.

The signed-in account's **verified** email must equal the invitation's address, case-insensitively. An
invitation is to an address, not a bearer ticket, so forwarding the link is useless.

Single use is enforced by the write, not by a read: the membership `INSERT ... SELECT` and the `UPDATE` that
marks the invitation accepted go in one `batch()`, and each carries `accepted_at IS NULL AND revoked_at IS
NULL AND expires_at > now` in its own `WHERE`. Two simultaneous accepts of one token therefore cannot both
insert, and the route reports the outcome from reading the membership row back rather than from
`meta.changes`.

Errors:

| Code | Status | Means |
|---|---|---|
| `VALIDATION_ERROR` | 400 | The token is outside the plausible length range |
| `INVITE_NOT_FOUND` | 404 | No invitation has that token (unknown, or already swept) |
| `INVITE_REVOKED` | 403 | An admin revoked it |
| `INVITE_EXPIRED` | 403 | Past its 7 days |
| `INVITE_ACCEPTED` | 403 | Already used |
| `INVITE_EMAIL_MISMATCH` | 403 | Signed in as a different account — see below |
| `EMAIL_NOT_VERIFIED` | 403 | The address matches but has not been confirmed |
| `FORBIDDEN` | 403 | An API key |

`INVITE_EMAIL_MISMATCH` carries the invited address **at the top level of the error body** and nothing else:

```json
{ "error": "INVITE_EMAIL_MISMATCH", "message": "This invitation was sent to a different email address. Sign in with that address to accept it.",
  "invitedEmail": "ann@example.com" }
```

Top level, not nested under a `details` object, because the dashboard reads it as `ApiError.details.invitedEmail`
and its `details` **is** the whole error body (`apps/web/src/lib/api.ts`). This discloses nothing: whoever holds
the emailed token already has the address, and without it the page can only say "this was sent to someone else",
which does not tell the person which account to sign in as. Nothing about the organisation is in it — not the
name, not the id, not the role, not even that it exists.

#### GET /api/orgs/:id/members

Auth, any member of `:id` (down to `viewer`). Knowing who else can read the organisation's secrets is not
privileged; the dashboard hides the controls from non-admins but still shows the list. At most 500.

`200` `{ "data": [ { "user_id", "email", "role", "joined_at" } ], "total": 2 }`, oldest membership first.

#### PATCH /api/orgs/:id/members/:userId

Auth, `admin` of `:id`. Scope `member-write` (per **organisation**). Body: `role`.

`200` `{ "data": { "userId", "role" } }`. Setting the role it already has is a no-op: `200`, no write, no audit
row. Audited `org.member.role_change` against `:id` (resource `member`/`:userId`), with
`metadata` `{ "from": <old role>, "to": <new role> }`.

Only an owner may grant the `owner` role or change an owner's. The last `owner` cannot be demoted.

Errors: `400 VALIDATION_ERROR`; `403 FORBIDDEN` (not an admin, an API key, or an admin reaching for an owner);
`404 NOT_FOUND` (not a member of this organisation — the same answer whether the account exists);
`409 LAST_OWNER`.

#### DELETE /api/orgs/:id/members/:userId

Auth, `admin` of `:id` — **or** any member removing **themselves**, whatever their role. Scope `member-write`
(per **organisation**).

`200` `{ "data": { "userId", "removed": true } }`. Audited `org.member.remove` against `:id`, or
`org.member.leave` when the caller removed themselves.

The removal also kills that organisation's credentials for that person, in the **same `batch()`** as the
membership delete: `refresh_tokens` for `(user, org)` are deleted and their `api_keys` for `(user, org)` are
revoked with `revoked_reason = 'membership_removed'`. Credentials for the person's *other* organisations are
untouched. Without this, removal would only be *eventually* effective — the Lane A fail-closed paths
(`MEMBERSHIP_REVOKED`, `KEY_ORG_UNRESOLVED`) authorise nothing after removal, but an access token already
issued would keep working for up to its 15 minutes and `api_keys` would give an operator no way to tell which
keys are dead.

Errors: `403 FORBIDDEN` (not an admin and not yourself, an API key, or an admin reaching for an owner);
`404 NOT_FOUND`; `409 LAST_OWNER`.

#### `LAST_OWNER`, and why it is safe under concurrency

An organisation always keeps at least one `owner`. The guard is a correlated subquery **inside** the statement
that performs the write —

```sql
AND (role <> 'owner' OR EXISTS (
      SELECT 1 FROM members m2 WHERE m2.org_id = ? AND m2.role = 'owner' AND m2.user_id <> ?))
```

— and never a count read beforehand. `SELECT COUNT(*) ... WHERE role = 'owner'` followed by an `UPDATE` is two
statements: two owners demoting each other at the same moment both read 2, both decide they are allowed, and
the organisation ends with none. Here the condition is evaluated as part of the single statement that writes,
and D1 serialises writes to a database, so the second evaluates it against a database in which the first has
committed and matches no row. The route then reads the row back and returns `409 LAST_OWNER` from what it
finds; `meta.changes` is documented by D1 as a rough indication and nothing here depends on it.

On the removal path the two credential statements in the batch are themselves conditional on
`NOT EXISTS (SELECT 1 FROM members WHERE org_id = ? AND user_id = ?)`. They run in the same transaction as the
delete, so they see its result: a removal refused by the last-owner guard leaves the sessions and keys alone.

Closed invitations (expired, or revoked) are collected by the cron sweep in `apps/api/src/lib/housekeeping.ts`,
bounded per tick like the sweeps beside it. An accepted or revoked row survives until it is past its seven
days, which is what lets a re-clicked link say `INVITE_ACCEPTED` or `INVITE_REVOKED` rather than
`INVITE_NOT_FOUND`; after that the token is dead anyway. The trail lives in `audit_log`, which has its own
retention.

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
- DELETE cascades to environments and secrets in D1, then deletes the matching KV blobs — every
  revision of every value (`secret:{id}`, `secret:{id}:{rev}`) — on a best-effort basis.

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
  computed secret). The new ciphertext is written to a KV key that has never been used
  (`secret:{id}:{rev+1}`) and D1 then moves the pointer, so a failed write leaves the secret readable
  rather than corrupt. Renames or flag changes alone do not touch the stored value. Errors: `404`,
  `409` on a name clash.
- **Previous values are not retained.** Replacing a value destroys the only wrapped DEK that could
  decrypt the old one, so there is nothing to list, restore or purge — and nothing retained that an
  organisation would later have to be able to forget. HushVault keeps the current value of a secret and
  the audit record that it changed, never the superseded value. If you need the old credential, read it
  before you replace it. (The `secret_history` table that used to record it was write-only, with no
  endpoint, retention window or purge; it was dropped in migration 0017 — issue #84.)
- **Delete** removes the secret and every KV blob it owns.

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

## Integrations

Outbound credential vault (issue #39) and secret sync (issues #40, #41). The only provider is Cloudflare Workers secrets (beta); see `docs/INTEGRATIONS.md`.
Everything that touches a connection is **JWT only (API keys get `403`), admin or owner, rate limited (20/min) and audited**.
The credential is accepted once and never returned, logged or echoed in an error; responses carry metadata only. It is stored as
ciphertext (format tag `c2:`) bound by AES-GCM AAD to `(organisation id, connection id)` and re-wrapped by key rotation like a secret.

| Endpoint | Auth | Notes |
|----------|------|-------|
| `GET /api/integrations/providers` | any signed-in user | Registry from `packages/shared/src/integrations.ts`: `id, name, status, directions, summary, connectable`. `connectable` is true only for providers implemented in this deployment. |
| `POST /api/integrations/connections` | admin, JWT | Body `{ provider, label (1-64), credential (8-4096 chars), config? }`. The provider verifies the credential with a read-only call first. `201` metadata `{ id, provider, label, config, createdAt, updatedAt, lastVerifiedAt }`. Errors: `400 UNSUPPORTED_PROVIDER` / `VALIDATION_ERROR`, `409 CONFLICT` (label in use) / `LIMIT_REACHED` (20 per org), `422 CREDENTIAL_REJECTED`, `429 PROVIDER_RATE_LIMIT`, `502 PROVIDER_ERROR`. |
| `GET /api/integrations/connections` | admin, JWT | Metadata list for the organisation. |
| `PUT /api/integrations/connections/:id/credential` | admin, JWT | Body `{ credential }`. Verifies, re-encrypts, updates. `404` for another organisation's id. |
| `DELETE /api/integrations/connections/:id` | admin, JWT | Revokes: the credential and its wrapped key are deleted with the row. |

Audit actions: `integration.connect`, `integration.update`, `integration.revoke` (resource id only). `GET /api/security/key-rotation`
now also reports `rows.connections` per key version.

### Sync targets and runs

A target pushes one environment's resolved secrets (inheritance and computed secrets applied) to one provider resource, one way.
Same guards as connections: **JWT only (API keys `403`), admin or owner with a current membership re-read**. Responses are DTOs
(`SyncTargetDto`, `SyncPlanDto`, `SyncRunDto` in `packages/shared/src/integrations.ts`): names, counts and ids, never values,
credentials, the fingerprint salt or provider response bodies. Not-found and cross-organisation ids are both `404`.

| Endpoint | Notes |
|----------|-------|
| `POST /api/integrations/targets` | Body `{ projectId, envId, connectionId, resource, nameFilter?: { prefix?, deny? }, deleteRemoved?: false }`, unknown fields rejected. `resource` is validated by the provider (Cloudflare Workers: `{ accountId, scriptName }`, identifiers only; the account must match the connection). `201 { data: SyncTargetDto }`. Errors: `400 VALIDATION_ERROR`, `404` (connection, project or environment not in your organisation), `409 CONFLICT` (same resource already a target of that connection) / `PLAN_LIMIT` (Free plan: 2 targets per organisation, enforced inside the INSERT), `422 TARGET_NOT_ALLOWED` (HushVault's own Workers incl. `hushvault-web-local`, `HUSHVAULT_SYNC_DENY_SCRIPTS`, and any resource or connection in a Cloudflare account listed in `HUSHVAULT_SYNC_DENY_ACCOUNT_IDS`; creating a *connection* for a denied account is refused the same way). Rate limited 20/min. |
| `GET /api/integrations/targets` | `{ data: SyncTargetDto[] }`, newest first. |
| `PATCH /api/integrations/targets/:id` | Body `{ resource?, nameFilter?, deleteRemoved? }`; `connectionId` is rejected (`400`). Changing `resource` clears the target's ledger, so names written to the old resource can never authorise deletes on the new one. Changing `resource` or `nameFilter` while a run is queued or running (unexpired lease) is `409 BUSY` and changes nothing; the UPDATE repeats that check atomically. `deleteRemoved` and unchanged values are always allowed. |
| `DELETE /api/integrations/targets/:id` | Soft delete (`{ data: { deleted: true } }`); nothing is removed on the provider. Frees the plan slot and clears `next_retry_at` on the target's runs. |
| `POST /api/integrations/targets/:id/preview` | `{ data: SyncPlanDto }` (`create/update/delete/skip/conflict` names and `blockers`). Audited as `secret.read_bulk` (with ip and user agent). Rate limited 12/min **per organisation** (not per IP). Planning errors are the mapped errors listed under run. |
| `POST /api/integrations/targets/:id/run` | Rate limited 6/min **per organisation**. The engine checks for an active run first (`200` with that run, nothing planned), then makes **one** plan. `200 { data: SyncRunDto }`; a push failure is a recorded run (`failed`/`partial` with `errorCode`), not an HTTP error. `422 SYNC_BLOCKED { plan }` when the plan has blockers (no run recorded). A failure *before anything was sent* is both recorded as a failed run (visible under `/runs`, target marked `needs_attention` where applicable) and returned as a mapped HTTP error: `422 PROVIDER_AUTH / CREDENTIAL_UNAVAILABLE / COMPUTED_ERROR / DECRYPTION_FAILED / TARGET_NOT_FOUND / TARGET_NOT_ALLOWED`, `429 PROVIDER_RATE_LIMIT`, `502 PROVIDER_ERROR / TIMEOUT / PROVIDER_VALIDATION`, `409 BUSY`, `503 PROVIDER_UNAVAILABLE`. `COMPUTED_ERROR` = the environment could not be resolved; `DECRYPTION_FAILED` = a stored secret could not be decrypted. |
| `GET /api/integrations/targets/:id/runs` | `{ data: SyncRunDto[] }` newest first, max 50. |
| `GET /api/integrations/runs/:runId` | `{ data: SyncRunDto }`. |

Deleting a connection **cascades** to its targets (migration 0011); each removed target is audited as `sync.target.delete`.
Audit actions: `sync.target.create`, `sync.target.update`, `sync.target.delete` (resource type `sync_target`), `sync.run.started`,
`sync.run.succeeded`, `sync.run.failed` (resource type `sync_run`; they and `secret.read_bulk` carry the caller's ip and user agent).

Plan blockers (`SyncPlanDto.blockers[].code`): `NAME_INVALID` (bad charset/length, or `__proto__` / `constructor` / `prototype`),
`VALUE_TOO_LARGE`, `EMPTY_VALUE` (empty values are not pushed: whether the provider accepts them is unverified),
`TOO_MANY_ITEMS` (names already on the target plus names to create, minus deletes, exceed the provider cap; the listed names are the
creates that do not fit). Reserved names (`ENCRYPTION_*`, `JWT_SECRET`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`,
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) are never pushed and appear under `skip`.

Run error codes (`SyncRunDto.errorCode`) now also include `DECRYPTION_FAILED` and `TARGET_NOT_ALLOWED`. Targets whose last failure
was `PROVIDER_AUTH`, `PROVIDER_VALIDATION`, `TARGET_NOT_FOUND`, `COMPUTED_ERROR`, `CREDENTIAL_UNAVAILABLE`, `DECRYPTION_FAILED` or
`TARGET_NOT_ALLOWED` are `needs_attention` (cleared by the next success). `nextRetryAt` is set when *any* error of the run is
retryable (`PROVIDER_RATE_LIMIT`, `PROVIDER_ERROR`, `TIMEOUT`); a rate limit never retries sooner than 5 minutes, or the provider's
`Retry-After` when longer.

Ledger: before each push the engine records the names it is about to set as *pending* (internal marker, never exposed). A lost
response therefore leaves those names classified as HushVault's own (updated on the next run) instead of `conflict`.
A name that stops matching the name filter (prefix/deny changed) while still in the environment is dropped from the ledger and never
deleted on the target; `deleteRemoved` deletes only names removed from the environment.

## Security

### GET /api/security/key-rotation

Read-only encryption key status for the caller's organisation. Roles: `admin`, `owner`. Counts only; no secret ids, keys, wrapped DEKs or ciphertext. Starting or retiring a rotation is an operator action (deploy), never available through the API.

```json
{ "data": {
  "activeVersion": "v2",
  "rows": { "secrets": { "v1": 0, "v2": 42 }, "connections": { "v2": 3 } },
  "oldVersionsInUse": ["v1"],
  "job": { "status": "running", "phase": "secrets",
           "startedAt": "2026-10-02T03:00:00.000Z", "completedAt": null }
} }
```

`activeVersion` is `null` until the first scheduled tick registers the key (and until migration 0006 is applied the route returns `500 INTERNAL_ERROR`). `job` is the most recent rotation and is deployment-wide, so it carries only status, phase and timestamps (the row counts above are scoped to your organisation); it is `null` if no rotation has ever run. `phase` is `secrets` or `connections`; a job that has not run since migration 0017 may still report the retired `history` phase, which the engine treats as "start again from `secrets`".

`rows` carried a third entry, `history`, until migration 0017 dropped `secret_history` (issue #84). It is gone rather than reported as a permanent zero.

---

## Audit

Prefix `/api/audit`. All routes require auth, and **reads are admin-only** (the trail carries every member's IP, user agent and secret-read history, and the export can stream 50,000 rows per call). All queries are scoped to the
caller's organisation and to its retention window (older rows are never returned).

Retention by plan: `free` 7 days, `pro` 90, `team` 365, `enterprise` unlimited; unknown plans are treated as 7.
An organisation can set a shorter override. New organisations are on `free`; there is no billing, so
plan changes are manual today.

Rows use the raw column names (snake_case): `id, org_id, actor_id, actor_type, action, resource_type,
resource_id, ip, user_agent, metadata, timestamp`. `actor_type` is `user`, `api_key` or `system`.
`metadata` is a JSON object string or `null` — a small, bounded, non-secret object of fixed
server-set keys (never a secret value, token, key or caller free text; see `.claude/rules/audit-log.md`).
Most actions leave it `null`; which ones populate it, and with what, is under § Audit actions.

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

The 403 message does not tell the caller to upgrade, because there is no billing and therefore no way to
leave `free`; clients should read `complianceExport` from `GET /api/audit/retention` and explain the
boundary before the call, as the dashboard's audit page does.

- `json`: `Content-Type: application/json`, attachment `audit-log-YYYY-MM-DD.json`,
  body `{ "data": [rows], "total": n, "exportedAt": "..." }`.
- `csv`: `text/csv; charset=utf-8`, attachment `audit-log-YYYY-MM-DD.csv`, CRLF line endings, header
  `id,timestamp,action,actor_id,actor_type,resource_type,resource_id,ip,user_agent,metadata`. The
  `metadata` column is the JSON object string (quote-escaped as any field with `"` or `,` is), or
  empty. Fields beginning with `= + - @` tab or CR get a leading `'` (spreadsheet formula-injection
  guard).

### GET /api/audit/retention

`200` `{ "data": { "plan", "planMaxDays", "overrideDays", "effectiveDays", "complianceExport" } }`
(`-1` days means unlimited). `complianceExport` is a boolean derived from the plan — whether
`GET /api/audit/export` will be permitted — so a client can surface the limit instead of a 403. It is
advisory: the export route makes the check itself.

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

- `GET /health` (no auth, not under `/api`, so the global limiter does not apply):
  `200 { "status": "ok", "version": "0.0.1", "checks": { "db": "ok", "kv": "ok" } }`, or
  `503 { "status": "degraded", "version": "0.0.1", "reason": "kv", "checks": { "db": "ok", "kv": "down" } }`
  if either dependency is down. Note: this is not the `{data}` envelope.
  - `checks.db` — `"ok"` or `"down"`. A `SELECT 1` against D1.
  - `checks.kv` — `"ok"`, `"down"`, or `"unconfigured"` when the binding is absent. A read of
    `health:probe`, a key HushVault never writes; the probe expects it to be missing and only a
    failed read is a fault. It is a read, not a write, so the check cannot consume KV's daily
    write quota. A green `kv` proves the binding resolves and KV is reachable, **not** that
    writes succeed — see docs/OPERATIONS.md § 3.
  - `reason` — `"database"` when D1 is the failure, otherwise `"kv"`. Kept for compatibility;
    read `checks` instead.
- `GET /`: `200 { "name": "HushVault API", "version": "0.0.1", "status": "ok" }`.
- `GET /.well-known/security.txt`: plain-text security contact.

---

## Audit actions

Written by the API today: `auth.login`, `auth.login.github`, `auth.login.google`, `auth.api_key.create`,
`auth.api_key.revoke`, `auth.oauth.account_takeover`, `auth.email_verification.sent`, `auth.email.verified`,
`auth.password_reset.requested`, `auth.password_reset.completed`, `notify.api_key_revoked`, `org.create`,
`org.switch_in`, `org.switch_out`, `org.invite.create`, `org.invite.sent`, `org.invite.revoke`,
`org.invite.accept`, `org.member.role_change`, `org.member.remove`, `org.member.leave`, `project.create`,
`project.update`, `project.delete`, `environment.create`, `secret.read`, `secret.read_bulk`, `secret.create`,
`secret.update`, `secret.delete`, `share.create`. Not audited: registration, listing endpoints, share views.

The invitation and membership rows carry `resource_type` `org_invite` (resource id `inv_...`) or `member`
(resource id the member's `usr_...`), and `org.invite.sent` is the only one with `actor_type: system` — it
records the background send, which runs after the response is decided.

Some actions carry a `metadata` JSON object (issue #96) — a small, bounded, non-secret set of fixed
server-set keys. The populated ones today:

- `org.member.role_change` → `{ "from": <old role>, "to": <new role> }` — the row now records what a
  role changed to, not only that it changed.
- `org.member.remove` / `org.member.leave` → `{ "role": <role held when removed/left> }`.
- `org.invite.create` → `{ "role": <invited role> }`.
- `org.invite.accept` → `{ "role": <role actually granted> }` (the existing role if the caller was
  already a member).

Every other action leaves `metadata` `null`. It never carries a secret value, token, key or
caller-supplied free text — the rule is `.claude/rules/audit-log.md`.

An audit row's organisation comes from the **resource**, not from the actor's current session: a key
revocation is filed against the key's organisation, `org.create` / `org.switch_in` / `org.switch_out` against the organisation
acted on, and every invitation and membership row against the organisation in the request path rather than the
one the actor's credential happens to act in. The account-level events — `auth.email.verified`, `auth.password_reset.requested`,
`auth.password_reset.completed`, `auth.oauth.account_takeover` — are about the person rather than one
organisation, so they are written once per organisation the user is a member of. Each org's admins therefore
see the security events of their own members instead of only the admins of whichever membership happened to be
oldest.

## Known inconsistencies

These are real quirks of the current API, documented rather than hidden:

- **snake_case vs camelCase.** List and get-by-id rows for projects, environments, secrets and audit entries
  are raw database rows in snake_case (`project_id`, `parent_env_id`, `is_computed`, `created_at`). Create,
  update, resolved and single-secret responses are camelCase (`projectId`, `parentEnvId`, `isComputed`).
  `GET /api/auth/api-keys` is camelCase even though it is a list. Audit rows are snake_case on purpose to
  match the dashboard. The members and invitations endpoints follow the same split: the two **lists** are
  snake_case rows, while the invitation **create** response and the accept response are camelCase.
- **`INVITE_EMAIL_MISMATCH` puts `invitedEmail` at the top level** of the error body rather than inside a
  `details` object. The plan in `docs/plans/multi-org-and-invites.md` calls it `details.invitedEmail`, which
  is what it is from the dashboard's side — its `ApiError.details` is the whole error body — but it means the
  wire format has one error code with a field beside `error` and `message`. No other code does.
- **`is_computed`** is `0`/`1` in snake_case rows and a boolean elsewhere.
- **Validation error shape** differs between routes (see [Conventions](#conventions)); the unknown-path 404
  has no `message`.
- **`PUT /api/audit/retention`** checks the role inline and returns `Insufficient permissions`, a different
  message from `requireRole`. On the `enterprise` plan (unlimited, internally `-1`) any numeric override is
  currently rejected as exceeding the plan limit; use `null`.
- **API-key DELETE** removes the row, while the scanner soft-revokes (`revoked_at`); `revokedAt` in the list
  is therefore only set for scanner-revoked keys.
- **Previous secret values are not retained at all** (issue #84, migration 0017). There is no
  version list and no restore, and unlike before there is nothing stored that such an endpoint
  could be built on later without first writing the retention and purge to go with it.
- **Audit export is unreachable in practice.** It requires the `team` or `enterprise` plan, and
  with no billing every organisation is on `free` forever — so `GET /api/audit/export` returns
  403 `PLAN_UPGRADE_REQUIRED` for every real caller today. The gate is deliberate (#92); the
  `complianceExport` flag on `GET /api/audit/retention` exists so clients can say so up front,
  and the error code is kept for compatibility even though no upgrade is possible.
- **Roles in JWTs** are fixed at issue time, for the 15-minute access-token lifetime; a refresh
  re-reads the caller's membership and role, so a role change takes effect within one token
  lifetime. Routes where that window is too long (integrations, CI access, audit retention) also
  re-read the membership per request via `requireCurrentAdmin`.
- **`GET /api/secrets/:name`** takes a name while PATCH/DELETE take an id.
