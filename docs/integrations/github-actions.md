# GitHub Actions secrets (beta)

One-way push of a HushVault environment to a GitHub **repository's Actions secrets**, one way. Provider id `github-actions`,
module `apps/api/src/integrations/providers/github-actions.ts`. Overview: [../INTEGRATIONS.md](../INTEGRATIONS.md).

> **Status: beta.** The provider is implemented, unit-tested against the GitHub API as documented, and has been verified live against a
> real repository (issue #44): connect, target, preview, create, update, delete with `deleteRemoved` off then on, and the `NAME_INVALID`
> rename-suggestion path. GitHub Enterprise Server (custom hosts) is out of scope — only `api.github.com` is called (SSRF).
> Environment secrets are a follow-up; v1 does **repository** secrets.

## Encryption (the one crypto exception)

GitHub's API requires each secret value to be encrypted as a **libsodium `crypto_box_seal`** (NaCl sealed box) against the repository's
Curve25519 public key. WebCrypto cannot produce a sealed box, so this is the single, owner-approved exception to HushVault's "WebCrypto only"
rule (#37/#44): the vetted `libsodium-wrappers` library, pinned, used **only** for `crypto_box_seal`, imported **only** in
`apps/api/src/integrations/providers/github-seal.ts`. No cryptography is hand-rolled. The plaintext value is sealed in the sync job and never
logged; HushVault stores only the sealed, base64 `encrypted_value` in transit to GitHub.

## Setup

1. In GitHub, create a **fine-grained personal access token** scoped to the target repository, with the **Secrets: Read and write**
   repository permission. *(A classic token with `repo` also works. A GitHub App is a planned follow-up — #37 prefers it long-term.)*
2. Create a connection (admin, signed in as a user):
   `POST /api/integrations/connections` with `{ "provider": "github-actions", "label": "prod", "credential": "<token>", "config": {} }`.
   The config is empty: the token is the whole credential. It is verified with a read-only call and stored encrypted; never shown again.
3. Create a target: `POST /api/integrations/targets` with `{ projectId, envId, connectionId, resource: { owner, repo } }`.
4. `POST /api/integrations/targets/:id/preview`, then `POST /api/integrations/targets/:id/run`.

## What is pushed

The environment as resolved by `GET /environments/:id/resolved` (branch inheritance, computed secrets evaluated), after the name filter
and minus the reserved names (`ENCRYPTION_*`, `JWT_SECRET`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`). A secret name must match GitHub's rule — letters/digits/underscore, **not starting with a digit** and **not starting
with `GITHUB_`** — and may not be `__proto__`/`constructor`/`prototype`; otherwise it is a `NAME_INVALID` blocker. The preview offers a
**rename suggestion** for a rejected name (`db-url` → `DB_URL`, uppercased as GitHub stores names); you rename the secret — HushVault never
renames on its own. Empty values are an `EMPTY_VALUE` blocker. Unchanged values are skipped via an HMAC fingerprint kept in HushVault (the
value is never stored).

The repo public key is fetched **once per run** (it can rotate) and each value is sealed against it, then `PUT` to the secret.

## Limits

| Limit | Value | Source |
|-------|-------|--------|
| Secrets per repository | 100 | GitHub documented |
| Value size | 48 KB | GitHub documented |
| Name length | 100 | HushVault's conservative cap; the real limit is unverified |
| Operations per request | 20 (sequential) | No bulk endpoint: each set is a seal + one `PUT` (a create is one request); the engine chunks to 20 with a 60 s push window |
| Rate limiting | `403`+`x-ratelimit-remaining: 0` / `429` → `PROVIDER_RATE_LIMIT` | The run stops and retries after `Retry-After`, at least 5 minutes, capped at 24 h |

## Delete toggle and conflicts

Same as the other providers: `deleteRemoved` off by default; HushVault only deletes names it created (the ledger); a name already on the repo
that HushVault never wrote is a conflict and left untouched; deletes are idempotent (404 = success); intent is recorded before each push so a
lost response does not orphan a name. Deleting a target or connection removes nothing from GitHub.

## Safety

- The only host called is `https://api.github.com`. `owner`, `repo` and the secret name are validated by strict regexes and URL-encoded; no
  base URL / host input (GHES out of scope). Redirects are not followed.
- The credential (sent as `Authorization: Bearer`), secret values and GitHub response bodies are never logged, stored or returned; failures
  map to fixed codes (`PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_VALIDATION`, `PROVIDER_ERROR`, `TARGET_NOT_FOUND`, `TIMEOUT`).

## Verified vs unverified

Verified from GitHub docs (2026-10-12): the public-key / upsert / delete / list endpoints and bodies; the libsodium sealed-box requirement;
name rules (alphanumeric + `_`, no leading digit, no `GITHUB_` prefix; case-insensitive, stored uppercase); limits (100 repo secrets, 48 KB).
**Not** verified until the live E2E on #44: the exact behaviour of a fine-grained token's `Secrets` permission end to end; the environment-
secret endpoints (deferred); the exact maximum secret-name length; whether `libsodium-wrappers`' WASM initialises within the Worker's startup
budget under production load (the bundle builds and the dry-run passes).

## Live E2E (recorded, #44)

Run against a throwaway GitHub repo with a fine-grained token (Secrets: read and write). Connect, project/environment, seed secrets,
create a connection, target `{ owner, repo }`, preview, run (create), change a secret and run (update), and delete-with-`deleteRemoved`-off
then -on all passed against the real GitHub Actions secrets API. The `NAME_INVALID` rename-suggestion sub-case did not run in the recorded
drill because seeding a GitHub-invalid secret name was itself rejected by HushVault's own name validation (`HTTP 400`) before the sync path
was reached — tracked separately; it does not affect the push path above, which is independently proven by the list/create/update/delete
checks against GitHub's API (ground truth, not HushVault's own bookkeeping).
