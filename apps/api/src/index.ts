import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { authRoutes } from './routes/auth'
import { healthRoutes } from './routes/health'
import { projectRoutes } from './routes/projects'
import { environmentRoutes } from './routes/environments'
import { secretRoutes } from './routes/secrets'
import { shareRoutes } from './routes/share'
import { auditRoutes } from './routes/audit'
import { securityHeaders } from './middleware/security-headers'

export type Env = {
  DB: D1Database
  SECRETS_KV: KVNamespace
  ENVIRONMENT: string
  ENCRYPTION_MASTER_KEY: string
  JWT_SECRET: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  // OAuth (web sign-in). Optional: each provider's routes return 503 until set.
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  // Base URL of the dashboard, used as the OAuth success redirect target.
  WEB_APP_URL?: string
}

const app = new Hono<{ Bindings: Env }>()
const allowedOrigins = ['https://hushvault.dev', 'https://app.hushvault.dev', 'https://beta.hushvault.dev', 'http://localhost:3000', 'http://127.0.0.1:3000']

// Middleware
app.use('*', logger())
app.use('*', prettyJSON())
app.use('*', securityHeaders)
app.use('/api/*', cors({
  origin: (origin) => allowedOrigins.includes(origin) ? origin : null,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
  credentials: true,
}))

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

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// Error handler
app.onError((_err, c) => {
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
