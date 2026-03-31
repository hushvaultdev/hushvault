# Security Hardening

**Priority:** P3 — API hardening, enterprise questionnaires
**Status:** Design approved, implementation deferred to post-MVP

---

## Security Headers Middleware

Add as the first middleware in `apps/api/src/index.ts` (before routes):

```typescript
// apps/api/src/middleware/security-headers.ts
import { createMiddleware } from 'hono/factory'

export const securityHeaders = createMiddleware(async (c, next) => {
  await next()
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload')
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('X-Frame-Options', 'DENY')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  // CSP: API returns JSON only — no scripts, no frames
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
})
```

---

## CORS Hardening

```typescript
// apps/api/src/index.ts
import { cors } from 'hono/cors'

const ALLOWED_ORIGINS = env.ENVIRONMENT === 'production'
  ? ['https://hushvault.dev', 'https://app.hushvault.dev']
  : ['http://localhost:3000', 'https://hushvault.dev']

app.use('*', cors({
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : null,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))
```

**Never** allow `*` in production. `ENVIRONMENT` env var gates this.

---

## API Key Format

`hv_live_{base58(32bytes)}` for production.
`hv_test_{base58(32bytes)}` for test/dev environments.

Prefix scheme enables:
- GitGuardian, TruffleHog, GitHub secret scanning to auto-detect leaked keys
- HushVault's own secret scanning to identify its own leaked keys

Storage: SHA-256 hash only (never plaintext). Last 4 chars stored for display: `hv_live_...ab3f`.

---

## JWT Hardening

```typescript
// Validate explicitly — never trust alg from token header
const payload = await verify(token, secret, {
  algorithms: ['HS256'],      // whitelist — reject alg:none, RS256, etc.
  audience: 'hushvault-api',
  issuer: 'hushvault',
})
```

Access token: 15min expiry.
Refresh token: 7d, rotated on use, single-use.
OIDC tokens (GitHub Actions): 1hr expiry, scoped to specific env.

---

## Secret Value Limits

```typescript
// Reject at API boundary
const MAX_SECRET_VALUE_BYTES = 65_536  // 64KB
if (new TextEncoder().encode(value).byteLength > MAX_SECRET_VALUE_BYTES) {
  return c.json({ error: 'VALIDATION_ERROR', message: 'Secret value exceeds 64KB limit' }, 400)
}

const MAX_SECRET_KEY_LENGTH = 256
if (key.length > MAX_SECRET_KEY_LENGTH) {
  return c.json({ error: 'VALIDATION_ERROR', message: 'Secret key exceeds 256 character limit' }, 400)
}
```

---

## Dependency Audit

Add to CI (`ci.yml`):
```yaml
- name: Security audit
  run: pnpm audit --audit-level=high
```

Fail CI on high/critical vulnerabilities. Medium: warn only.
Renovate or Dependabot for automated dependency update PRs.

---

## security.txt

Served by the Worker at `GET /.well-known/security.txt`:
```
Contact: security@hushvault.dev
Expires: 2027-03-31T00:00:00.000Z
Preferred-Languages: en
Policy: https://hushvault.dev/security/policy
```

---

## Cloudflare WAF Managed Ruleset

Enable in Cloudflare dashboard under Security → WAF:
- Cloudflare Managed Ruleset (SQLi, XSS, RFI detection) on `/api/*`
- Score-based blocking: requests scoring > 30 → block; 10–30 → challenge

Document in `docs/DEPLOYMENT.md` under "First-Time Setup".
