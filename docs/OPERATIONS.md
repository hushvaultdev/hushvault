# Operations Runbook

Status legend: **[verified]** = confirmed against Cloudflare docs or the installed
wrangler (4.92.0) help; **[unverified]** = could not be confirmed, check before relying on it.

## 1. The master key (`ENCRYPTION_MASTER_KEY`)

Secret values are encrypted with a per-secret DEK, and each DEK is wrapped by
`ENCRYPTION_MASTER_KEY` (see ENCRYPTION.md). Wrapped DEKs live in D1, encrypted
values in KV.

**If the production master key is lost, every stored secret is permanently
unrecoverable.** Cloudflare cannot show a Worker secret's value again after it is set
(dashboard and `wrangler secret list` show names only) **[unverified: confirm in
current Workers secrets docs]**, so the Worker is not a backup of the key.

Back it up offline, at the moment you generate it:

1. Generate on a trusted machine: `openssl rand -base64 32`.
2. Store at least two copies in separate offline places (for example a password
   manager with an emergency kit plus a printed copy in a safe). Do not keep it
   only in GitHub secrets, CI logs, chat, or the same account as the Worker.
3. Test the backup: decode it and confirm 32 bytes
   (`echo "<key>" | base64 -d | wc -c` prints 32).
4. Restrict who can read it; record who has access.

Never paste the key into issues, logs or terminals with shared history.

### Rotation

Master-key rotation is implemented as a versioned key ring plus a cron-driven DEK re-wrap
(see ENCRYPTION.md "Key Rotation" for the exact order). Summary for operators:

- Add the new key (`ENCRYPTION_KEY_V<N>`) **after** backing it up offline, then set
  `ENCRYPTION_ACTIVE_KEY_VERSION` in `wrangler.toml` and deploy.
- Watch for `key.rotation.*` audit events and `GET /api/security/key-rotation`.
- Do not delete an old key while any row, backup or export may still need it; the
  Time Travel / export retention rule in section 2 applies to old keys too.
- Alert on `KEY_VERSION_UNAVAILABLE` and `key_rotation.*_failed`/`activation_refused`
  log lines (they carry only codes and version labels), in addition to `DECRYPTION_FAILED` spikes.
- The cron runs every minute per environment; migration `0006` must be applied first
  (until then the tick logs `key_rotation.tick_failed` and does nothing).
- Rotation does not remedy a captured D1 + KV + old-key set (section 5).

## 2. Backups and recovery

### D1 (metadata, users, wrapped DEKs, audit log)

- **Time Travel**: `wrangler d1 time-travel info|restore <db> --timestamp <unix|RFC3339> | --bookmark <id>`.
  The installed wrangler help says the timestamp must be "within the last 30 days"
  **[verified: wrangler 4.92.0 `d1 time-travel restore --help`]**. I could not retrieve
  the D1 Time Travel docs page through the docs search tool, so the retention for
  your plan is **[unverified]**; confirm at
  <https://developers.cloudflare.com/d1/reference/time-travel/> before relying on it.
- Restoring overwrites the database in place; take an export first if possible and
  note the bookmark `info` returns so you can undo.
- **Before restoring D1, set `DISABLE_ORPHAN_SWEEP=1` and deploy.** The cron's orphaned-blob
  sweep treats D1 as the source of truth: a blob is referenced when its row exists and its
  revision is at or below `secrets.blob_rev`. A restore that moves `blob_rev` *backwards* makes
  a blob the live row still needs look unreferenced, and an hour later the sweep deletes it —
  a data-loss path that only opens during recovery. The same flag also stops the one-way purge of
  pre-0014 `secrethist:` blobs, for the same reason (see below). Leave the flag set until D1 and
  KV agree again, then remove it and redeploy. While it is set,
  `housekeeping.orphan_sweep_disabled` appears in the logs each tick and the audit, share-link and
  token sweeps carry on as normal.
- `wrangler d1 migrations apply` captures a backup before applying
  **[verified: `wrangler d1 migrations apply --help`]**.
- **Never run a migration that rebuilds a table other tables reference.** D1 ignores
  `PRAGMA foreign_keys = OFF`, accepts but does not honour `PRAGMA legacy_alter_table`, and
  turns a deferred foreign-key violation into a whole-database rollback. A rename-and-drop
  rebuild of a referenced table silently deletes every cascading child row with no error.
  Verified against the dev database; see `.claude/rules/database-schema.md`.
- Manual export (not automatic; schedule it yourself if you want off-Cloudflare copies):
  `wrangler d1 export hushvault-db --remote --output backup-$(date +%F).sql`
  **[verified: `wrangler d1 export --help`]**. Exports contain wrapped DEKs and user data;
  store them encrypted, and remember they are useless without the KV blobs and master key.

**After a D1 restore, secrets diverge per row, not all at once.** A secret whose value changed
after the restore point has the old wrapped DEK in D1 and the newer ciphertext in KV. It still
decrypts, because the restored row's `blob_rev` names the revision it was written with, and that
revision's blob is still in KV: superseded revisions are never deleted (`secret:{id}:{rev}`, see
ENCRYPTION.md). So the restore gives you the pre-change value back. Recovery is per secret and
needs no tool. A secret created after the restore point loses its D1 row and its blob becomes an
orphan; one deleted after the restore point comes back as a row with no blob and reads as `404`.

**What a restore can no longer get back (issue #84).** Before migration 0017, `secret_history`
kept a superseded wrapped DEK per value change, and a `secrethist:{historyId}` blob for changes
made before migration 0014. Together they meant an operator could reconstruct *any* past value of
a secret by hand, not just the one the restore point happened to name. That is gone, and it is a
real loss of a recovery option, not a tidy-up:

- There is no way to recover a value that was replaced, by restore or by any other means. The
  wrapped DEK is overwritten on each change and nothing keeps a copy. If an old credential may be
  needed, read it out *before* replacing it.
- A restore can recover only the value that was current at the restore point.
- Any `secrethist:` blobs still in KV are now undecryptable — 0017 destroyed their wrapped DEKs —
  and the cron deletes them as it finds them, bounded per tick. If you are restoring D1 to a point
  *before* 0017, those rows come back and those blobs are what they point at, so set
  `DISABLE_ORPHAN_SWEEP=1` first: it stops that purge as well as the orphaned-blob sweep.

The trade this was made for: no retained ciphertext of a rotated credential that the organisation
cannot ask us to forget, no rotation phase re-wrapping rows nobody could read, and no unbounded
D1 growth. See issue #84 for the decision.

### KV (encrypted secret blobs)

- I found no built-in backup or point-in-time restore for Workers KV in the docs I
  could search **[unverified; absence of evidence]**. Assume deleted or overwritten
  keys cannot be recovered by Cloudflare.
- D1 and KV must be consistent: a D1 restore without matching KV blobs (or vice
  versa) leaves secrets unreadable. Prefer fixing forward over restoring one without the other.
- Manual dump: `wrangler kv key list --binding SECRETS_KV --env production --remote`
  then `wrangler kv key get` per key (or `wrangler kv bulk get` (open beta per its help; check
  `wrangler kv bulk get --help`). The blobs are ciphertext, so the dump is safe to store
  encrypted at rest but still sensitive. There is no automated job for this yet.

### Durable Objects

`RateLimiter` holds only transient rate-limit counters; no recovery plan is needed.
(SQLite-backed DOs support point-in-time recovery for 30 days per the DO docs,
<https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/>.)

### Code and config

Git is the source of truth; Worker versions can be rolled back with
`wrangler rollback` (see DEPLOYMENT.md; last 100 versions).

## 3. What to monitor

Workers Logs is enabled (`[observability] enabled = true`) in every env; view
them in the dashboard under the Worker's Observability tab or live with
`wrangler tail --env production`
(<https://developers.cloudflare.com/workers/observability/logs/workers-logs/>).
The default head sampling rate is 1 (100%) per that page; lower it only
deliberately. Logs must never contain secret values; the app does not log them.

Watch:

- `/health` returning non-200. CI smoke-tests it after each deploy; add an external uptime check
  against `https://api.hushvault.dev/health` (no monitor is configured by this repo). The body
  reports each dependency separately — read `checks`, not `status`:

  ```json
  { "status": "ok", "version": "0.0.1", "checks": { "db": "ok", "kv": "ok" } }
  ```

  `checks.db` is a `SELECT 1` against D1. `checks.kv` is a **read** of `health:probe`, a key
  HushVault never writes: the probe expects `null`, and only a rejected read counts as a failure.
  It is a read and not a write on purpose — the free plan caps KV writes and deletes per day, so
  a probe that wrote once a minute would exhaust the quota it exists to detect. Each is `ok`,
  `down` or (KV only) `unconfigured`, meaning the binding is missing from the deploy. `reason`
  keeps its old single-string value (`database` when D1 is the failure) for anything already
  matching on it. Either dependency down is a 503.

  **`checks.kv: "ok"` does not prove KV writes work.** Cloudflare caches KV reads, misses
  included, so a healthy answer can come from the edge; and a write-quota failure is only visible
  to the request that writes. The probe proves the binding resolves and KV is reachable, which is
  what makes "every secret is unreadable" visible at all — it used to leave health green.
  `housekeeping.orphan_blobs` and `secret.decrypt_failed` are the signals for write-side trouble.

  **The answer is served from a 5-second window.** `/health` is mounted outside `/api/*`, so it
  has no token requirement and no rate limit — a monitor must be able to reach it. That made it
  the one unauthenticated route that drove work in both stores on every request, i.e. a way for
  anyone to burn the quotas the probe reports on. One probe result is now served to every caller
  for 5 s (per isolate), and concurrent callers share the probe already running. A monitor at
  1/min is unaffected (60 s > 5 s, so every poll probes), and a reported recovery can be at most
  5 s stale. `health.degraded` is logged only when a probe actually ran, so it keeps firing while
  a store is down without a flood turning it into a log flood.
- Error-rate and 5xx spikes, especially `DECRYPTION_FAILED` (possible wrong or
  rotated master key) and 429 spikes (abuse or a misbehaving client).
- Failed CI deploy runs on `main`/`dev`.
- Cloudflare usage against your plan's limits; check the limits pages for your plan
  rather than relying on numbers in this repo (none are quoted here):
  <https://developers.cloudflare.com/workers/platform/limits/>,
  <https://developers.cloudflare.com/d1/platform/limits/>,
  <https://developers.cloudflare.com/kv/platform/limits/>.
- The audit log (D1 `audit_log` table, `GET /api/audit`) for unexpected `api_key` actors or off-hours access.
  Reads are admin-only.
- Email: `email.not_configured`, `email.send_failed` and `email.budget_exhausted` (section 6).
  These are the only signal that mail has stopped — the auth endpoints keep answering normally
  when it has.
- `key_rotation.bootstrap_failed` — the deployment has no `active` row in `encryption_keys` and
  the key it needs does not match the data. Writes keep using the last proven key version, so
  this is not an outage, but no rotation can start until it is fixed. The tick records the
  attempt in `system_state` and retries every 15 minutes rather than every minute, so expect
  this line four times an hour, not sixty, while it is broken. Fixing
  `ENCRYPTION_ACTIVE_KEY_VERSION` is retried on the next tick; replacing the key material
  behind an unchanged version waits out the interval.
- `housekeeping.orphan_blobs` — the reconciliation pass over KV's `secret:` blobs. `deleted` is
  routine; a `unreferenced` count that grows tick after tick without `deleted` keeping up means
  D1 writes are failing *after* their KV write succeeded (the create and update paths write KV
  first), which is worth investigating on its own. A blob is only deleted once it has been
  proved unreferenced twice an hour apart, so a backlog is expected to lag, not to grow.

### Alert conditions

Every event HushVault emits that means "a control just stopped working", and what to alert on.
All of them are structured JSON lines in Workers Logs with an `event` field; none of them ever
carries a secret value, a key, a DEK, a token or an address. **No alert destination is wired up
yet** (issue #83) — this table is what to configure, and it is also the list of names a query
can be built from today.

The **Alert on** column distinguishes three shapes, and the difference matters:

- **Presence** — one line means something is wrong. Fire on the first occurrence.
- **Rate** — occasional lines are normal; a sustained rate is not.
- **Absence** — the line appearing is the *healthy* state. A cron that stops firing emits nothing
  at all, so a heartbeat and an absence alert are the only way to see it. **An absence alert
  cannot be added later from the log alone** — if nothing is watching for the gap, there is no
  gap to find.

| Event | Means | Alert on |
|---|---|---|
| `cron.tick` | The scheduled handler ran. Carries each tick's outcome: `rotation` (its `TickResult.state`), `rotationCode`, `sync`, `housekeeping` | **Absence** for 10 min — the only signal that the cron itself has stopped. Also **presence** of `rotation: "error"` or any `"threw"` |
| `sync.tick` | The sync sweep ran. Emitted every tick, including when it did nothing | **Absence** for 10 min. Zero counts are the healthy steady state, so the counts are not an alert |
| `health.degraded` | `/health` answered 503. Carries `db`, `kv`, `reason`. At most one line per 5 s window per isolate, so the rate is not a request rate | **Presence**. Pair it with an external check on `/health`, which catches the case where the Worker cannot answer at all |
| `key_rotation.unresolved_rows` | A rotation **finished** with rows nothing could re-wrap. Carries `unresolvedRows` and `safeToRetireOldKeys: false` | **Presence**, highest severity. Retiring the old key now makes those rows permanently undecryptable. Confirm against `GET /api/security/key-rotation` and leave both keys in the ring |
| `key_rotation.rows_quarantined` | A tick quarantined rows. Carries `quarantined`, `keyVersionUnavailable`, `unwrapFailed`, `table` | **Presence**. `keyVersionUnavailable` may be recoverable by restoring the missing key; `unwrapFailed` is data damage |
| `key_rotation.stalled` | A `key_rotations` row is `running` with `updated_at` older than 10 min. Carries `staleMs`, `phase`, `lastErrorCode` | **Presence**. Re-emitted every tick while stuck, so it cannot be missed by a short log window |
| `key_rotation.key_unavailable` | The tick could not build a key ring at all — usually a mistyped `ENCRYPTION_ACTIVE_KEY_VERSION`. Carries `code` | **Presence**. No rotation can run; writes keep using the last proven version, so it is not an outage |
| `key_rotation.tick_failed` | The tick threw. Most often migration 0006 is not applied. Carries `errorName` | **Presence** |
| `key_rotation.key_check_failed` | A key does not match the data it is supposed to protect. Carries `keyVersion` | **Presence**. Do not deploy further; the wrong key material is in play |
| `key_rotation.activation_refused` | A rotation refused to start because a key is missing or its check value no longer verifies. Carries `code`, `keyVersion` | **Presence** |
| `key_rotation.waiting_for_key` | A running rotation is held waiting for a key. Carries `code` | **Presence**. Emitted once per distinct code, so `key_rotation.stalled` is the one that keeps firing |
| `key_rotation.bootstrap_failed` | No `active` row in `encryption_keys` and the key does not match the data. Carries `code`, `retryAfterMs` | **Presence**. Expect ~4/hour, not 60: the attempt backs off 15 min (see above) |
| `sync.backlog` | Sync is stopped without any run failing this tick. Carries `overdue` (outbox rows past due by >15 min), `needsAttention` (targets parked; nothing retries them by itself), `abandoned` (runs that spent `MAX_SYNC_ATTEMPTS` in the last 24 h) | **Presence** of `needsAttention` or `abandoned`. **Rate** on `overdue` — a brief backlog is normal after a burst of changes; one that does not drain over several ticks is not |
| `sync.gave_up` | A run exhausted `MAX_SYNC_ATTEMPTS` and its retry marker was cleared. That target has stopped syncing permanently. Carries `targetId`, `attempt` | **Presence**. Emitted once per run — `sync.backlog`'s `abandoned` is the standing count |
| `sync.tick_step_failed` | One sweep step threw. Carries `step` | **Rate**. A single occurrence is tolerable; a sustained rate means the sweep is not running |
| `sync.enqueue_failed` | A secret change could not be queued for sync | **Rate** |
| `secret.decrypt_failed` | A single-secret read could not decrypt. Carries `secretId`, `environmentId`, `reason` | **Presence**. Should be zero — alert on the first one, not on a spike |
| `resolve.decrypt_failed` | An environment resolve could not decrypt. Carries `environmentId`, `reason`. One row on `enc_version 1` under `ENFORCE_AAD` makes the whole environment unreadable | **Presence**, as above |
| `email.budget_exhausted` | A daily send bucket is spent and a message was skipped. Carries `kind` (`verify`/`reset`), `purpose`, `limit` | **Presence**. `kind: "reset"` means account recovery is off |
| `email.budget_unavailable` | The rate limiter backing the budget failed, so the send was skipped and the cap is **not being enforced**. Carries `kind`, `purpose` | **Presence** |
| `email.not_configured` | No `EMAIL` binding or no `MAIL_FROM`; nothing is being sent | **Presence**. Once per isolate (section 6) |
| `email.send_failed` | The provider rejected a message. Carries `code` (section 6) | **Rate**, plus **presence** for `SENDER_NOT_VERIFIED` |
| `rate_limit.degraded` | A fail-open scope fell back to the per-isolate counter because the Durable Object errored. The limit is now weak — not shared across isolates or colos. Carries `scope`, `occurrences`, `windowMs` | **Presence**. Throttled: the first occurrence in an isolate emits at once, then at most one line per minute per isolate, with `occurrences` carrying the suppressed count. Use `occurrences` for magnitude, never the line count |
| `rate_limit.unavailable` | A fail-closed scope returned 503, or an identity limit could not be consumed. Carries `scope`, `occurrences` | **Presence**, same throttle |
| `rate_limit.disabled` | Both the Durable Object **and** the in-isolate fallback failed: the request was not rate limited at all. Carries `scope`, `occurrences` | **Presence**, highest severity of the three. Should never fire |
| `share.unattributed_refused` | A share link was refused for having no attributable creator | **Rate** |
| `housekeeping.step_failed` | A retention or purge step threw. Carries `step`, `reason` | **Rate**. Sustained failure grows D1 until writes stop |
| `housekeeping.orphan_blobs` | The KV reconciliation pass found blobs. Carries `scanned`, `unreferenced`, `deleted` | **Rate** on `unreferenced` growing while `deleted` does not keep up (see above) |
| `housekeeping.swept` | The bounded retention deletes ran. Carries `auditRowsDeleted`, `shareLinksDeleted`, `authTokensDeleted`, `orgInvitesDeleted` | **Value**: any count sitting at its per-tick bound every tick means the sweep is not keeping up (`orgInvitesDeleted` at `INVITE_PURGE_PER_TICK` = 200 sustained is an invitation flood, not routine) |

Not covered by any of these, because the data to alert on is not recorded: see
"What is still not observable" at the end of this section.

### What is still not observable

- **D1 and KV quota exhaustion.** Both fail queries and writes mid-day once a free-plan daily
  limit is hit. Neither appears in `/health` (the KV probe is a read, and a read is not what
  fails), and the failures surface only as whatever error the calling path happens to return.
  Watch Cloudflare's own usage dashboard; there is no log line to match on.
- **Per-organisation sync staleness.** `sync.backlog` counts rows deployment-wide. Telling one
  organisation's stopped sync from another's needs the counts broken out per org, which the
  current tick does not compute.
- **Delivery of email.** "Sent" means the binding did not throw (section 6).

## 4. Routine tasks

| Task | Command |
|------|---------|
| Pending migrations | `pnpm --filter @hushvault/api db:migrations:list:production` |
| Live logs | `wrangler tail --env production` |
| Recent deployments | `wrangler deployments list --env production` |
| Rotate a Worker secret (e.g. JWT_SECRET) | `wrangler secret put JWT_SECRET --env production` (invalidates existing sessions, and re-pushes every synced secret — DEPLOYMENT.md § 3) |
| Confirm the email binding is live | `wrangler deploy --dry-run --env production` — look for `env.EMAIL` |
| Is a rotation safe to finish? | `GET /api/security/key-rotation` → `safeToRetireOldKeys` |

## 5. Incident response

### Leaked HushVault API key (`hv_live_...`)

1. Revoke it now: dashboard, or `DELETE /api/auth/api-keys/:id` as an authenticated user.
2. Pull the audit log filtered to that key (`actor_type = api_key`) for the exposure window.
3. Treat every secret that key could read as compromised: rotate those secret
   values at their source (cloud provider, database, third party), then update them in HushVault.
4. Issue a replacement key, scoped as narrowly as supported, and fix how it leaked.

### Leaked `ENCRYPTION_MASTER_KEY`

The key alone is not enough to read secrets: the attacker also needs D1 (wrapped
DEKs) and KV (ciphertext). Assess whether they could get those (Cloudflare token
leak, export file leak).

1. Determine what leaked alongside it. If a D1 export, KV dump or Cloudflare API
   token leaked too, assume **all** stored secret values are compromised.
2. Rotate every underlying secret at its source first: key rotation (section 1) re-wraps
   DEKs only, so it does not help if the attacker already holds D1 wraps, KV ciphertext and
   the old key. Then rotate the master key as in ENCRYPTION.md, and re-enter the new
   underlying values. Never just swap the key without the rotation procedure: existing
   secrets would become undecryptable.
3. Rotate `JWT_SECRET` and the Cloudflare API tokens as well.
4. Record the incident and consider notifying affected users.

### Leaked Cloudflare API token or GitHub secret

Revoke the token in the Cloudflare dashboard, create a new one, update the
GitHub Environment secret, review Worker deployment history
(`wrangler deployments list`) for unexpected versions and roll back if needed.

### Bad deploy

`wrangler rollback --env <env>`; see DEPLOYMENT.md for what rollback does not undo.

## 6. Transactional email

Issues #26 and #82. Code: `apps/api/src/lib/email.ts` (sender), `email-templates.ts` (bodies),
`account-security.ts` (budget), `routes/auth.ts` and `routes/members.ts` (callers).

### What sends mail

Five messages, and nothing else:

| Trigger | Message | Budget bucket |
|---|---|---|
| `POST /api/auth/register` | Verify your email address | `verify` |
| `POST /api/auth/verify-email/send` (resend) | Verify your email address | `verify` |
| `POST /api/auth/forgot-password` | Reset your password | `reset` |
| `POST /api/auth/reset-password` (after success) | Your password was changed | `reset` |
| `POST /api/orgs/:id/invites` | Join `<org>` on HushVault | `invite` |

Every send runs in the background after the response is decided, so **a failed send never
fails the request that triggered it**. One completed reset therefore spends **two** from the
`reset` bucket: the link, then the notice.

**The invitation mail is the only one an authenticated caller can point at an address of their
choosing**, which is why it has a bucket of its own (`invite`) and a per-organisation rate limit
(`invite-create`, 20/min) rather than a per-IP one. An admin whose session is stolen must not be
able to raise their mail allowance by changing IP, and a run of invitations must not be able to
empty the bucket that sign-up verification or password reset depends on.

It is also the only one whose failure is **recoverable without the mail**: the create response
hands the admin a single-use `acceptUrl` they can pass on themselves. That is not a convenience —
with the production `EMAIL` binding commented out (below), it is currently the *only* path an
invitation has on production. The link works once, expires in 7 days, and only for the address it
was issued to, so passing it on by Slack is no worse than the email would have been.

**Before invitations work in production, an operator needs all three of:**

1. the `EMAIL` send_email binding uncommented on `[env.production]` and the sender domain onboarded
   (#75) — without it the mail is silently not sent and the handed-back link is the only path;
2. `MAIL_FROM` matching the binding's `allowed_sender_addresses` (already set);
3. `WEB_APP_URL` set for the environment — the link is built from it and **nothing else**, never
   from a request `Host` or `Origin` header. Unset or unparseable and `acceptUrl` comes back `null`
   and no mail goes out at all, with no error to the caller. It is set on `dev` and `production`
   today.

No new secret and no new variable are needed. `EMAIL_DAILY_BUDGET` is shared config and already
applies per bucket, so raising it raises all three.

### Configuration

| Setting | Where | Notes |
|---|---|---|
| `send_email` binding named `EMAIL` | `wrangler.toml`, per env (non-inheritable) | Live on `[env.dev]`. **Commented out on production** pending domain onboarding (#75) |
| `MAIL_FROM` | `[vars]`, per env | `no-reply@hushvault.dev`. Must match `allowed_sender_addresses` on the binding |
| `EMAIL_DAILY_BUDGET` | `[vars]`, optional | Global sends per day **per bucket**. Default 200 |
| `REQUIRE_VERIFIED_EMAIL` | `[vars]`, optional | When set, API-key creation **and** share-link creation require a verified address (403 `EMAIL_NOT_VERIFIED`). Off by default |

**With no binding, or no `MAIL_FROM`, nothing is sent and every auth endpoint still responds
normally.** That is deliberate — sign-in, registration and reset must not break because mail is
misconfigured — but it means a silent misconfiguration looks exactly like working software.
The only signal is one `email.not_configured` log line per isolate (logged once, not per send).

### Rate limits and budgets

Four layers, outermost first:

- **Per IP** — `auth-forgot` 5/min on forgot-password, `auth-token-submit` 10/min on
  verify-email and reset-password. Both fail **closed** (503) if the limiter is unavailable.
- **Per email address** — `forgot-email`, 3/hour, keyed on a hash of the address, so the
  address never becomes a limiter key.
- **Per user** — resend is 1/min and 5/hour (`verify-send-min`, `verify-send-hour`).
- **Per organisation** — `invite-create`, 20/min, on `POST /api/orgs/:id/invites`, keyed on the
  organisation named in the path. Fails **closed**. The partial unique index `org_invites_open_idx`
  is a second, harder cap on the same abuse: one open invitation per address per organisation, so
  the same address cannot be mailed again until the first invitation is revoked or accepted.
- **Global daily, per bucket** — `email-send-verify`, `email-send-reset` and `email-send-invite`,
  default 200/day each. Three buckets on purpose: a sign-up flood, or a run of invitations, must
  not be able to exhaust the budget that account recovery depends on.

`spendEmailBudget` returns false both when the budget is spent **and when the Durable Object
limiter is unavailable**, and the caller then silently skips the send. So "no mail" can mean
"budget spent" or "limiter down", and the two are not distinguished.

### Error codes

`mapEmailError` collapses provider errors into these; provider detail never leaves the module
and never reaches a client.

| Code | Means | Action |
|---|---|---|
| `EMAIL_NOT_CONFIGURED` | No binding or no `MAIL_FROM` | Config, not an incident. See the table above |
| `RECIPIENT_SUPPRESSED` | Provider is refusing this address (earlier bounce or complaint) | Remove it from the suppression list in the dashboard, or the user needs a different address |
| `RATE_LIMITED` | Provider's own limit, not ours | Check the provider quota; ours is below it by design |
| `SENDER_NOT_VERIFIED` | `MAIL_FROM` is not an allowed sender for the binding | Domain onboarding or `allowed_sender_addresses` mismatch |
| `SEND_FAILED` | Anything else | Check the logs for the preceding line |

### Log events to search

All code-only: no address, link, token or subject is ever logged.

```
email.not_configured              # once per isolate; the binding or MAIL_FROM is missing
email.send_failed                 # carries `code` from the table above
email.budget_exhausted            # the daily bucket is spent; carries `kind`, `purpose`, `limit`
email.budget_unavailable          # the limiter behind the budget failed; carries `kind`, `purpose`
```

`email.budget_exhausted` and `email.budget_unavailable` are emitted by `spendEmailBudget` itself,
so **every** send path is covered — `purpose` says which one was skipped:

| `purpose` | `kind` | Skipped send |
|---|---|---|
| `registration` | `verify` | Verification mail on sign-up |
| `verify_resend` | `verify` | `POST /api/auth/verify-email/send` |
| `forgot_password` | `reset` | The password reset link |
| `password_changed` | `reset` | The heads-up notice after a reset completes |
| `org_invite` | `invite` | An organisation invitation (`POST /api/orgs/:id/invites`) |

The two events are separate because the remedy is: `budget_exhausted` means the cap did its job
(raise `EMAIL_DAILY_BUDGET`, or find what is burning it), while `budget_unavailable` means the
rate limiter is broken and the cap **is not being enforced at all**.

### Diagnosing "the user did not get the email"

Work down this list; the first three are far more common than a provider problem.

1. **Is the binding live for that environment?** `wrangler deploy --dry-run --env <env>` lists
   it as `env.EMAIL (unrestricted - senders: ...)`. On production it is currently absent.
2. **Any `email.not_configured` in the logs?** If so, stop here — nothing was sent.
3. **Any `email.send_failed`?** The `code` tells you which row of the table applies.
4. **Budget or limiter?** Check for `email.budget_exhausted` (and `email.budget_unavailable`,
   which means the limiter itself failed). `purpose` names the exact send that was skipped.
   A spent `verify` bucket does not affect `reset`, and vice versa.
5. **Did a token get issued at all?** `SELECT purpose, created_at, used_at FROM auth_tokens
   WHERE user_id = ?`. A row with no mail means the send failed after the token was created;
   no row means the request was throttled or the address did not match an account.
   For an **invitation**: `SELECT id, role, created_at, expires_at, accepted_at, revoked_at FROM
   org_invites WHERE org_id = ? AND email = ?` (the address is stored lower-cased), and the audit
   trail distinguishes the two halves — `org.invite.create` means the row was written,
   `org.invite.sent` means a send was attempted. A create with no `sent` is a skipped send: the
   budget, the limiter, or an unset `WEB_APP_URL`. **Never select `token_hash` into a ticket or a
   chat message**; it identifies the invitation but it is credential-derived material and the `id`
   is what to quote. The remedy is almost always the same: revoke the invitation and have the admin
   send a new one, or have the admin pass on the `acceptUrl` from a fresh create.
6. **Only then suspect delivery.** Ask the recipient to check junk, then get the message source
   and read `Authentication-Results` (SPF/DKIM/DMARC) and, on Microsoft 365,
   `X-Forefront-Antispam-Report`. Microsoft has put HushVault verification mail in Junk while
   Gmail accepted it (#78 § A, open).

**Note what you cannot see from the outside.** `forgot-password` answers the same 202 whether
the address exists, does not exist, is OAuth-only, is throttled, or the send failed. That is
deliberate enumeration resistance and it is not negotiable — but it means the endpoint looks
identical when it is completely broken. This is not hypothetical: the reset path spent the
*verification* bucket for a time, so a few hundred registrations silently disabled account
recovery deployment-wide while the endpoint kept returning 202 (fixed in #80). **Alert on the
log lines, not on the status codes.**

### Suppression list

The provider maintains it; HushVault keeps no copy and has no API for it. A suppressed address
surfaces only as `RECIPIENT_SUPPRESSED` in the logs — the user sees nothing. Clearing an entry
is a dashboard action **[unverified: exact click path, confirm in Email Service docs]**.

### Quotas

Not quoted here, on purpose: the daily sending quota for a new Cloudflare Email Service account
was never confirmed **[unverified]**. Read it in the dashboard and set `EMAIL_DAILY_BUDGET`
below it, per bucket, remembering that a completed reset costs two.

### Known gaps

- ~~**`email.budget_exhausted` is only logged on the forgot-password path.**~~ **Fixed (#83).**
  The line moved into `spendEmailBudget`, the one place that can decide to skip a send, so
  registration mail and the password-changed notice are no longer silent and any future caller is
  covered by construction. `purpose` identifies the path; see the table above.
- **No delivery telemetry.** Nothing records that a message was accepted, bounced or opened, so
  "sent" means "the binding did not throw". Bounces are invisible except as a later
  `RECIPIENT_SUPPRESSED`.
- **Production is not sending.** The binding is commented out until #75 is done. For invitations
  that is survivable — the admin passes on the `acceptUrl` from the create response — but it means
  the invitation flow on production is a manual one today, and an admin who dismisses the panel
  before copying the link has to revoke the invitation and create a new one to get another.
- **An unset `WEB_APP_URL` looks exactly like working software**, the same trap as a missing
  binding: `buildTokenLink` returns null, no mail goes out, `acceptUrl` is `null`, and the
  invitation still returns `201`. There is no log line for it, because there is nothing wrong with
  the deployment other than the missing setting. Check it as step 0 in the list above when the
  environment is a new one.

## 7. GDPR erasure (account deletion)

Account deletion is **self-service**: the account owner calls `DELETE /api/account` (see
`docs/API.md`). There is no operator or admin endpoint that deletes another user's account, and
there is deliberately no SQL recipe here for doing it by hand — `DELETE FROM users` fails with
`FOREIGN KEY constraint failed` on the three `created_by` columns (issue #81), and the endpoint is
the only thing that nulls them, sweeps the KV blobs and keeps an organisation's last-owner
invariant. Point the person at the endpoint rather than deleting rows.

**What a deletion reaches.** For each organisation where the user is the **sole member**, the whole
organisation is erased: D1 cascades projects → environments → secrets, members, org-scoped API keys
and refresh tokens, audit log, invitations, integration connections → sync targets →
items/runs/outbox, and OIDC rules; and the endpoint then deletes that organisation's encrypted
secret blobs from `SECRETS_KV` in the same request (KV is a separate store that no D1 cascade
reaches). For an organisation with **other members**, only the user's membership, refresh tokens
and API keys are removed. The user row goes last, which cascades their remaining memberships and
all their credentials.

**What a deletion does NOT reach — state this when asked.**

- **A shared secret the user did not solely own is not erased.** Deletion only sweeps KV blobs of
  organisations that are themselves erased (sole-member). A secret in an organisation that survives
  stays, by design — it belongs to the remaining members, not the departing user.
- **Superseded KV blob revisions are not individually chased from this path.** The current blob of
  every erased secret is deleted; any older `secret:{id}:{rev}` left by a value change is covered
  because `allSecretBlobKeys` enumerates every revision up to the pointer. A truly orphaned blob
  with no D1 row is left to the housekeeping sweep (§ 4), the same as every other delete path.
- **`user.delete` audit rows in OTHER organisations still name the user.** The row records the
  departure for the organisations that survive, with the user's id as a literal string in
  `resource_id` (so it outlives the `actor_id` null-ing). This is retained audit history, not
  erased — admins of a shared organisation keep the record that a member deleted their account.
- **Refusal is total.** If the user is the last owner of any shared organisation, the request is
  refused `409 LAST_OWNER` and nothing is deleted; they must transfer ownership first.

Deletion is **irreversible** and reaches no backup: it destroys integration connections (each the
only copy of an outbound credential) and sync targets, so any secrets HushVault had written to a
provider are stranded on that provider and can no longer be reconciled or cleaned up remotely.
