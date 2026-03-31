# Crypto Audit Skill

Audit all cryptographic code in HushVault for security issues.

## When to Use

Use `/crypto-audit` before any PR that touches:
- `apps/api/src/crypto/`
- `apps/api/src/routes/secrets.ts`
- `apps/api/src/routes/share.ts`
- `apps/api/src/middleware/auth.ts`
- Any file handling `ENCRYPTION_MASTER_KEY`, `JWT_SECRET`, or secret values

## Audit Checklist

Work through each item systematically:

### 1. IV / Nonce Generation
- Grep for `getRandomValues` — every AES-256-GCM encryption call must use a fresh random IV
- Grep for hardcoded byte arrays near encryption calls — flag any that look like IVs
- Verify IV is 12 bytes (96 bits) for GCM mode

### 2. Key Handling
- Grep for `ENCRYPTION_MASTER_KEY` — should only appear in `envelope.ts` and `index.ts` (Env type)
- Verify master key is never logged, returned in responses, or stored in D1/KV
- Check `importKey` calls use `['encrypt', 'decrypt']` usage, not `extractable: true`

### 3. Secret Value Exposure
- Grep for `console.log` in route files — flag any that might log secret values
- Check error responses never include plaintext secret values
- Verify KV puts only store `{ encryptedValue, wrappedDek }` — never plaintext

### 4. JWT Handling
- Verify `JWT_SECRET` only used in `middleware/auth.ts`
- Check token expiry is set (never infinite)
- Verify no JWT payload contains sensitive data

### 5. Share Links (Zero-Knowledge)
- Check that share link endpoints never receive the encryption key
- Key must be in URL fragment only (never sent to server, never in logs)
- Verify `viewCount` is atomically incremented and `maxViews` enforced

### 6. Dependencies
- Check `package.json` for any unexpected crypto libraries (should only use WebCrypto)
- Flag any `node:crypto` imports in `apps/api/`

## Output Format

Report findings as:
```
[CRITICAL] apps/api/src/routes/secrets.ts:45
  console.log(plaintext) — plaintext secret logged

[HIGH] apps/api/src/crypto/envelope.ts:12
  IV hardcoded as static value

[MEDIUM] apps/api/src/routes/auth.ts:89
  JWT expiry not set — tokens never expire

[INFO] apps/api/src/index.ts:3
  ENCRYPTION_MASTER_KEY referenced in Env type — OK
```

End with a summary: `N critical, N high, N medium, N info issues found.`
