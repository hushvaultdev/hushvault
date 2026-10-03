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
| Key derivation (password) | PBKDF2-SHA256, 100,000 iterations | WebCrypto compatible; Argon2 not viable in Workers. **Below current guidance — see the note below.** |

> **PBKDF2 iteration count: a known deviation.** OWASP's Password Storage Cheat Sheet currently
> recommends **600,000** iterations for PBKDF2-HMAC-SHA256; this deployment uses 100,000, which is
> one sixth of that. The reason is the Workers CPU-time limit, and that reason has been asserted
> rather than measured — 600,000 iterations of PBKDF2-SHA256 is on the order of a few hundred
> milliseconds of CPU, which may well fit the paid-plan budget for a login. It is stated here
> because it will be the first finding of any security questionnaire, and it should be either
> measured and raised or deliberately accepted, not left implicit.
> Source: <https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html>
| IV/nonce | Random, `crypto.getRandomValues()` | Must be unique per encryption operation |
| Key size | 256 bits | Maximum AES strength |
| IV size | 96 bits (12 bytes) | Required for GCM mode |
| Auth tag | 128 bits | Default, maximum for GCM |

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
value AAD = "hushvault|value|v2|<projectId>|<envId>|<secretId>"   (history blobs reuse their secret's context)
wrap  AAD = "hushvault|wrap|v2|<secretId>"                         (no key version, so rotation can re-wrap)
```
A blob copied to another environment, project or secret, or paired with another secret's wrapped DEK, fails
authentication and returns `DECRYPTION_FAILED`. The D1 `enc_version` column decides the format; a blob that
disagrees is rejected (no silent downgrade). **Limits:** AAD stops cross-record swaps; it cannot stop an
attacker with D1 *and* KV write from restoring an older valid (blob, wrapped DEK) pair for the *same* secret.

Rows written before AAD are `enc_version = 1` (migration `0008`) and still read until you set
`ENFORCE_AAD=true`. Upgrade them by re-saving each secret (any PATCH with a value re-encrypts as v2), check
`SELECT COUNT(*) FROM secrets WHERE enc_version = 1` and the same on `secret_history` (history rows only change
when the secret next changes; old history can be deleted instead), then set `ENFORCE_AAD=true` so a v1 row
can no longer be used for a downgrade.

**Integration credentials (issue #39)** use the same envelope and key ring but the tag `c2:` and a separate AAD domain:
```
credential AAD = "hushvault|credential|v2|<orgId>|<connectionId>"
wrap       AAD = "hushvault|credential-wrap|v2|<connectionId>"
```
A secret blob can therefore never be substituted for a credential (or the reverse), nor one connection's credential for
another's. Rotation re-wraps `integration_connections` as a third phase after `secrets` and `secret_history`, preserving the
`c2:` tag. An HKDF-derived per-purpose KEK is not implemented (the AAD domain separation is).

The IV and ciphertext+tag are stored together to enable decryption without separate IV storage.
There is no separate auth-tag segment: WebCrypto appends the 16-byte GCM tag to the ciphertext, so the
format has exactly two colon-separated parts.

## Where Values Are Stored

There is a single master key (`ENCRYPTION_MASTER_KEY`) for the whole deployment; there are no per-organisation
or per-project key-encryption keys. Each secret version has its own random DEK.

| What | Where | Key / column |
|------|-------|--------------|
| Encrypted value (`iv:ciphertext`) | KV (`SECRETS_KV`), stored as a plain string | `secret:{secretId}` |
| Wrapped DEK (`iv:wrappedKey`) | D1 `secrets.wrapped_dek` | per secret |
| Previous encrypted value | KV | `secrethist:{historyId}` |
| Previous wrapped DEK | D1 `secret_history.wrapped_dek` | per history row |

Updating a secret value generates a new DEK, writes the old blob to `secrethist:{historyId}`, and records the
old wrapped DEK in `secret_history`. Renames and flag changes do not re-encrypt.

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
6. The job re-wraps `secrets` then `secret_history` in small batches (default 100 per tick, `ROTATION_BATCH_SIZE`), each row with a compare-and-swap update, and repeats a convergence pass for rows written by a stale isolate. It finishes as `completed` or `completed_with_errors` (rows it could not unwrap, or whose label names an unknown key version, are listed in `key_rotation_failures`; keep the old key until they are resolved). If a needed key is missing from the deployment the job stays `running`, records the error, and resumes by itself on the next tick once the key is restored.
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
