import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { hashApiKey, verifyJwt } from '../lib/auth'
import { createRateLimitMiddleware } from './rate-limit'

export type AuthContext = {
  userId: string
  orgId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  actorType: 'user' | 'api_key'
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext
  }
}

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  const token = authorization.slice('Bearer '.length).trim()

  if (!token) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  try {
    const jwtPayload = await verifyJwt(token, c.env.JWT_SECRET)
    c.set('auth', {
      userId: jwtPayload.sub,
      orgId: jwtPayload.orgId,
      role: jwtPayload.role,
      actorType: 'user',
    })
    return next()
  } catch {
    // fall through to API key check
  }

  const apiKeyHash = await hashApiKey(token)
  const apiKey = await c.env.DB.prepare('SELECT user_id, key_hash, expires_at FROM api_keys WHERE key_hash = ? LIMIT 1')
    .bind(apiKeyHash)
    .first<{ user_id: string; key_hash: string; expires_at: string | null }>()

  if (!apiKey) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401)
  }

  if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= Date.now()) {
    return c.json({ error: 'UNAUTHORIZED', message: 'API key expired' }, 401)
  }

  const member = await c.env.DB.prepare(
    'SELECT m.org_id, m.role FROM members m WHERE m.user_id = ? LIMIT 1',
  ).bind(apiKey.user_id).first<{ org_id: string; role: AuthContext['role'] }>()

  if (!member) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401)
  }

  c.set('auth', {
    userId: apiKey.user_id,
    orgId: member.org_id,
    role: member.role,
    actorType: 'api_key',
  })

  await c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?').bind(new Date().toISOString(), apiKeyHash).run()

  return next()
}

export const loginRateLimit = createRateLimitMiddleware({
  scope: 'auth-login',
  limit: 10,
  windowMs: 60_000,
})

export const registerRateLimit = createRateLimitMiddleware({
  scope: 'auth-register',
  limit: 5,
  windowMs: 60_000,
})

export const secretReadRateLimit = createRateLimitMiddleware({
  scope: 'secret-read',
  limit: 120,
  windowMs: 60_000,
})

export const secretWriteRateLimit = createRateLimitMiddleware({
  scope: 'secret-write',
  limit: 60,
  windowMs: 60_000,
})

export function getAuth(c: Parameters<MiddlewareHandler<{ Bindings: Env }>>[0]): AuthContext {
  return c.get('auth')
}