import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { hashApiKey, verifyJwt, type JwtPayload } from '../lib/auth'
import { verifyCiToken } from '../lib/ci-tokens'
import { createRateLimitMiddleware } from './rate-limit'

export type AuthContext = {
  /** Empty for a CI token: it represents a workflow, not a person (audit rows then carry no actor id). */
  userId: string
  orgId: string
  role: 'owner' | 'admin' | 'member' | 'viewer'
  actorType: 'user' | 'api_key' | 'system'
  /** Present only for a CI token (issue #43): the single environment it may read. */
  scope?: { envId: string; ruleId: string }
}

/**
 * A CI token reaches exactly one endpoint, for exactly the environment it was issued for. This is an allowlist in
 * the middleware rather than a check per route, so a new route is unreachable by CI tokens until it is added here.
 */
export function ciTokenMayReach(method: string, pathname: string, envId: string): boolean {
  return method === 'GET' && pathname === `/api/environments/${envId}/resolved`
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext
  }
}

const LAST_USED_THROTTLE_MS = 5 * 60_000

export const requireAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const authorization = c.req.header('authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  const token = authorization.slice('Bearer '.length).trim()

  if (!token) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  // A CI token is unambiguous (it carries `kind`), so it is checked first and never falls through.
  const ci = await verifyCiToken(token, c.env.JWT_SECRET)
  if (ci) {
    if (!ciTokenMayReach(c.req.method, new URL(c.req.url).pathname, ci.envId)) {
      return c.json({ error: 'FORBIDDEN', message: 'This token may only read the environment it was issued for' }, 403)
    }
    // Deleting the rule is an admin's only lever after a compromise, so it must revoke tokens already issued
    // rather than leaving them live until they expire. One indexed primary-key read.
    const rule = await c.env.DB.prepare('SELECT env_id, org_id FROM oidc_repo_rules WHERE id = ? LIMIT 1')
      .bind(ci.sub).first<{ env_id: string; org_id: string }>()
    if (!rule || rule.env_id !== ci.envId || rule.org_id !== ci.orgId) {
      return c.json({ error: 'UNAUTHORIZED', message: 'This token is no longer valid' }, 401)
    }
    c.set('auth', { userId: '', orgId: ci.orgId, role: 'viewer', actorType: 'system', scope: { envId: ci.envId, ruleId: ci.sub } })
    return next()
  }

  let jwtPayload: JwtPayload | null = null
  try {
    jwtPayload = await verifyJwt(token, c.env.JWT_SECRET)
  } catch {
    jwtPayload = null // not a valid JWT: fall through to the API key check
  }

  if (jwtPayload) {
    // Session invalidation (password reset / account takeover): reject tokens issued before the
    // user's marker, and tokens of deleted users. One primary-key read per JWT request.
    const user = await c.env.DB.prepare('SELECT sessions_valid_after FROM users WHERE id = ? LIMIT 1')
      .bind(jwtPayload.sub).first<{ sessions_valid_after: number }>()
    if (!user || jwtPayload.iat < user.sessions_valid_after) {
      return c.json({ error: 'UNAUTHORIZED', message: 'Session expired. Please sign in again.' }, 401)
    }
    c.set('auth', {
      userId: jwtPayload.sub,
      orgId: jwtPayload.orgId,
      role: jwtPayload.role,
      actorType: 'user',
    })
    return next()
  }

  const apiKeyHash = await hashApiKey(token)
  const apiKey = await c.env.DB.prepare('SELECT user_id, key_hash, expires_at, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1')
    .bind(apiKeyHash)
    .first<{ user_id: string; key_hash: string; expires_at: string | null; last_used_at: string | null }>()

  if (!apiKey) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401)
  }

  if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= Date.now()) {
    return c.json({ error: 'UNAUTHORIZED', message: 'API key expired' }, 401)
  }

  const member = await c.env.DB.prepare(
    'SELECT m.org_id, m.role FROM members m WHERE m.user_id = ? ORDER BY m.created_at ASC LIMIT 1',
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

  // Throttled: avoid a D1 write on every request. Only touch when never used or stale.
  const lastUsed = apiKey.last_used_at ? new Date(apiKey.last_used_at).getTime() : Number.NaN
  if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > LAST_USED_THROTTLE_MS) {
    await c.env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE key_hash = ?').bind(new Date().toISOString(), apiKeyHash).run()
  }

  return next()
}

const ROLE_RANK: Record<AuthContext['role'], number> = { viewer: 0, member: 1, admin: 2, owner: 3 }

// Must run after requireAuth. Roles are hierarchical: viewer < member < admin < owner.
export function requireRole(minimum: AuthContext['role']): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const auth = c.get('auth')
    if (!auth || ROLE_RANK[auth.role] === undefined || ROLE_RANK[auth.role] < ROLE_RANK[minimum]) {
      return c.json({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' }, 403)
    }
    return next()
  }
}

/**
 * Humans only: refuses API keys. Used for endpoints where a stolen CI key must not be able to act
 * (managing outbound credentials, re-pointing syncs).
 */
export const requireHuman: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth')
  if (!auth || auth.actorType !== 'user') {
    return c.json({ error: 'FORBIDDEN', message: 'This action requires signing in as a user; API keys cannot do it' }, 403)
  }
  return next()
}

export const integrationWriteRateLimit = createRateLimitMiddleware({
  scope: 'integration-write',
  limit: 20,
  windowMs: 60_000,
  failClosed: true,
})

// Run and preview decrypt a whole environment and call a third party, so they are limited per organisation
// (an attacker or a busy team cannot dodge the cap by changing IP). Runs after requireAuth.
const byOrganisation = (c: Parameters<NonNullable<Parameters<typeof createRateLimitMiddleware>[0]['keyFn']>>[0]): string | undefined => {
  const orgId = c.get('auth')?.orgId
  return orgId ? `org:${orgId}` : undefined
}

export const integrationRunRateLimit = createRateLimitMiddleware({
  scope: 'integration-run',
  limit: 6,
  windowMs: 60_000,
  failClosed: true,
  keyFn: byOrganisation,
})

export const integrationPreviewRateLimit = createRateLimitMiddleware({
  scope: 'integration-preview',
  limit: 12,
  windowMs: 60_000,
  failClosed: true,
  keyFn: byOrganisation,
})

/**
 * Humans only, with the caller's CURRENT membership re-read: the JWT role claim can be up to its lifetime stale, so
 * a demoted or removed admin must lose access to credential- and CI-access management immediately.
 */
export const requireCurrentAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const auth = c.get('auth')
  const member = await c.env.DB.prepare('SELECT role FROM members WHERE user_id = ? AND org_id = ? LIMIT 1').bind(auth.userId, auth.orgId).first<{ role: string }>()
  if (!member || (member.role !== 'admin' && member.role !== 'owner')) {
    return c.json({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' }, 403)
  }
  return next()
}

// The OIDC exchange is unauthenticated by design (the signed GitHub token is the credential): cap it per IP and
// fail closed, because each call can cost a JWKS fetch and a signature verification.
export const oidcExchangeRateLimit = createRateLimitMiddleware({
  scope: 'auth-oidc',
  limit: 30,
  windowMs: 60_000,
  failClosed: true,
})

export const loginRateLimit = createRateLimitMiddleware({
  scope: 'auth-login',
  limit: 10,
  windowMs: 60_000,
  failClosed: true,
})

export const registerRateLimit = createRateLimitMiddleware({
  scope: 'auth-register',
  limit: 5,
  windowMs: 60_000,
  failClosed: true,
})

// OAuth start + callback trigger outbound GitHub calls and DB writes; cap per IP.
export const oauthRateLimit = createRateLimitMiddleware({
  scope: 'auth-oauth',
  limit: 20,
  windowMs: 60_000,
  failClosed: true,
})

export const secretReadRateLimit = createRateLimitMiddleware({
  scope: 'secret-read',
  limit: 120,
  windowMs: 60_000,
})

// Unauthenticated share-link reads are a secret-enumeration vector; cap per IP.
export const shareAccessRateLimit = createRateLimitMiddleware({
  scope: 'share-access',
  limit: 20,
  windowMs: 60_000,
  failClosed: true,
})

// Coarse safety net across all /api/* traffic to blunt DDoS / scraping. Sits
// above the per-route limits, which stay tighter for sensitive endpoints.
export const globalApiRateLimit = createRateLimitMiddleware({
  scope: 'global-api',
  limit: 600,
  windowMs: 60_000,
})

export const secretWriteRateLimit = createRateLimitMiddleware({
  scope: 'secret-write',
  limit: 60,
  windowMs: 60_000,
})

// Forgot-password / verification-resend: per IP. Per-email and global limits are applied in the
// route (they must not change the response, so a visible 429 would leak existence).
export const forgotPasswordRateLimit = createRateLimitMiddleware({
  scope: 'auth-forgot',
  limit: 5,
  windowMs: 60_000,
  failClosed: true,
})

// Refresh/logout: one call per page load per tab, so higher than the credential endpoints.
export const refreshRateLimit = createRateLimitMiddleware({
  scope: 'auth-refresh',
  limit: 60,
  windowMs: 60_000,
  failClosed: true,
})

// Token submissions (verify / reset): the tokens have 256 bits, so this only caps abuse of the DB.
export const tokenSubmitRateLimit = createRateLimitMiddleware({
  scope: 'auth-token-submit',
  limit: 10,
  windowMs: 60_000,
  failClosed: true,
})

/**
 * Optional gate for sensitive actions (create share links / API keys): when the deployment sets
 * REQUIRE_VERIFIED_EMAIL=1, accounts with an unverified email get 403 EMAIL_NOT_VERIFIED.
 * Off by default; never applied to login, forgot-password, reset or verify. Run after requireAuth.
 */
export const requireVerifiedEmailIfEnforced: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const flag = (c.env.REQUIRE_VERIFIED_EMAIL ?? '').trim().toLowerCase()
  if (flag !== '1' && flag !== 'true') return next()
  const auth = c.get('auth')
  const user = await c.env.DB.prepare('SELECT email_verified FROM users WHERE id = ? LIMIT 1').bind(auth.userId).first<{ email_verified: number }>()
  if (!user || user.email_verified !== 1) {
    return c.json({ error: 'EMAIL_NOT_VERIFIED', message: 'Verify your email address to do this' }, 403)
  }
  return next()
}

export function getAuth(c: Parameters<MiddlewareHandler<{ Bindings: Env }>>[0]): AuthContext {
  return c.get('auth')
}