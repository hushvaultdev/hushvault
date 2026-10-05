# Encryption Implementation

HushVault uses envelope encryption with AES-256-GCM via the WebCrypto API.

## Why Envelope Encryption?

Envelope encryption separates key material from encrypted data:
- Each secret has its own **Data Encryption Key (DEK)**
- All DEKs are encrypted with the **Master Key (KEK)**
- Rotating the master key only requires re-encrypting DEKs (not all secret values)
- Compromise of a single DEK exposes only one secret

## Algorithm Choices

| Operation | Algorithm | Why |
|-----------|-----------|-----|
| Secret encryption | AES-256-GCM | Authenticated encryption, prevents ciphertext tampering |
| DEK wrapping | AES-256-GCM | Same algorithm, KEK as key |
| Key derivation (password) | PBKDF2-SHA256, 100K iterations | WebCrypto compatible; Argon2 not viable in Workers. Below OWASP's 600K — see [PBKDF2 iteration count](#pbkdf2-iteration-count-measured) |
| IV/nonce | Random, `crypto.getRandomValues()` | Must be unique per encryption operation |
| Key size | 256 bits | Maximum AES strength |
| IV size | 96 bits (12 bytes) | Required for GCM mode |
| Auth tag | 128 bits | Default, maximum for GCM |

## PBKDF2 iteration count (measured)

Status legend: **[verified]** = measured here, or quoted from Cloudflare's docs with the URL;
**[unverified]** = not confirmed in this environment, check before relying on it.
Tracked in [issue #89](https://github.com/hushvaultdev/hushvault/issues/89).

`hashPassword()` in `apps/api/src/lib/auth.ts` derives password hashes with PBKDF2-HMAC-SHA256,
**100,000 iterations**, 256-bit output, 16-byte random salt per user. OWASP's Password Storage
Cheat Sheet recommends **600,000** for PBKDF2-HMAC-SHA256 **[verified]** — read from the cheat
sheet's own source, which quotes "PBKDF2-HMAC-SHA256: 600,000 iterations (recommended)" alongside
220,000 for PBKDF2-HMAC-SHA512
(<https://github.com/OWASP/CheatSheetSeries/blob/master/cheatsheets/Password_Storage_Cheat_Sheet.md>;
the rendered site at cheatsheetseries.owasp.org is egress-blocked from the dev container, so the
repository source was used instead).

The reason given for 100,000 has always been the Workers CPU-time limit. That reason is now
measured rather than asserted.

### What it costs

Harness: `apps/api/scripts/bench-pbkdf2.mjs` plus `pbkdf2-bench.worker.js` /
`pbkdf2-bench.wrangler.toml` (same directory). It is not part of the test suite and nothing is
deployed; run it from `apps/api/` with `pnpm bench:pbkdf2` (add `--help` notes in the script
header for options). Timings only — the harness derives from throwaway random bytes and never
prints password, salt or key material.

Median of 7 runs, 3 derivations per run, measured 2026-10-05. **[verified]** by running the
harness:

| Iterations | `workerd` via local `wrangler dev` | bare Node.js 22 (**not** Workers) |
|-----------:|----------------------------------:|---------------------------------:|
| 100,000 (today) | 52.6 ms | 45.5 ms |
| 300,000 | 135.0 ms | 138.7 ms |
| 600,000 (OWASP) | 277.6 ms | 295.5 ms |
| 1,000,000 | 454.1 ms | 465.1 ms |

Method: wall clock measured from outside the Worker over HTTP with the request overhead
(median of a 1-iteration request, ~7 ms) subtracted and divided by the number of derivations.
`performance.now()` inside the local Worker agreed to within 1 ms at every iteration count.
Cost is linear in the iteration count, as expected. A second full run on the same machine gave
47.2 / 135.6 / 279.0 / 446.8 ms — repeatable to about 10%.

Environment caveats, all **[unverified]** against the edge:

- This is **local `workerd`** on a dev container CPU, not a deployed Worker on Cloudflare's
  network. Cloudflare's own machines may be faster or slower.
- Local `wrangler dev` reports no CPU accounting, so these are wall-clock numbers for a
  CPU-bound operation, not the `cpuMs` Cloudflare would bill. For a pure-CPU loop with no I/O
  the two should be close, but that equality is not verified here.
- The local runtime is slightly older than the deployed one: `wrangler` 4.92.0 (pinned in
  `apps/api/package.json`) bundles `workerd` 1.20260515.1, which refuses compatibility dates
  after 2026-05-22, so the bench config uses that date instead of the API's 2026-09-29.

Getting the real number means deploying the harness Worker to the `dev` environment and reading
`cpuMs` from `wrangler tail` or Workers Logs. That is a deploy, so it is deliberately not done
here.

### What the limit actually is

Cloudflare's documented CPU time per request
(<https://developers.cloudflare.com/workers/platform/limits/#cpu-time>):

| Limit | Workers Free | Workers Paid |
|-------|--------------|--------------|
| CPU time per HTTP request | 10 ms | 5 min (default: 30 seconds) |

> "CPU time measures how long the CPU spends executing your Worker code. Waiting on network
> requests (such as `fetch()` calls, KV reads, or database queries) does **not** count toward
> CPU time."

The default is configurable on the Paid plan via a `[limits]` block — up to 300,000 ms
(<https://developers.cloudflare.com/workers/wrangler/configuration/#limits>):

```toml
[limits]
cpu_ms = 300_000
```

Two notes on that block: "Limits are only supported for the Standard Usage Model" and "Limits are
only enforced when deployed to Cloudflare's network, not in local development". `apps/api/wrangler.toml`
has no `[limits]` block today, so the API Worker runs on the plan default.

### Conclusion

Against the Paid plan's 30-second default, 600,000 iterations at ~278 ms is **under 1% of the
per-request CPU budget** — it fits with about 100x of headroom, and no `[limits]` block is needed.
Even 1,000,000 iterations fits. The CPU-time limit is therefore **not** a valid reason to stay at
100,000 on a Paid plan.

Against the Free plan's 10 ms, nothing usable fits: 100,000 iterations already overruns it by 5x,
so password login on a Free-plan account was never within the documented limit. Which plan the
deployed account is on is **[unverified]** from this container — if logins work today on
`api-beta.hushvault.dev`, it is Paid (Durable Objects, which the rate limiter uses, are available
on both plans, so the `RATE_LIMITER` binding does not prove it either way).

Billing, at $0.02 per million CPU-ms on the Standard model
(<https://developers.cloudflare.com/workers/platform/pricing/>): a 600,000-iteration login costs
roughly 278 CPU-ms, about $0.0000056 — and the 30M included CPU-ms per month covers ~108,000
logins at that cost before any overage. Negligible at HushVault's scale.

**Recommendation: raise to 600,000**, with two conditions attached, because the cost is paid by
an unauthenticated endpoint:

1. Confirm the account is on Workers Paid first (see above).
2. Land the per-account login throttling tracked in
   [#77](https://github.com/hushvaultdev/hushvault/issues/77) first or alongside. `POST /auth/login`
   derives a hash for **every** attempt, including unknown emails and OAuth-only users (that is
   deliberate — it keeps response time from revealing whether an email is registered). Raising the
   count multiplies the CPU an unauthenticated caller can burn per request by 6x, and the existing
   limiters are per IP.

This is a change to how passwords are stored; it is the repo owner's decision and is not applied
by the measurement work.

### Migration path if the count is raised

Raising the constant in place would invalidate every existing password, because the stored hash is
not reproducible at a different iteration count. The migration is a per-row count plus a lazy
re-derivation:

1. Migration adds `users.pbkdf2_iterations INTEGER NOT NULL DEFAULT 100000` (new column, so the
   migration is not re-runnable — `wrangler d1 migrations apply` tracks that; see
   `.claude/rules/database-schema.md`). New rows are written with the new constant.
2. `hashPassword()` takes the iteration count as a parameter instead of hard-coding it;
   `verifyPassword()` verifies with the count stored on the user's row, so old hashes keep working.
3. On a **successful** login where the stored count is below the current target, re-derive the hash
   from the password already in hand at the new count and write back the new hash, salt and count
   in one statement. Only successful logins upgrade, so a wrong password never triggers the extra
   derivation. The upgrade adds one more derivation (~278 ms CPU) to that one login.
4. Users who never log in again keep their 100,000-iteration hash; a residual count by
   `pbkdf2_iterations` shows how many are left. Nothing forces them off it short of a password
   reset, which derives fresh at the current count anyway.
5. The same per-row count makes any future raise a configuration change rather than another
   migration.

## Code Location

All cryptographic operations are in `apps/api/src/crypto/envelope.ts`.

**Do not duplicate crypto logic elsewhere.** If you need encryption in a new route, import from `envelope.ts`.

## Functions

```typescript
// Encrypt a secret value
encryptSecret(value: string, masterKeyBase64: string): Promise<{
  encryptedValue: string  // "base64(iv):base64(ciphertext+authTag)"
  wrappedDek: string      // "base64(iv):base64(wrappedKey+authTag)"
}>

// Decrypt a secret value
decryptSecret(
  encryptedValue: string,
  wrappedDek: string,
  masterKeyBase64: string
): Promise<string>

```

## Ciphertext Format

Both `encryptedValue` and `wrappedDek` use the same format:
```
base64(iv) + ":" + base64(ciphertext || authTag)
```

Example:
```
abc123def456==:xyz789uvw012==
```

**Version 2 (current, `enc_version = 2`)** adds a `v2:` prefix and binds the ciphertext to its record with
AES-GCM additional authenticated data (AAD):
```
v2:base64(iv):base64(ciphertext || authTag)
value AAD = "hushvault|value|v2|<projectId>|<envId>|<secretId>"   (every revision of a secret shares this context)
wrap  AAD = "hushvault|wrap|v2|<secretId>"                         (no key version, so rotation can re-wrap)
```
A blob copied to another environment, project or secret, or paired with another secret's wrapped DEK, fails
authentication and returns `DECRYPTION_FAILED`. The D1 `enc_version` column decides the format; a blob that
disagrees is rejected (no silent downgrade). **Limits:** AAD stops cross-record swaps; it cannot stop an
attacker with D1 *and* KV write from restoring an older valid (blob, wrapped DEK) pair for the *same* secret.

Rows written before AAD are `enc_version = 1` (migration `0008`) and still read until you set
`ENFORCE_AAD=true`. Upgrade them by re-saving each secret (any PATCH with a value re-encrypts as v2), check
`SELECT COUNT(*) FROM secrets WHERE enc_version = 1`, then set `ENFORCE_AAD=true` so a v1 row can no longer
be used for a downgrade. `secret_history` used to need the same treatment and no longer exists (issue #84).

**Integration credentials (issue #39)** use the same envelope and key ring but the tag `c2:` and a separate AAD domain:
```
credential AAD = "hushvault|credential|v2|<orgId>|<connectionId>"
wrap       AAD = "hushvault|credential-wrap|v2|<connectionId>"
```
A secret blob can therefore never be substituted for a credential (or the reverse), nor one connection's credential for
another's. Rotation re-wraps `integration_connections` as a second phase after `secrets`, preserving the
`c2:` tag. An HKDF-derived per-purpose KEK is not implemented (the AAD domain separation is).

The IV and ciphertext+tag are stored together to enable decryption without separate IV storage.
There is no separate auth-tag segment: WebCrypto appends the 16-byte GCM tag to the ciphertext, so the
format has exactly two colon-separated parts.

## Where Values Are Stored

There is a single master key (`ENCRYPTION_MASTER_KEY`) for the whole deployment; there are no per-organisation
or per-project key-encryption keys. Each secret version has its own random DEK.

| What | Where | Key / column |
|------|-------|--------------|
| Encrypted value (`iv:ciphertext`) | KV (`SECRETS_KV`), stored as a plain string | `secret:{secretId}:{blobRev}` (`secret:{secretId}` at revision 0) |
| Wrapped DEK (`iv:wrappedKey`) | D1 `secrets.wrapped_dek` | per secret — exactly one, for the current revision |

Updating a secret value generates a new DEK, writes the ciphertext to the next revision — a KV key that has
never been written — and then moves `secrets.blob_rev` in D1. D1 is the single source of truth, so a failed
D1 write leaves an orphaned blob and a still-readable secret (migration 0014 explains why that order is the
safe one). Renames and flag changes do not re-encrypt.

**No previous value is retained.** The superseded ciphertext stays in KV under its own revision, but the only
wrapped DEK that could decrypt it has been overwritten, so it is unreadable by anyone — including an operator
with full D1 and KV access. Migration 0017 removed `secret_history`, which was the one place a superseded
wrapped DEK was kept, and nothing read it (issue #84). Two consequences worth stating plainly: replacing a
value is irreversible, and that is also what gives an organisation a "forget" path it never had before.

The retained older revisions are collected by nothing on purpose: the cron's orphaned-blob sweep counts
`rev <= secrets.blob_rev` as referenced, because that is what lets a secret recover after a D1
point-in-time restore (OPERATIONS.md § 2). They cost storage and reveal nothing.

## Master Key Setup

Generate a new master key for production:
```bash
node -e "const k = new Uint8Array(32); crypto.getRandomValues(k); console.log(Buffer.from(k).toString('base64'))"
```

Set in Cloudflare Workers:
```bash
wrangler secret put ENCRYPTION_MASTER_KEY
```

**Never** put the master key in `wrangler.toml`, source code, or `.dev.vars` that gets committed.

## Key Rotation

Rotation replaces the key (KEK) that wraps each secret's DEK. It is operator-driven (a deploy), not an API call, and it never decrypts or rewrites secret values: only the wrapped DEKs in D1 are re-wrapped, so KV is untouched. Issue #27.

**Key ring.** Each key version is its own Worker secret: `v1` is the existing `ENCRYPTION_MASTER_KEY` (kept as is), `v2` is `ENCRYPTION_KEY_V2`, and so on. `ENCRYPTION_ACTIVE_KEY_VERSION` (a plain var in `wrangler.toml`, default `v1`) selects the key for new writes. Every read uses the key named by the row's `key_version`. A missing key returns the opaque `DECRYPTION_FAILED` error and logs only the version label (`KEY_VERSION_UNAVAILABLE`).

**Writes use the version the tick has validated.** POST/PATCH wrap new DEKs with the version registered as `active` in D1 (before the first tick: `v1`), not with the raw `ENCRYPTION_ACTIVE_KEY_VERSION` variable, so a mistyped new key is never used for writes before the cron has checked it. On the first tick of a populated database the cron registers the version the existing rows use, after sanity-checking it against a real wrapped DEK, and then rotates if the variable names a different version.

**Order matters (this is what makes it zero downtime):** add the key, then activate it, then re-wrap, then retire the old key last.

1. Generate the new key on a trusted machine (`openssl rand -base64 32`) and **back it up offline in two places first**. A Worker secret cannot be read back (unverified), so the backup is the only copy.
2. `wrangler secret put ENCRYPTION_KEY_V2 --env <env>`. Every isolate can now decrypt v2; nothing changes yet.
3. Safety point: `wrangler d1 export` and note the `d1 time-travel info` bookmark (OPERATIONS.md section 2).
4. Set `ENCRYPTION_ACTIVE_KEY_VERSION = "v2"` for that env in `wrangler.toml` and deploy. New writes use v2.
5. Within a minute the Cron Trigger notices the active version changed. It verifies both keys against their stored check values (fail closed on a mistyped key), marks v1 `decrypt_only`, starts a job, and writes `key.rotation.started` to every organisation's audit log.
6. The job re-wraps `secrets` then `integration_connections` in small batches (default 100 per tick, `ROTATION_BATCH_SIZE`), each row with a compare-and-swap update, and repeats a convergence pass for rows written by a stale isolate. It finishes as `completed` or `completed_with_errors` (rows it could not unwrap, or whose label names an unknown key version, are listed in `key_rotation_failures`; keep the old key until they are resolved). If a needed key is missing from the deployment the job stays `running`, records the error, and resumes by itself on the next tick once the key is restored.
7. Check progress with `GET /api/security/key-rotation` (org admins/owners; per-version row counts for their own organisation).
8. Retire v1 only when no row uses it **and** every backup or export you might restore has aged out (at least the 30-day Time Travel window, longer for retained exports). Then `wrangler secret delete ENCRYPTION_MASTER_KEY` and keep the offline copy as long as any backup needs it.

**Rollback:** every row is always decryptable (old or new key), so set `ENCRYPTION_ACTIVE_KEY_VERSION` back and deploy. The job pauses and a reverse rotation starts.

**Do not roll back to code older than this feature once any row is on a newer version** (older code cannot read it and its PATCH does not record the key version). After a completed rotation, rows written under the old version by a stale isolate or a restored backup are not re-detected automatically: check `oldVersionsInUse` on the status endpoint, and toggle `ENCRYPTION_ACTIVE_KEY_VERSION` away and back to start a new job.

**Limit:** re-wrapping does not help if an attacker already holds D1 wraps, KV ciphertext and the old key, because the DEKs are unchanged. In that case rotate the underlying secrets at their source (OPERATIONS.md section 5). A re-encrypt mode is not built (issue #70).

Internals: `apps/api/src/crypto/envelope.ts` (key ring, `rewrapDek`, key checks), `apps/api/src/lib/key-rotation.ts` (engine), migration `0006_key_rotation.sql`.

## API token rotation

API authentication tokens (for CLI login, GitHub Actions, or automation integrations) are managed separately from encryption keys. To rotate an API token:

1. Issue a replacement token.
2. Update the consuming workflow or environment to use the new token.
3. Revoke the old token after confirming the new token works.

This keeps authentication rotation independent from the master key rotation process.

## Testing

Crypto tests live in `apps/api/test/envelope.test.ts`; rotation tests in `apps/api/test/key-rotation.test.ts` and `apps/api/test/key-ring-routes.test.ts`.

Tests must cover:
- Encrypt → decrypt roundtrip (same value returned)
- Different secrets produce different ciphertexts (non-deterministic)
- Decryption with wrong key throws
- Decryption with tampered ciphertext throws (GCM auth tag check)
- PBKDF2 derivation produces consistent key from same password+salt
