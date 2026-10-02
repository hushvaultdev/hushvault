# Integrations

Status of every integration lives in one place: `packages/shared/src/integrations.ts`. The dashboard, marketing copy and the
README derive from it, and tests fail if an entry is promoted to beta/available without a provider module, a test file and a docs page.

| Integration | Status | Direction | Notes |
|-------------|--------|-----------|-------|
| Cloudflare Workers | **beta** | push | Worker secrets only. See [integrations/cloudflare-workers.md](integrations/cloudflare-workers.md). API only: there is no dashboard UI for targets yet. |
| GitHub Actions | planned | pull, push | Not built. |
| Cloudflare Pages | planned | push | Not built, lowest priority. |
| Slack | planned | notify | Not built. |
| Webhooks | planned | notify | Not built. |

## How sync works

1. **Connection**: an admin stores a provider credential once (`POST /api/integrations/connections`). It is verified with a read-only
   call, encrypted (AAD-bound to organisation and connection) and never returned.
2. **Target**: binds one environment to one provider resource (for Cloudflare Workers: account id and Worker name), with an optional
   name filter (prefix, deny list) and a delete toggle (default off).
3. **Preview**: shows names grouped as create / update / delete / skip / conflict plus blockers. Never values.
4. **Run**: pushes the plan. Runs are single flight per target, recorded in run history, and partial progress is kept.

Rules that always hold: one way (HushVault to target); the reserved bootstrap names `ENCRYPTION_MASTER_KEY`, `ENCRYPTION_KEY_V<n>` and
`JWT_SECRET` are never pushed; a name that already exists on the target but was not written by HushVault is a **conflict** and is left
untouched; only names HushVault itself wrote (the ledger) can ever be deleted, and only when the target's delete toggle is on;
a target can never point at HushVault's own Workers.

## Plan limits

The Free plan allows 2 sync targets per organisation (`FREE_PLAN_MAX_SYNC_TARGETS`); paid plans are unlimited for now. Billing itself
is not built.

## Honest status

- Beta means the code and its tests exist; it has **not** been exercised against a live Cloudflare account in this repository's tests.
  Several Cloudflare API details are unverified (list in the provider doc).
- No scheduler yet: runs are manual (`POST /targets/:id/run`). Failed runs record `nextRetryAt`, but nothing retries them yet.
- No automatic sync on secret change.
- No dashboard or CLI surface for targets yet.
