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

- `/health` returning non-200 (503 means D1 unreachable). CI smoke-tests it after
  each deploy; add an external uptime check against `https://api.hushvault.dev/health`
  (no monitor is configured by this repo).
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

Issue #26. Code: `apps/api/src/lib/email.ts` (sender), `email-templates.ts` (bodies),
`account-security.ts` (budget), `routes/auth.ts` (callers).

### What sends mail

Four messages, and nothing else:

| Trigger | Message | Budget bucket |
|---|---|---|
| `POST /api/auth/register` | Verify your email address | `verify` |
| `POST /api/auth/verify-email/send` (resend) | Verify your email address | `verify` |
| `POST /api/auth/forgot-password` | Reset your password | `reset` |
| `POST /api/auth/reset-password` (after success) | Your password was changed | `reset` |

Every send runs in the background after the response is decided, so **a failed send never
fails the request that triggered it**. One completed reset therefore spends **two** from the
`reset` bucket: the link, then the notice.

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
- **Global daily, per bucket** — `email-send-verify` and `email-send-reset`, default 200/day
  each. Two buckets on purpose: a sign-up flood must not be able to exhaust the budget that
  account recovery depends on.

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
email.budget_exhausted            # carries `kind`; see the gap below
```

### Diagnosing "the user did not get the email"

Work down this list; the first three are far more common than a provider problem.

1. **Is the binding live for that environment?** `wrangler deploy --dry-run --env <env>` lists
   it as `env.EMAIL (unrestricted - senders: ...)`. On production it is currently absent.
2. **Any `email.not_configured` in the logs?** If so, stop here — nothing was sent.
3. **Any `email.send_failed`?** The `code` tells you which row of the table applies.
4. **Budget or limiter?** Check for `email.budget_exhausted`, and check whether the rate
   limiter is healthy. A spent `verify` bucket does not affect `reset`, and vice versa.
5. **Did a token get issued at all?** `SELECT purpose, created_at, used_at FROM auth_tokens
   WHERE user_id = ?`. A row with no mail means the send failed after the token was created;
   no row means the request was throttled or the address did not match an account.
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

- **`email.budget_exhausted` is only logged on the forgot-password path.** The registration
  send and the password-changed notice skip silently when their bucket is spent. Alerting on
  this event will therefore miss verification mail drying up. Tracked on #83.
- **No delivery telemetry.** Nothing records that a message was accepted, bounced or opened, so
  "sent" means "the binding did not throw". Bounces are invisible except as a later
  `RECIPIENT_SUPPRESSED`.
- **Production is not sending.** The binding is commented out until #75 is done.
