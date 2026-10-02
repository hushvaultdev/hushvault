# Cloudflare Workers secrets (beta)

One-way push of a HushVault environment to the **secrets** (`secret_text`) of one Cloudflare Worker. Provider id `cloudflare-workers`,
module `apps/api/src/integrations/providers/cloudflare-workers.ts`. Overview: [../INTEGRATIONS.md](../INTEGRATIONS.md).

## Setup

1. In Cloudflare, create an **API token** (an account-owned token is preferred) scoped to the one account.
   Minimal permission: Workers Scripts, Edit (the secrets endpoints modify the Worker). Nothing else is needed. *The exact permission
   name is unverified; if a run reports `PROVIDER_AUTH`, check this first.*
2. Find your 32-character **account id** (Workers dashboard sidebar or URL).
3. Create a connection (admin, signed in as a user):
   `POST /api/integrations/connections` with `{ "provider": "cloudflare-workers", "label": "prod", "credential": "<token>", "config": { "accountId": "<id>" } }`.
   The token is verified with a read-only call and stored encrypted; it is never shown again.
4. Create a target: `POST /api/integrations/targets` with `{ projectId, envId, connectionId, resource: { accountId, scriptName } }`.
   The account id must equal the connection's. The Worker must already exist.
5. `POST /api/integrations/targets/:id/preview`, then `POST /api/integrations/targets/:id/run`.

## What is pushed

The environment as resolved by `GET /environments/:id/resolved` (branch inheritance, computed secrets evaluated), after the name filter
(`prefix` keeps only matching names, `deny` removes names) and minus the reserved names `ENCRYPTION_MASTER_KEY`, `ENCRYPTION_KEY_V<n>`,
`JWT_SECRET`. Names must match `[A-Za-z_][A-Za-z0-9_]*`. Values are sent as `secret_text` in the bulk secrets endpoint, in
requests of at most 64 operations (the documented maximum is 100). Unchanged values are skipped using an HMAC fingerprint kept in HushVault
(the value is never stored).

## Limits (conservative)

| Limit | Value used | Source |
|-------|-----------|--------|
| Names per target | 64 | Free plan allows 64 variables per Worker (paid: 128); secrets and text vars share the count. HushVault uses the lower number for every plan. |
| Value size | 5 KB | Documented per-variable limit. |
| Name length | 64 | HushVault's choice; the real limit is unverified. |
| Operations per request | 100 (we send at most 64) | Documented. |
| API rate | 1200 requests / 5 minutes per token | Documented; a 429 blocks the token for 5 minutes. HushVault stops the run on the first 429. |

A plan with names over these limits is a blocker (`SYNC_BLOCKED`, 422); nothing is pushed.

## Delete toggle and conflicts

- `deleteRemoved` is **off by default**. When on, a secret removed from the environment is deleted from the Worker, but only if HushVault
  itself created that name (the ledger). Secrets you created in Cloudflare by hand are never deleted.
- If a name already exists on the Worker and HushVault never wrote it, it is reported as a **conflict** and left untouched (HushVault will
  not overwrite it). Delete it in Cloudflare if you want HushVault to take it over.
- If someone deletes a HushVault-written secret in Cloudflare, the next run recreates it.
- Deleting a target or a connection does not remove anything from the Worker. Deleting a connection also removes its targets.
- Changing a target's `resource` clears its ledger.

## Safety

- The only host called is `https://api.cloudflare.com/client/v4`. Account id and Worker name are validated by strict regexes and
  URL-encoded; hosts, URLs and paths are never accepted. Redirects are not followed.
- HushVault's own Workers can never be targets: `hushvault-api`, `hushvault-api-dev`, `hushvault-web`, `hushvault-web-dev`, plus any names in the
  `HUSHVAULT_SYNC_DENY_SCRIPTS` var (comma separated; it can only add to the built-in list). Enforced at target creation/update and again at
  preview and run.
- The credential, secret values and Cloudflare response bodies are never logged, stored or returned; failures are mapped to fixed codes
  (`PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_VALIDATION`, `PROVIDER_ERROR`, `TARGET_NOT_FOUND`, `TIMEOUT`).
- **Pushing secrets can change a live Worker.** Whether the bulk endpoint deploys immediately is unverified (see below); assume a new
  version may go live.

## Verified vs unverified

Verified from Cloudflare documentation (changelog 2026-06-03 and wrangler docs):

- A bulk secrets endpoint exists under `workers/scripts/{script_name}/secrets`; body `{ "secrets": { NAME: { type, name, text } | null } }`;
  `null` deletes; omitted names are unchanged; at most 100 operations per request.
- Listing returns names and types only, never values.
- Variable limits (64 Free / 128 Paid, 5 KB each), error codes 10054 and 10055; rate limit of 1200 requests per 5 minutes; the standard
  v4 error envelope; Workers codes 10007, 10016, 10021, 10026, 10035.

**Not verified** (handled defensively in the code; confirm against a real account before treating this as available):

1. The HTTP verb of the bulk endpoint. The provider sends `PATCH` and retries once with `PUT` if it gets `405`.
2. The bulk response shape. A 2xx is success unless the JSON says `success: false`; per-secret results are not available, so a rejected
   request fails every name in that request.
3. The list endpoint path (`GET .../secrets`), its envelope (`result` as an array of `{ name, type }`) and any pagination (not handled).
4. The verify endpoints: the provider tries `GET /accounts/{id}/tokens/verify` and falls back to `GET /user/tokens/verify`. Verifying a
   token does not prove it can edit Worker secrets, so a connection can verify and a run can still fail with `PROVIDER_AUTH`.
5. The token permission name and whether listing works with a read-only permission.
6. Whether a REST bulk call deploys a new Worker version immediately or only creates a version (`wrangler secret bulk` deploys; assumed
   the same).
7. Secret name charset and length limits beyond HushVault's own.
8. Per-endpoint HTTP statuses: 403 vs 404 for a missing script or permission (both 401/403 map to `PROVIDER_AUTH`, 404 and code 10007 to
   `TARGET_NOT_FOUND`), 400 vs 422 for validation, rate-limit headers, `Retry-After`.
9. Whether one bulk call counts once against the rate limit.
10. Provider timeouts (15 s list, 30 s push) are implemented in the engine but not covered by tests.
11. The sync migration (`0011_sync.sql`) was tested only on the SQLite test harness, not on real D1.
