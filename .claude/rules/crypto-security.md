---
description: Security rules for all cryptographic and secret-handling code
globs:
  - "apps/api/src/crypto/**/*.ts"
  - "apps/api/src/routes/**/*.ts"
  - "apps/api/src/middleware/**/*.ts"
  - "apps/cli/src/config/auth.ts"
---

# Cryptographic Security Rules

## Absolute Rules (Never Break)

- **NEVER** log, `console.log`, `console.error`, or embed secrets, keys, IVs, or DEKs in any message
- **NEVER** hardcode keys, salts, or IVs — always use `crypto.getRandomValues()`
- **NEVER** implement custom encryption algorithms — use `crypto.subtle` (WebCrypto) only
- **NEVER** include plaintext secret values in API responses beyond the immediate fetch request
- **NEVER** store plaintext secrets in D1 — only encrypted blobs in KV + wrapped DEKs in D1
- **NEVER** use `Math.random()` for cryptographic purposes

## Required Patterns

### Key Generation
```typescript
// Correct: cryptographically random
const iv = crypto.getRandomValues(new Uint8Array(12))
const salt = crypto.getRandomValues(new Uint8Array(16))

// WRONG: never do this
const iv = Buffer.from('hardcoded-iv-value')
```

### Envelope Encryption
Always use `encryptSecret` / `decryptSecret` from `apps/api/src/crypto/envelope.ts`.
Do not duplicate encryption logic elsewhere.

### Error Handling
```typescript
// Correct: opaque error
return c.json({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' }, 500)

// WRONG: exposes internals
return c.json({ error: err.message, key: masterKey }, 500)
```

## Cloudflare Workers Constraints

- Use `crypto.subtle` (WebCrypto) — not `node:crypto`
- No Argon2 — use PBKDF2-SHA256 with 100,000 iterations (WebCrypto compatible)
- AES-256-GCM for all symmetric encryption (256-bit key, 96-bit IV, 128-bit tag)

## Code Review Checklist

Before committing crypto code:
- [ ] No secrets in log statements
- [ ] IVs generated with `crypto.getRandomValues()`
- [ ] No hardcoded keys or salts
- [ ] Error messages are opaque (no internal state)
- [ ] Uses `envelope.ts` functions, not ad-hoc crypto
- [ ] Tests cover happy path + decryption failure cases
