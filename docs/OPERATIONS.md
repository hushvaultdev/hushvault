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
- `wrangler d1 migrations apply` captures a backup before applying
  **[verified: `wrangler d1 migrations apply --help`]**.
- Manual export (not automatic; schedule it yourself if you want off-Cloudflare copies):
  `wrangler d1 export hushvault-db --remote --output backup-$(date +%F).sql`
  **[verified: `wrangler d1 export --help`]**. Exports contain wrapped DEKs and user data;
  store them encrypted, and remember they are useless without the KV blobs and master key.

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

## 4. Routine tasks

| Task | Command |
|------|---------|
| Pending migrations | `pnpm --filter @hushvault/api db:migrations:list:production` |
| Live logs | `wrangler tail --env production` |
| Recent deployments | `wrangler deployments list --env production` |
| Rotate a Worker secret (e.g. JWT_SECRET) | `wrangler secret put JWT_SECRET --env production` (invalidates existing sessions) |

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
