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
(`prefix` keeps only matching names, `deny` removes names) and minus the reserved names (every secret-typed key of HushVault's own Env: `ENCRYPTION_*`, `JWT_SECRET`, `GITHUB_CLIENT_SECRET`,
`GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). Names must match `[A-Za-z_][A-Za-z0-9_]*` and may not be
`__proto__`, `constructor` or `prototype` (any case): those are `NAME_INVALID` blockers, and the request body is built with
`Object.fromEntries` so no name can ever be silently dropped from it. **Empty values are a blocker (`EMPTY_VALUE`)**: whether Cloudflare
accepts an empty `secret_text` is unverified, so HushVault does not guess. Values are sent as `secret_text` in the bulk secrets endpoint, in
requests of at most 64 operations (the documented maximum is 100). Unchanged values are skipped using an HMAC fingerprint kept in HushVault
(the value is never stored).

## Limits (conservative)

| Limit | Value used | Source |
|-------|-----------|--------|
| Names per target | 64 | Free plan allows 64 variables per Worker (paid: 128); secrets and text vars share the count. HushVault uses the lower number for every plan. The count is *(names already on the Worker, from the list call) union (names to create), minus names to delete*; it only blocks when something would be created, so a Worker that is already over 64 because of foreign secrets can still be updated. Deletes are sent after sets, so at the cap a swap may still be rejected by Cloudflare (`PROVIDER_VALIDATION`). |
| Value size | 5 KB | Documented per-variable limit. |
| Name length | 64 | HushVault's choice; the real limit is unverified. |
| Operations per request | 100 (we send at most 64) | Documented. |
| API rate | 1200 requests / 5 minutes per token | Documented; a 429 blocks the token for 5 minutes. HushVault stops the run on the first 429 and schedules the retry **at least 5 minutes later** (or the `Retry-After` header when Cloudflare sends one and it is longer; capped at 24 h). |

A plan with names over these limits is a blocker (`TOO_MANY_ITEMS`, `VALUE_TOO_LARGE`, `NAME_INVALID`, `EMPTY_VALUE`; the run endpoint answers `SYNC_BLOCKED`, 422); nothing is pushed.

## Delete toggle and conflicts

- `deleteRemoved` is **off by default**. When on, a secret removed from the environment is deleted from the Worker, but only if HushVault
  itself created that name (the ledger). Secrets you created in Cloudflare by hand are never deleted.
- If a name already exists on the Worker and HushVault never wrote it, it is reported as a **conflict** and left untouched (HushVault will
  not overwrite it). Delete it in Cloudflare if you want HushVault to take it over.
- If someone deletes a HushVault-written secret in Cloudflare, the next run recreates it.
- A name that stops matching the target's name filter (prefix or deny changed) but is still in the environment is **forgotten**
  (dropped from the ledger) and never deleted on the Worker. `deleteRemoved` deletes only names removed from the environment.
- **Intent first.** Before each request HushVault records the names it is about to set as *pending* in its ledger, and replaces that with
  the real fingerprint once Cloudflare confirmed. If the response is lost (timeout, network error, 5xx) the names may exist on the Worker;
  the pending marker makes the next run treat them as HushVault's own and rewrite them rather than report a permanent conflict. A
  definite failure (4xx, 429, an item reported failed) removes the marker again.
- Deleting a target or a connection does not remove anything from the Worker. Deleting a connection also removes its targets.
- Changing a target's `resource` clears its ledger.

## Safety

- The only host called is `https://api.cloudflare.com/client/v4`. Account id and Worker name are validated by strict regexes and
  URL-encoded; hosts, URLs and paths are never accepted. Redirects are not followed.
- HushVault's own Workers can never be targets: `hushvault-api`, `hushvault-api-dev`, `hushvault-web`, `hushvault-web-dev`,
  `hushvault-web-local`, plus any names in the `HUSHVAULT_SYNC_DENY_SCRIPTS` var (comma separated; it can only add to the built-in list).
  `HUSHVAULT_SYNC_DENY_ACCOUNT_IDS` (comma separated Cloudflare account ids) additionally refuses any target or connection in those
  accounts. Enforced **both in the routes** (target create/update, connection create, preview, run) **and inside the sync engine** (plan and
  run, so a scheduled retry or a var changed after the target was created cannot bypass it); the engine outcome is `TARGET_NOT_ALLOWED`,
  which marks the target `needs_attention`.
- The credential, secret values and Cloudflare response bodies are never logged, stored or returned; failures are mapped to fixed codes
  (`PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_VALIDATION`, `PROVIDER_ERROR`, `TARGET_NOT_FOUND`, `TIMEOUT`).
- The bulk request is `PATCH` only. There is **no fallback to `PUT`**: if `PUT` replaces the whole secret set, a fallback could delete
  every secret that is not in the request. A `405` is a plain `PROVIDER_ERROR`.
- **Pushing secrets can change a live Worker.** Whether the bulk endpoint deploys immediately is unverified (see below); assume a new
  version may go live.

## Verified vs unverified

Verified from Cloudflare documentation (changelog <https://developers.cloudflare.com/changelog/post/2026-06-03-bulk-secrets-api/> of 2026-06-03, and the wrangler `secret bulk` docs <https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-bulk>). The changelog states the body shape, `null` deletes, unchanged omitted names and the 100-operation limit; it does **not** state the HTTP verb, response shape or list pagination:

- A bulk secrets endpoint exists under `workers/scripts/{script_name}/secrets`; body `{ "secrets": { NAME: { type, name, text } | null } }`;
  `null` deletes; omitted names are unchanged; at most 100 operations per request.
- Listing returns names and types only, never values.
- Variable limits (64 Free / 128 Paid, 5 KB each), error codes 10054 and 10055; rate limit of 1200 requests per 5 minutes; the standard
  v4 error envelope; Workers codes 10007, 10016, 10021, 10026, 10035.

**Not verified** (handled defensively in the code; confirm against a real account before treating this as available):

1. The HTTP verb of the bulk endpoint. The provider sends `PATCH` only (see Safety); if Cloudflare expects another verb every push fails with `PROVIDER_ERROR` until the code is changed after verification.
2. The bulk response shape. A 2xx is success unless the JSON says `success: false`; per-secret results are not available, so a rejected
   request fails every name in that request.
3. The list endpoint path (`GET .../secrets`), its envelope (`result` as an array of `{ name, type }`) and pagination. Pagination is **not implemented**: the list call fails closed (`PROVIDER_ERROR`) when `result_info` shows more than one page (`total_pages > 1`, `total_count` larger than the page, or a non-empty cursor). A response without `result_info` is accepted as complete, which is itself unverified.
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
12. Whether an empty secret value is accepted (HushVault blocks it as `EMPTY_VALUE`).

## Caveats

- **Drift is not detected.** A run compares values to HushVault's own fingerprint of what it last pushed, never to what is on the Worker
  (Cloudflare never returns values). A secret edited by hand in Cloudflare is not noticed or reverted until the environment value changes;
  a secret deleted by hand is recreated on the next run.
- **Ledger loss.** The ledger (`sync_items`) only restricts deletes. If it is lost (for example the resource was changed, which clears
  it), HushVault deletes nothing and names that already exist on the Worker show up as conflicts until you remove them in Cloudflare.
  Rotating `JWT_SECRET` changes every fingerprint and causes one extra, idempotent push per name.
- **Pagination** of the list endpoint is unverified and unsupported (see above); a Worker whose list is paginated cannot be synced yet.
- **Empty values** are blocked, not pushed (unverified, item 12).
- **`__proto__`, `constructor`, `prototype`** are rejected as names.
- **Rate limits** back off for at least 5 minutes (or `Retry-After`); a rate-limited run is retried later rather than hammering the token.
- Changing a target's resource or name filter while a run is queued or running is refused (`409 BUSY`), and a run that began against an
  old resource cannot write ledger rows afterwards.
