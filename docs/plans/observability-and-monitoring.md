# Observability & Monitoring

**Priority:** P3 — production operations
**Status:** Design approved, implementation deferred to post-MVP

---

## Structured Logging

Every request logs a structured event via `console.log` (Workers sends to Cloudflare Logpush):

```typescript
// apps/api/src/middleware/logger.ts
import { createMiddleware } from 'hono/factory'
import { nanoid } from 'nanoid'

export const requestLogger = createMiddleware(async (c, next) => {
  const requestId = nanoid(10)
  const start = Date.now()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)

  await next()

  const user = c.get('user')
  console.log(JSON.stringify({
    requestId,
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    durationMs: Date.now() - start,
    orgId: user?.orgId ?? null,
    userId: user?.id ?? null,
    cf: {
      country: c.req.raw.cf?.country,
      colo: c.req.raw.cf?.colo,
    },
  }))
})
```

---

## Error Tracking (Sentry)

```typescript
// apps/api/src/index.ts
import * as Sentry from '@sentry/cloudflare'

export default Sentry.withSentry(
  (env) => ({
    dsn: env.SENTRY_DSN,
    environment: env.ENVIRONMENT,
    tracesSampleRate: 0.1,  // 10% of requests
  }),
  {
    async fetch(request, env, ctx) {
      return app.fetch(request, env, ctx)
    },
  }
)
```

`SENTRY_DSN` set via `wrangler secret put SENTRY_DSN`.
Free tier (5K errors/month) sufficient for MVP.

---

## Cloudflare Analytics Engine

Track custom metrics without external service:

```typescript
// apps/api/src/lib/metrics.ts
export function trackEvent(
  env: Env,
  event: 'secret_read' | 'secret_write' | 'auth_success' | 'auth_failure',
  dimensions: { orgId?: string; plan?: string }
) {
  // Analytics Engine binding — add to wrangler.toml
  env.ANALYTICS?.writeDataPoint({
    blobs: [event],
    doubles: [1],
    indexes: [dimensions.orgId ?? ''],
  })
}
```

Query via Cloudflare GraphQL Analytics API for dashboard metrics.

**wrangler.toml addition:**
```toml
[[analytics_engine_datasets]]
binding = "ANALYTICS"
dataset = "hushvault_events"
```

---

## Health Endpoint

```typescript
// apps/api/src/routes/health.ts
router.get('/', async (c) => {
  // Lightweight D1 probe
  try {
    await drizzle(c.env.DB).run(sql`SELECT 1`)
    return c.json({ status: 'ok', version: '1.0.0', region: c.req.raw.cf?.colo })
  } catch {
    return c.json({ status: 'degraded', reason: 'database' }, 503)
  }
})
```

---

## Uptime Monitoring

- Cloudflare Health Checks on `GET /health` — alert if fails 3× in 5min
- Better Uptime (free tier) for public status page at `status.hushvault.dev`
- Status page: Cloudflare Pages static site, embed Better Uptime widget

---

## Alerting Thresholds

| Condition | Alert Channel | Urgency |
|-----------|--------------|---------|
| Error rate > 1% over 5min | Slack + PagerDuty | P1 |
| p95 latency > 2s | Slack | P2 |
| D1 write failure | Slack + PagerDuty | P1 |
| Stripe webhook processing failure | Slack | P2 |
| Health check failure 3× | PagerDuty | P1 |
| Auth failure rate > 10/min | Slack | P2 |

---

## KV Cache Metrics

Log cache hit/miss for plan cache to tune TTL:
```typescript
const cached = await c.env.SECRETS_KV.get(cacheKey)
trackEvent(env, cached ? 'plan_cache_hit' : 'plan_cache_miss', { orgId })
```
