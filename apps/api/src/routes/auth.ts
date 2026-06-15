import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createApiKey, createPrefixedId, hashPassword, signJwt, verifyPassword } from '../lib/auth'
import type { OAuthIdentity } from '../lib/oauth'
import {
  exchangeGitHubCode,
  exchangeGoogleCode,
  fetchGitHubIdentity,
  fetchGoogleIdentity,
  signState,
  verifyState,
} from '../lib/oauth'
import { loginRateLimit, oauthRateLimit, registerRateLimit, requireAuth } from '../middleware/auth'
import { getRequestIp, writeAuditLog } from '../lib/security'

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

export const authRoutes = new Hono<{ Bindings: Env }>()

const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(12).max(128),
  organisationName: z.string().min(2).max(120),
})

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(128),
})

const apiKeySchema = z.object({
  name: z.string().min(2).max(80),
  expiresAt: z.string().datetime().optional(),
})

// POST /api/auth/register
authRoutes.post('/register', registerRateLimit, zValidator('json', registerSchema), async (c) => {
  const { email, password, organisationName } = c.req.valid('json')
  const db = c.env.DB

  const existing = await db.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<{ id: string }>()
  if (existing) {
    return c.json({ error: 'CONFLICT', message: 'Email is already registered' }, 409)
  }

  const userId = createPrefixedId('usr')
  const orgId = createPrefixedId('org')
  const { salt, passwordHash } = await hashPassword(password)
  const slug = organisationName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || `org-${userId.slice(-8)}`

  await db.batch([
    db.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      userId,
      email.toLowerCase(),
      passwordHash,
      salt,
      new Date().toISOString(),
    ),
    db.prepare('INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      orgId,
      organisationName,
      `${slug}-${orgId.slice(-6)}`,
      'free',
      new Date().toISOString(),
    ),
    db.prepare('INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)').bind(
      createPrefixedId('mem'),
      orgId,
      userId,
      'owner',
      new Date().toISOString(),
    ),
  ])

  const token = await signJwt({ sub: userId, orgId, role: 'owner' }, c.env.JWT_SECRET)
  return c.json({ data: { userId, orgId, token } }, 201)
})

// POST /api/auth/login
authRoutes.post('/login', loginRateLimit, zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json')
  const db = c.env.DB

  const user = await db.prepare('SELECT id, password_hash, salt FROM users WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<{
    id: string
    password_hash: string
    salt: string
  }>()

  if (!user) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401)
  }

  const isValid = await verifyPassword(password, user.salt, user.password_hash)
  if (!isValid) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401)
  }

  const member = await db.prepare('SELECT org_id, role FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1').bind(user.id).first<{
    org_id: string
    role: 'owner' | 'admin' | 'member' | 'viewer'
  }>()

  if (!member) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Membership not found' }, 401)
  }

  const token = await signJwt({ sub: user.id, orgId: member.org_id, role: member.role }, c.env.JWT_SECRET)
  await writeAuditLog(c.env, {
    orgId: member.org_id,
    actorId: user.id,
    actorType: 'user',
    action: 'auth.login',
    resourceType: 'user',
    resourceId: user.id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })
  return c.json({ data: { token, userId: user.id, orgId: member.org_id, role: member.role } })
})

// POST /api/auth/api-keys
authRoutes.post('/api-keys', requireAuth, zValidator('json', apiKeySchema), async (c) => {
  const { name, expiresAt } = c.req.valid('json')
  const auth = c.get('auth')
  const db = c.env.DB
  const { rawKey, keyHash } = await createApiKey()

  await db.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(
    createPrefixedId('key'),
    auth.userId,
    keyHash,
    name,
    expiresAt ?? null,
    new Date().toISOString(),
  ).run()

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'auth.api_key.create',
    resourceType: 'api_key',
    resourceId: auth.userId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { apiKey: rawKey, name } }, 201)
})

// DELETE /api/auth/api-keys/:id
authRoutes.delete('/api-keys/:id', requireAuth, async (c) => {
  const { id } = c.req.param()
  const auth = c.get('auth')
  const db = c.env.DB
  const result = await db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').bind(id, auth.userId).run()

  if (!result.success || !result.meta.changes) {
    return c.json({ error: 'NOT_FOUND', message: 'API key not found' }, 404)
  }

  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'auth.api_key.revoke',
    resourceType: 'api_key',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { revoked: true } })
})

// Shared OAuth provisioning: find the user by provider identity, fall back to
// linking by email, otherwise create a fresh user + workspace. Issues a JWT and
// hands the session back to the dashboard via a URL fragment (no cookies).
async function completeOAuthLogin(
  c: Context<{ Bindings: Env }>,
  provider: 'github' | 'google',
  identity: OAuthIdentity & { email: string },
): Promise<Response> {
  const webBase = (c.env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const db = c.env.DB
  const email = identity.email.toLowerCase()
  const now = new Date().toISOString()

  let userId: string | null = null

  const byProvider = await db.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ? LIMIT 1')
    .bind(provider, identity.id).first<{ id: string }>()
  if (byProvider) {
    userId = byProvider.id
  } else {
    const byEmail = await db.prepare('SELECT id FROM users WHERE email = ? LIMIT 1').bind(email).first<{ id: string }>()
    if (byEmail) {
      await db.prepare('UPDATE users SET provider = ?, provider_id = ? WHERE id = ?').bind(provider, identity.id, byEmail.id).run()
      userId = byEmail.id
    }
  }

  let orgId: string
  let role: MemberRole

  if (userId) {
    const member = await db.prepare('SELECT org_id, role FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
      .bind(userId).first<{ org_id: string; role: MemberRole }>()
    if (!member) {
      return c.redirect(`${webBase}/auth/callback#error=${encodeURIComponent('membership_missing')}`, 302)
    }
    orgId = member.org_id
    role = member.role
  } else {
    const newUserId = createPrefixedId('usr')
    orgId = createPrefixedId('org')
    role = 'owner'
    const displayName = identity.name?.trim() || identity.login
    const slugBase = identity.login.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workspace'

    await db.batch([
      db.prepare("INSERT INTO users (id, email, password_hash, salt, provider, provider_id, created_at) VALUES (?, ?, '', '', ?, ?, ?)")
        .bind(newUserId, email, provider, identity.id, now),
      db.prepare("INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, 'free', ?)")
        .bind(orgId, `${displayName}'s workspace`, `${slugBase}-${orgId.slice(-6)}`, now),
      db.prepare("INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
        .bind(createPrefixedId('mem'), orgId, newUserId, now),
    ])
    userId = newUserId
  }

  const token = await signJwt({ sub: userId, orgId, role }, c.env.JWT_SECRET)
  await writeAuditLog(c.env, {
    orgId,
    actorId: userId,
    actorType: 'user',
    action: `auth.login.${provider}`,
    resourceType: 'user',
    resourceId: userId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  const params = new URLSearchParams({ token, userId, orgId, role })
  return c.redirect(`${webBase}/auth/callback#${params.toString()}`, 302)
}

// GET /api/auth/github — begin the GitHub OAuth sign-in flow
authRoutes.get('/github', oauthRateLimit, async (c) => {
  const clientId = c.env.GITHUB_CLIENT_ID
  if (!clientId || !c.env.GITHUB_CLIENT_SECRET) {
    return c.json({ error: 'OAUTH_NOT_CONFIGURED', message: 'GitHub sign-in is not configured' }, 503)
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/github/callback`
  const authorizeUrl = new URL('https://github.com/login/oauth/authorize')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('scope', 'read:user user:email')
  authorizeUrl.searchParams.set('state', await signState(c.env.JWT_SECRET))
  authorizeUrl.searchParams.set('allow_signup', 'true')

  return c.redirect(authorizeUrl.toString(), 302)
})

// GET /api/auth/github/callback — exchange the code, create/login the user,
// and hand the session back to the dashboard via a URL fragment (no cookies).
authRoutes.get('/github/callback', oauthRateLimit, async (c) => {
  const webBase = (c.env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const fail = (reason: string) => c.redirect(`${webBase}/auth/callback#error=${encodeURIComponent(reason)}`, 302)

  const clientId = c.env.GITHUB_CLIENT_ID
  const clientSecret = c.env.GITHUB_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return c.json({ error: 'OAUTH_NOT_CONFIGURED', message: 'GitHub sign-in is not configured' }, 503)
  }

  if (c.req.query('error')) {
    return fail('github_denied')
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state || !(await verifyState(c.env.JWT_SECRET, state))) {
    return fail('invalid_state')
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/github/callback`
  const accessToken = await exchangeGitHubCode(clientId, clientSecret, code, redirectUri)
  if (!accessToken) {
    return fail('exchange_failed')
  }

  const identity = await fetchGitHubIdentity(accessToken)
  if (!identity || !identity.email) {
    return fail('no_verified_email')
  }

  return completeOAuthLogin(c, 'github', { ...identity, email: identity.email })
})

// GET /api/auth/google — begin the Google OAuth sign-in flow
authRoutes.get('/google', oauthRateLimit, async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID
  if (!clientId || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: 'OAUTH_NOT_CONFIGURED', message: 'Google sign-in is not configured' }, 503)
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/google/callback`
  const authorizeUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('scope', 'openid email profile')
  authorizeUrl.searchParams.set('state', await signState(c.env.JWT_SECRET))

  return c.redirect(authorizeUrl.toString(), 302)
})

// GET /api/auth/google/callback — exchange the code, create/login the user,
// and hand the session back to the dashboard via a URL fragment (no cookies).
authRoutes.get('/google/callback', oauthRateLimit, async (c) => {
  const webBase = (c.env.WEB_APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  const fail = (reason: string) => c.redirect(`${webBase}/auth/callback#error=${encodeURIComponent(reason)}`, 302)

  const clientId = c.env.GOOGLE_CLIENT_ID
  const clientSecret = c.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return c.json({ error: 'OAUTH_NOT_CONFIGURED', message: 'Google sign-in is not configured' }, 503)
  }

  // Only an explicit user cancellation is "denied"; other error codes
  // (misconfiguration, server_error, …) are real failures, not a cancellation.
  const oauthError = c.req.query('error')
  if (oauthError) {
    return fail(oauthError === 'access_denied' ? 'google_denied' : 'exchange_failed')
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state || !(await verifyState(c.env.JWT_SECRET, state))) {
    return fail('invalid_state')
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/google/callback`
  const accessToken = await exchangeGoogleCode(clientId, clientSecret, code, redirectUri)
  if (!accessToken) {
    return fail('exchange_failed')
  }

  const identity = await fetchGoogleIdentity(accessToken)
  if (!identity || !identity.email) {
    return fail('no_verified_email')
  }

  return completeOAuthLogin(c, 'google', { ...identity, email: identity.email })
})

// POST /api/auth/github-oidc — exchange GitHub Actions OIDC token (CI/CD). Separate
// from the web sign-in flow above; still pending.
authRoutes.post('/github-oidc', async (c) => {
  return c.json({ error: 'NOT_IMPLEMENTED', message: 'GitHub OIDC exchange is not yet implemented' }, 501)
})
