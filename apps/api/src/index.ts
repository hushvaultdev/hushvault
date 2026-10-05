import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { authRoutes } from './routes/auth'
import { healthRoutes } from './routes/health'
import { projectRoutes } from './routes/projects'
import { environmentRoutes } from './routes/environments'
import { secretRoutes } from './routes/secrets'
import { shareRoutes } from './routes/share'
import { auditRoutes } from './routes/audit'
import { ciAccessRouter } from './routes/ci-access'
import { integrationsRouter } from './routes/integrations'
import { securityRoutes } from './routes/security'
import { secretScannerRouter } from './routes/secret-scanner'
import { securityHeaders } from './middleware/security-headers'
import { globalApiRateLimit } from './middleware/auth'
import { RateLimiter } from './lib/rate-limiter-do'
import { SecretTooLargeError, logEvent, redactPath } from './lib/security'
import { housekeepingTick } from './lib/housekeeping'
import { rotationTick } from './lib/key-rotation'
import { syncTick } from './integrations/sync-scheduler'
import type { EmailBinding } from './lib/email'
import { registerProviders } from './integrations/providers'

export { RateLimiter }

registerProviders()

export type Env = {
  DB: D1Database
  SECRETS_KV: KVNamespace
  RATE_LIMITER: DurableObjectNamespace<RateLimiter>
  ENVIRONMENT: string
  // Key ring (docs/ENCRYPTION.md): v1 is ENCRYPTION_MASTER_KEY; vN is the secret ENCRYPTION_KEY_V<N>.
  ENCRYPTION_MASTER_KEY: string
  ENCRYPTION_ACTIVE_KEY_VERSION?: string
  ENFORCE_AAD?: string
  ROTATION_BATCH_SIZE?: string
  /** Set to "1" to stop the orphaned-blob sweep. Required before a D1 restore — OPERATIONS.md § 2. */
  DISABLE_ORPHAN_SWEEP?: string
  // Transactional email (issue #26): Cloudflare Email Service binding + sender address.
  EMAIL?: EmailBinding
  MAIL_FROM?: string
  // Daily cap on verification/reset mail (default 200); REQUIRE_VERIFIED_EMAIL=1 gates sensitive actions.
  EMAIL_DAILY_BUDGET?: string
  REQUIRE_VERIFIED_EMAIL?: string
  JWT_SECRET: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  // OAuth (web sign-in). Optional: each provider's routes return 503 until set.
  GITHUB_OIDC_ISSUER?: string
  GITHUB_OIDC_JWKS_URL?: string
  GITHUB_OIDC_AUDIENCE?: string
  API_PUBLIC_URL?: string
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // Base URL of the dashboard, used as the OAuth success redirect target.
  WEB_APP_URL?: string
  // Extra Worker names (comma list) that may never be a sync target; adds to the built-in HushVault names.
  HUSHVAULT_SYNC_DENY_SCRIPTS?: string
  // Cloudflare account ids (comma list) that sync targets and connections may never use.
  HUSHVAULT_SYNC_DENY_ACCOUNT_IDS?: string
}

declare module 'hono' {
  interface ContextVariableMap {
    requestId: string
  }
}

const app = new Hono<{ Bindings: Env }>()
// Fixed production dashboard origins. Other environments (e.g. beta.hushvault.dev for
// dev) are trusted via their own WEB_APP_URL, so the dev dashboard is NOT allowed here.
const productionOrigins = ['https://hushvault.dev', 'https://www.hushvault.dev']
const devOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000']

// Middleware
// Minimal request logger: method + redacted path + status + duration only. Never
// URLs with query strings (share tokens), headers or bodies.
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID()
  c.set('requestId', requestId)
  c.header('X-Request-Id', requestId)
  const start = Date.now()
  await next()
  console.log(JSON.stringify({
    level: 'info',
    requestId,
    method: c.req.method,
    path: redactPath(new URL(c.req.url).pathname),
    status: c.res.status,
    durationMs: Date.now() - start,
  }))
})
app.use('*', securityHeaders)
function originOf(url: string | undefined): string | null {
  if (!url) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

app.use('/api/*', cors({
  origin: (origin, c) => {
    const allowed = c.env.ENVIRONMENT === 'production' ? productionOrigins : [...productionOrigins, ...devOrigins]
    // Each deployment also trusts the dashboard origin it is configured with, so a
    // new environment (e.g. dev on workers.dev) needs a WEB_APP_URL, not a code change.
    return allowed.includes(origin) || origin === originOf(c.env.WEB_APP_URL) ? origin : null
  },
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-HushVault-Client'],
  maxAge: 86400,
  credentials: true,
}))
// Coarse per-IP safety net over every API route (skips CORS preflights).
app.use('/api/*', async (c, next) => {
  if (c.req.method === 'OPTIONS') return next()
  return globalApiRateLimit(c, next)
})

// Health check
app.get('/', (c) => c.json({ name: 'HushVault API', version: '0.0.1', status: 'ok' }))
app.get('/.well-known/security.txt', (c) => c.text([
  'Contact: security@hushvault.dev',
  'Expires: 2027-03-31T00:00:00.000Z',
  'Preferred-Languages: en',
  'Policy: https://hushvault.dev/security/policy',
].join('\n'), 200, { 'Content-Type': 'text/plain; charset=utf-8' }))

// Routes
app.route('/api/auth', authRoutes)
app.route('/health', healthRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/environments', environmentRoutes)
app.route('/api/secrets', secretRoutes)
app.route('/api/share', shareRoutes)
app.route('/api/audit', auditRoutes)
app.route('/api/security', securityRoutes)
app.route('/api/integrations/secret-scanner', secretScannerRouter)
app.route('/api/integrations', integrationsRouter)
app.route('/api/ci-access', ciAccessRouter)

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// Error handler. Logs ONE structured line: never bodies, headers, query strings or values.
app.onError((err, c) => {
  if (err instanceof SecretTooLargeError) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'Secret value exceeds 64KB limit' }, 400)
  }
  if (err instanceof HTTPException && err.status < 500) {
    return err.getResponse()
  }
  const requestId = c.get('requestId') ?? crypto.randomUUID()
  const e = err instanceof Error ? err : undefined
  console.error(JSON.stringify({
    level: 'error',
    requestId,
    method: c.req.method,
    path: redactPath(new URL(c.req.url).pathname),
    status: 500,
    errorName: e?.name ?? 'UnknownError',
    errorMessage: (e?.message ?? '').slice(0, 200),
  }))
  c.header('X-Request-Id', requestId)
  return c.json({ error: 'INTERNAL_ERROR', message: 'Something went wrong', requestId }, 500)
})

export { app }

// Workers entrypoint: HTTP via Hono, plus a Cron Trigger that drives key rotation.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Each tick's failure is caught on its OWN promise before Promise.all can see it, so an
    // unhandled rejection in one still cannot abort the others — the original invariant. They
    // are then joined only so the heartbeat below can report all three outcomes in one line.
    ctx.waitUntil((async () => {
      const [rotation, sync, housekeeping] = await Promise.all([
        // Automatic sync triggers (M4): outbox, schedules, retries. Independent of rotation.
        rotationTick(env).then((r) => r, () => null),
        syncTick(env).then(() => 'ok' as const, () => 'threw' as const),
        // Retention and purge deletes (audit log, expired share links, used auth tokens). Nothing
        // else removes these rows, so without this they grow until D1's storage limit stops writes.
        housekeepingTick(env).then(() => 'ok' as const, () => 'threw' as const),
      ])
      // The cron's heartbeat (issue #83). A `scheduled` handler that stops firing — a removed
      // trigger, a deploy that dropped it, a Cloudflare incident — produces no signal of any
      // kind, so the ONLY way to see it is to alert on the absence of this line. It is also the
      // first place a thrown tick becomes visible: all three were swallowed outright before.
      logEvent('cron.tick', {
        rotation: rotation ? rotation.state : 'threw',
        // `state: 'error'` carries the code that says which control is broken; the other states
        // have no code and report null rather than inventing one.
        rotationCode: rotation && 'code' in rotation ? rotation.code : null,
        sync,
        housekeeping,
      })
    })())
  },
}
