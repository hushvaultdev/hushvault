import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { authRoutes } from './routes/auth'
import { projectRoutes } from './routes/projects'
import { environmentRoutes } from './routes/environments'
import { secretRoutes } from './routes/secrets'
import { shareRoutes } from './routes/share'

export type Env = {
  DB: D1Database
  SECRETS_KV: KVNamespace
  ENVIRONMENT: string
  ENCRYPTION_MASTER_KEY: string
  JWT_SECRET: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
}

const app = new Hono<{ Bindings: Env }>()

// Middleware
app.use('*', logger())
app.use('*', prettyJSON())
app.use('/api/*', cors({
  origin: ['https://hushvault.dev', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}))

// Health check
app.get('/', (c) => c.json({ name: 'HushVault API', version: '0.0.1', status: 'ok' }))

// Routes
app.route('/api/auth', authRoutes)
app.route('/api/projects', projectRoutes)
app.route('/api/environments', environmentRoutes)
app.route('/api/secrets', secretRoutes)
app.route('/api/share', shareRoutes)

// 404 handler
app.notFound((c) => c.json({ error: 'Not found' }, 404))

// Error handler
app.onError((err, c) => {
  console.error('Unhandled error:', err.message)
  return c.json({ error: 'Internal server error' }, 500)
})

export default app
