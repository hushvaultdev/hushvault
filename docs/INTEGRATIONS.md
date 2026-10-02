# Integrations

Status of every integration lives in one place: `packages/shared/src/integrations.ts`. The dashboard, marketing copy and the
README derive from it, and tests fail if an entry is promoted to beta/available without a provider module, a test file and a docs page.

| Integration | Status | Direction | Notes |
|-------------|--------|-----------|-------|
| Cloudflare Workers | **beta** | push | Worker secrets only. See [integrations/cloudflare-workers.md](integrations/cloudflare-workers.md). Manual runs from the dashboard, `hushvault sync` and the API; one way. Not yet verified against a live Cloudflare account. |
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
- Surfaces: the dashboard (Integrations) creates, edits, previews and runs targets; `hushvault sync` lists, previews and runs them; the API does all of it.
  Connections and targets are created in the dashboard or the API, not the CLI.

## Automatic triggers (M4)

Off by default, per target (`autoSync`). Manual runs always work.

- **On change:** creating, editing or deleting a secret queues the targets of that environment and of every environment that
  inherits from it (one coalesced outbox row per target, ids only). The minute cron sweeps the outbox, so the target is
  updated about 30-90 seconds after the change. A run already in flight keeps the row so the change is not lost.
- **Scheduled reconcile:** every 15 minutes, hourly, every 6 hours or daily, per target.
- **Retries:** a failed run with a retryable error (rate limit, provider error, timeout) is retried with exponential backoff and
  jitter, up to 5 attempts, only while it is the target's newest run. Auth, validation, missing target, computed-secret and
  credential errors mark the target `needs_attention` and stop all automatic triggers until it is edited or the credential
  rotated.
- **Limits:** at most 60 automatic runs per organisation per hour (extra work is deferred ten minutes, not dropped); one run
  per target at a time.
- **Audit:** automatic runs are written as `sync.run.*` by the `system` actor.
- **Runtime:** everything runs inside the existing minute cron (`apps/api/src/integrations/sync-scheduler.ts`), with no Queues.
  A very large backlog is processed 25 targets per sweep per step. Cloudflare's per-invocation subrequest limit on the Workers
  Free plan has not been checked against a busy sweep; that is part of the combined beta test.
