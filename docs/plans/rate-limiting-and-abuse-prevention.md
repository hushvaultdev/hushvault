# Rate Limiting & Abuse Prevention

**Priority:** P0 — production security baseline before first real user
**Status:** Design approved, implementation pending

---

## Threat Model

| Threat | Route | Risk |
|--------|-------|------|
| Credential stuffing | `POST /api/auth/login` | Account takeover |
| Registration spam | `POST /api/auth/register` | Org pollution, free tier abuse |
| Share link enumeration | `GET /api/share/:slug` | Unauthenticated secret access |
| Secret brute force | `GET /api/secrets/:id` | Authenticated but high-volume |
| API abuse / DDoS | All `/api/*` | Service disruption |
| KV exhaustion | Secret write paths | Billing abuse on free tier |

---

## Layer 1 — Cloudflare WAF (Zero Code, Dashboard Config)

Set up before launch. Applies globally before Workers even execute.

```
Rule 1: Login rate limit
  Expression: (http.request.uri.path eq "/api/auth/login")
  Action:     Rate limit — 5 requests per IP per minute
  Response:   429, Retry-After: 60

Rule 2: Register rate limit
  Expression: (http.request.uri.path eq "/api/auth/register")
  Action:     Rate limit — 3 requests per IP per 10 minutes

Rule 3: Share link access
  Expression: (http.request.uri.path matches "^/api/share/")
  Action:     Rate limit — 20 requests per IP per minute

Rule 4: Bot protection on auth pages
  Expression: (http.request.uri.path matches "^/api/auth/")
  Action:     Cloudflare Turnstile challenge (JS challenge, no CAPTCHA UX friction)
```

Document CF WAF rules in `docs/DEPLOYMENT.md` — not in code.

---

## Layer 2 — Hono Middleware (Per-Org API Rate Limits)

KV-based sliding window counter. Runs in the Worker after auth.

```typescript
// apps/api/src/middleware/rate-limit.ts
import { createMiddleware } from 'hono/factory'
import type { Env } from '../index.js'

// Per-org limits by plan (requests per day)
const ORG_DAILY_LIMITS = {
  free: 1_000,
  pro: 10_000,
  team: 100_000,
  enterprise: -1,  // unlimited
} as const

export const orgRateLimit = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const user = c.get('user')
  if (!user) return next()

  const plan = c.get('orgPlan') ?? 'free'
  const limit = ORG_DAILY_LIMITS[plan]
  if (limit === -1) return next()  // enterprise: skip

  const today = new Date().toISOString().slice(0, 10)  // YYYY-MM-DD
  const kvKey = `ratelimit:${user.orgId}:${today}`

  // Atomic increment using KV metadata
  const current = parseInt(await c.env.SECRETS_KV.get(kvKey) ?? '0')

  if (current >= limit) {
    return c.json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: `Daily API limit of ${limit} requests reached`,
      upgrade: 'https://hushvault.dev/pricing',
      resetAt: `${today}T00:00:00Z`,  // resets at midnight UTC
    }, 429)
  }

  // Increment (fire and forget — non-blocking)
  c.executionCtx.waitUntil(
    c.env.SECRETS_KV.put(kvKey, String(current + 1), {
      expirationTtl: 86400,  // auto-expire after 24h
    })
  )

  c.header('X-RateLimit-Limit', String(limit))
  c.header('X-RateLimit-Remaining', String(limit - current - 1))
  return next()
})
```

---

## Layer 3 — Route-Specific Guards

### Login: timing attack prevention
```typescript
// Normalize response time to prevent user enumeration
// Always hash even when user not found (prevents timing difference)
const user = await db.select().from(users).where(eq(users.email, email)).get()
const storedHash = user?.passwordHash ?? '$argon2id$v=19$m=65536...'  // dummy
const valid = user ? await bcrypt.compare(password, storedHash) : false
// ^ Takes same time whether user exists or not
```

### Share link: enforce viewCount atomically
```typescript
// Use D1 returning clause + conditional update (atomic)
const result = await db.update(shareLinks)
  .set({ viewCount: sql`view_count + 1` })
  .where(and(
    eq(shareLinks.slug, slug),
    sql`(max_views IS NULL OR view_count < max_views)`,
    sql`(expires_at IS NULL OR expires_at > datetime('now'))`
  ))
  .returning({ viewCount: shareLinks.viewCount })
  .get()

if (!result) return c.json({ error: 'LINK_EXPIRED', message: 'This link has expired' }, 410)
```

---

## Layer 4 — Cloudflare Turnstile (Registration Bot Prevention)

```typescript
// apps/api/src/middleware/turnstile.ts
export async function verifyTurnstile(token: string, ip: string): Promise<boolean> {
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: process.env.TURNSTILE_SECRET_KEY,
      response: token,
      remoteip: ip,
    }),
  })
  const data = await response.json<{ success: boolean }>()
  return data.success
}
```

Dashboard sends `cf-turnstile-response` header on register/login forms.
`TURNSTILE_SECRET_KEY` set via `wrangler secret put`.

---

## Response Headers Contract

All 429 responses include:
```
HTTP/1.1 429 Too Many Requests
Retry-After: 60
X-RateLimit-Limit: 1000
X-RateLimit-Remaining: 0
Content-Type: application/json

{ "error": "RATE_LIMIT_EXCEEDED", "message": "...", "resetAt": "..." }
```
