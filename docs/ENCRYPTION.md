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
| Key derivation (password) | PBKDF2-SHA256, 100K iterations | WebCrypto compatible; Argon2 not viable in Workers |
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

// Derive a key from a password (for user-controlled keys)
deriveKeyFromPassword(password: string, saltBase64: string): Promise<CryptoKey>

// Generate a random salt
generateSalt(): string  // base64
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

The IV and ciphertext+tag are stored together to enable decryption without separate IV storage.

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

To rotate the master key:
1. Generate new master key (see above)
2. Write a migration script that:
   a. Fetches all `wrappedDek` values from D1
   b. Decrypts each DEK with old master key
   c. Re-encrypts each DEK with new master key
   d. Updates D1 records with new `wrappedDek`
3. Set new `ENCRYPTION_MASTER_KEY` secret in Wrangler
4. Deploy
5. Verify a sample secret decrypts correctly

The secret values in KV are **not** re-encrypted — only the DEKs are re-wrapped.

## Testing

Crypto tests live in `apps/api/src/crypto/envelope.test.ts`.

Tests must cover:
- Encrypt → decrypt roundtrip (same value returned)
- Different secrets produce different ciphertexts (non-deterministic)
- Decryption with wrong key throws
- Decryption with tampered ciphertext throws (GCM auth tag check)
- PBKDF2 derivation produces consistent key from same password+salt
