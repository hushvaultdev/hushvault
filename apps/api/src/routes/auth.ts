import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { z } from 'zod'
import type { Env } from '../index'
import { githubOidcConfig, ruleMatches, type GitHubOidcClaims } from '../integrations/github-oidc'
import { verifyOidcToken } from '../lib/oidc-verify'
import { signCiToken } from '../lib/ci-tokens'
import { createApiKey, createPrefixedId, hashPassword, timingSafeEqual, verifyPassword } from '../lib/auth'
import type { OAuthIdentity } from '../lib/oauth'
import {
  clearRefreshCookie,
  issueSession,
  readRefreshCookie,
  revokeRefreshFamily,
  rotateSession,
  rotateRefreshToken,
  setRefreshCookie,
  wantsBodyRefresh,
} from '../lib/sessions'
import {
  exchangeGitHubCode,
  exchangeGoogleCode,
  fetchGitHubIdentity,
  fetchGoogleIdentity,
  challengeFor,
  newPkce,
  signState,
  verifyState,
} from '../lib/oauth'
import {
  forgotPasswordRateLimit,
  loginRateLimit,
  oauthRateLimit,
  oidcExchangeRateLimit,
  refreshRateLimit,
  registerRateLimit,
  requireAuth,
  requireHuman,
  requireVerifiedEmailIfEnforced,
  tokenSubmitRateLimit,
} from '../middleware/auth'
import { consumeIdentityLimit, identityKey } from '../middleware/rate-limit'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { consumeToken, issueToken, purgeExpiredTokens } from '../lib/auth-tokens'
import { revokeApiKeysStatement, spendEmailBudget } from '../lib/account-security'
import { sendEmail } from '../lib/email'
import { buildTokenLink, passwordChangedMessage, resetPasswordMessage, verifyEmailMessage } from '../lib/email-templates'
import { runBackground } from '../lib/background'
import { validationHook } from '../lib/validation'

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

const emailSchema = z.object({ email: z.string().email().max(254) })
const tokenSchema = z.object({ token: z.string().min(16).max(256) })
const resetSchema = z.object({ token: z.string().min(16).max(256), password: z.string().min(12).max(128) })

const apiKeySchema = z.object({
  name: z.string().min(2).max(80),
  expiresAt: z.string().datetime().optional(),
})

// POST /api/auth/register
authRoutes.post('/register', registerRateLimit, zValidator('json', registerSchema, validationHook), async (c) => {
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
    db.prepare('INSERT INTO users (id, email, password_hash, salt, created_at, email_verified) VALUES (?, ?, ?, ?, ?, 0)').bind(
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

  const session = await issueSession(c.env, { userId, orgId, role: 'owner' })
  setRefreshCookie(c, session.refreshToken)
  // Verification mail: in the background, so a failed or slow send never fails registration.
  await runBackground(c, sendVerificationEmail(c.env, { userId, email: email.toLowerCase(), orgId }, 'registration'))
  return c.json({ data: { userId, orgId, token: session.accessToken, expiresIn: session.expiresIn, emailVerified: false, ...(wantsBodyRefresh(c) ? { refreshToken: session.refreshToken } : {}) } }, 201)
})

/**
 * Issue a verify_email token and mail it. Respects the global daily budget; never throws to the
 * caller. A skipped send is logged by spendEmailBudget, with `purpose` saying which caller it
 * was — registration and a user-triggered resend are the same mail but very different incidents.
 */
async function sendVerificationEmail(
  env: Env,
  user: { userId: string; email: string; orgId: string },
  purpose: 'registration' | 'verify_resend',
): Promise<void> {
  if (!(await spendEmailBudget(env, 'verify', purpose))) return
  const { token } = await issueToken(env, { userId: user.userId, purpose: 'verify_email', email: user.email })
  const link = buildTokenLink(env, '/verify-email', token)
  if (!link) return
  await sendEmail(env, verifyEmailMessage(user.email, link))
  await writeAuditLog(env, {
    orgId: user.orgId,
    actorId: user.userId,
    actorType: 'system',
    action: 'auth.email_verification.sent',
    resourceType: 'user',
    resourceId: user.userId,
  })
}

// POST /api/auth/login
authRoutes.post('/login', loginRateLimit, zValidator('json', loginSchema, validationHook), async (c) => {
  const { email, password } = c.req.valid('json')
  const db = c.env.DB

  const user = await db.prepare('SELECT id, password_hash, salt, email_verified FROM users WHERE email = ? LIMIT 1').bind(email.toLowerCase()).first<{
    id: string
    password_hash: string
    salt: string
    email_verified: number
  }>()

  // Burn the same PBKDF2 cost for unknown users and OAuth-only users (empty
  // hash) so response time does not reveal whether an email is registered.
  if (!user || !user.password_hash || !user.salt) {
    await hashPassword(password)
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

  const session = await issueSession(c.env, { userId: user.id, orgId: member.org_id, role: member.role })
  setRefreshCookie(c, session.refreshToken)
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
  return c.json({
    data: {
      token: session.accessToken,
      expiresIn: session.expiresIn,
      userId: user.id,
      orgId: member.org_id,
      role: member.role,
      emailVerified: user.email_verified === 1,
      ...(wantsBodyRefresh(c) ? { refreshToken: session.refreshToken } : {}),
    },
  })
})

// POST /api/auth/api-keys
//
// requireHuman: a credential must never be able to mint another credential. Without it, an
// attacker holding one leaked hv_live_* key could mint more, each with its own hash — so
// GitHub's leak report would revoke the one key it saw while the attacker kept the rest, and
// the owner would read the incident as contained. Deleting keys is gated for the same reason.
authRoutes.post('/api-keys', requireAuth, requireHuman, requireVerifiedEmailIfEnforced, zValidator('json', apiKeySchema, validationHook), async (c) => {
  const { name, expiresAt } = c.req.valid('json')
  const auth = c.get('auth')
  const db = c.env.DB

  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
    return c.json({ error: 'VALIDATION_ERROR', message: 'expiresAt must be in the future' }, 400)
  }

  const { rawKey, keyHash } = await createApiKey()
  const id = createPrefixedId('key')

  await db.prepare(
    'INSERT INTO api_keys (id, user_id, key_hash, name, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
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
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { id, apiKey: rawKey, name, expiresAt: expiresAt ?? null } }, 201)
})

// GET /api/auth/api-keys — the caller's own keys; never key_hash or raw keys
authRoutes.get('/api-keys', requireAuth, async (c) => {
  const auth = c.get('auth')
  const { results } = await c.env.DB.prepare(
    'SELECT id, name, created_at, last_used_at, expires_at, revoked_at FROM api_keys WHERE user_id = ? ORDER BY created_at DESC',
  ).bind(auth.userId).all<{
    id: string
    name: string
    created_at: string
    last_used_at: string | null
    expires_at: string | null
    revoked_at: number | string | null
  }>()

  const data = results.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    // revoked_at is an INTEGER (unix seconds) column; expose ISO like other timestamps.
    revokedAt: row.revoked_at === null || row.revoked_at === undefined
      ? null
      : typeof row.revoked_at === 'number'
        ? new Date(row.revoked_at * 1000).toISOString()
        : row.revoked_at,
  }))
  return c.json({ data })
})

// DELETE /api/auth/api-keys/:id
authRoutes.delete('/api-keys/:id', requireAuth, requireHuman, async (c) => {
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

// POST /api/auth/verify-email/send - (re)send the verification mail to the caller's own address.
// Always 202, even if already verified (no state leak beyond the account owner).
authRoutes.post('/verify-email/send', requireAuth, async (c) => {
  const auth = c.get('auth')
  const user = await c.env.DB.prepare('SELECT email, email_verified FROM users WHERE id = ? LIMIT 1').bind(auth.userId)
    .first<{ email: string; email_verified: number }>()
  if (user && user.email_verified !== 1) {
    const identity = await identityKey(auth.userId)
    const perMinute = await consumeIdentityLimit(c.env, { scope: 'verify-send-min', identity, limit: 1, windowMs: 60_000 })
    if ('unavailable' in perMinute) {
      return c.json({ error: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable. Please try again shortly.' }, 503)
    }
    const perHour = await consumeIdentityLimit(c.env, { scope: 'verify-send-hour', identity, limit: 5, windowMs: 3_600_000 })
    if (!perMinute.allowed || !('allowed' in perHour) || !perHour.allowed) {
      return c.json({ error: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests. Please wait a moment and try again.' }, 429)
    }
    await runBackground(c, sendVerificationEmail(c.env, { userId: auth.userId, email: user.email, orgId: auth.orgId }, 'verify_resend'))
  }
  return c.json({ data: { ok: true } }, 202)
})

// POST /api/auth/verify-email { token } - consume a verification token. POST only, so mail scanners
// that prefetch links cannot burn it. Invalid, expired, used and wrong-purpose tokens all look the same.
authRoutes.post('/verify-email', tokenSubmitRateLimit, zValidator('json', tokenSchema, validationHook), async (c) => {
  const { token } = c.req.valid('json')
  const consumed = await consumeToken(c.env, { token, purpose: 'verify_email' })
  if (!consumed) {
    return c.json({ error: 'INVALID_TOKEN', message: 'This link is invalid or has expired' }, 400)
  }
  await c.env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(consumed.userId).run()
  const member = await c.env.DB.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1').bind(consumed.userId).first<{ org_id: string }>()
  if (member) {
    await writeAuditLog(c.env, {
      orgId: member.org_id,
      actorId: consumed.userId,
      actorType: 'user',
      action: 'auth.email.verified',
      resourceType: 'user',
      resourceId: consumed.userId,
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent'),
    })
  }
  return c.json({ data: { verified: true } })
})

/** Work done for forgot-password after the (identical) response is decided; every outcome is silent. */
async function processPasswordResetRequest(env: Env, email: string): Promise<void> {
  const user = await env.DB.prepare('SELECT id, email, password_hash FROM users WHERE email = ? LIMIT 1').bind(email)
    .first<{ id: string; email: string; password_hash: string }>()
  if (!user) return

  const hashedEmail = await identityKey(email)
  const limit = await consumeIdentityLimit(env, { scope: 'forgot-email', identity: hashedEmail, limit: 3, windowMs: 3_600_000 })
  if (!('allowed' in limit) || !limit.allowed) return // throttled: stay silent, never a distinguishable 429
  // 'reset', not 'verify': the two buckets exist so that a sign-up flood cannot exhaust the
  // budget that account recovery depends on. Spending the verify bucket here undid that, and
  // the failure is invisible — forgot-password still answers 202 and sends nothing.
  // spendEmailBudget emits the line (exhausted vs limiter-unavailable); the call site no longer
  // duplicates it, which is what kept the other two send paths silent.
  if (!(await spendEmailBudget(env, 'reset', 'forgot_password'))) return

  const member = await env.DB.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1').bind(user.id).first<{ org_id: string }>()
  const { token } = await issueToken(env, { userId: user.id, purpose: 'reset_password', email: user.email })
  const link = buildTokenLink(env, '/reset-password', token)
  if (!link) return
  const message = resetPasswordMessage(user.email, link, user.password_hash === '')
  await sendEmail(env, message)
  if (member) {
    await writeAuditLog(env, {
      orgId: member.org_id,
      actorId: user.id,
      actorType: 'system',
      action: 'auth.password_reset.requested',
      resourceType: 'user',
      resourceId: user.id,
    })
  }
  if ((crypto.getRandomValues(new Uint8Array(1))[0] ?? 255) < 3) await purgeExpiredTokens(env) // opportunistic cleanup; no cron for this
}

// POST /api/auth/forgot-password { email } - always the same 202, whether or not the address has an
// account, is OAuth-only, was throttled, or the mail could not be sent. Work runs after the response.
authRoutes.post('/forgot-password', forgotPasswordRateLimit, zValidator('json', emailSchema, validationHook), async (c) => {
  const { email } = c.req.valid('json')
  await runBackground(c, processPasswordResetRequest(c.env, email.toLowerCase()))
  return c.json({ data: { ok: true } }, 202)
})

// POST /api/auth/reset-password { token, password } - consume a reset token and set a new password.
// Revokes every session; revokes API keys only for accounts whose email was still unverified (owner
// decision 4). Proving control of the mailbox also verifies the address. Does not sign the user in.
authRoutes.post('/reset-password', tokenSubmitRateLimit, zValidator('json', resetSchema, validationHook), async (c) => {
  const { token, password } = c.req.valid('json')
  const consumed = await consumeToken(c.env, { token, purpose: 'reset_password' })
  if (!consumed) {
    return c.json({ error: 'INVALID_TOKEN', message: 'This link is invalid or has expired' }, 400)
  }

  const { salt, passwordHash } = await hashPassword(password)
  const nowSeconds = Math.floor(Date.now() / 1000)
  const cutoff = nowSeconds + 1 // JWT iat is whole seconds: tokens minted this second must die too
  await c.env.DB.batch([
    // Must run before the user update below flips email_verified.
    c.env.DB.prepare(
      'UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM users WHERE id = ? AND email_verified = 0)',
    ).bind(nowSeconds, 'password_reset', consumed.userId, consumed.userId),
    c.env.DB.prepare('UPDATE users SET password_hash = ?, salt = ?, email_verified = 1, sessions_valid_after = ? WHERE id = ?')
      .bind(passwordHash, salt, cutoff, consumed.userId),
    c.env.DB.prepare("DELETE FROM auth_tokens WHERE user_id = ? AND purpose = 'reset_password'").bind(consumed.userId),
    c.env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(consumed.userId),
  ])

  const member = await c.env.DB.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1').bind(consumed.userId).first<{ org_id: string }>()
  if (member) {
    await writeAuditLog(c.env, {
      orgId: member.org_id,
      actorId: consumed.userId,
      actorType: 'user',
      action: 'auth.password_reset.completed',
      resourceType: 'user',
      resourceId: consumed.userId,
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent'),
    })
  }
  // Heads-up mail to the owner of the address (best effort, within the daily budget).
  await runBackground(c, (async () => {
    if (await spendEmailBudget(c.env, 'reset', 'password_changed')) await sendEmail(c.env, passwordChangedMessage(consumed.email))
  })())
  return c.json({ data: { reset: true } })
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
  let linkedExistingUnverified = false
  let cutoff: number | null = null

  const byProvider = await db.prepare('SELECT id FROM users WHERE provider = ? AND provider_id = ? LIMIT 1')
    .bind(provider, identity.id).first<{ id: string }>()
  if (byProvider) {
    userId = byProvider.id
  } else {
    const byEmail = await db.prepare('SELECT id, email_verified FROM users WHERE email = ? LIMIT 1').bind(email)
      .first<{ id: string; email_verified: number }>()
    if (byEmail && byEmail.email_verified !== 1) {
      // Owner decision 2: the provider proved control of this address, so the person signing in is
      // its owner. Link the provider to the existing account and sign them in, but kill whatever
      // credentials may belong to someone who registered the address without owning it: password,
      // API keys, outstanding tokens and sessions (JWTs issued before now stop working).
      const nowSeconds = Math.floor(Date.now() / 1000)
      cutoff = nowSeconds + 1 // same-second attacker tokens must die too
      await db.batch([
        db.prepare("UPDATE users SET provider = ?, provider_id = ?, password_hash = '', salt = '', email_verified = 1, sessions_valid_after = ? WHERE id = ?")
          .bind(provider, identity.id, cutoff, byEmail.id),
        revokeApiKeysStatement(c.env, byEmail.id, nowSeconds, 'oauth_account_link'),
        db.prepare('DELETE FROM auth_tokens WHERE user_id = ?').bind(byEmail.id),
        db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(byEmail.id),
      ])
      const member = await db.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
        .bind(byEmail.id).first<{ org_id: string }>()
      if (member) {
        await writeAuditLog(c.env, {
          orgId: member.org_id,
          actorId: byEmail.id,
          actorType: 'user',
          action: 'auth.oauth.account_takeover',
          resourceType: 'user',
          resourceId: byEmail.id,
          ip: getRequestIp(c),
          userAgent: c.req.header('user-agent'),
        })
      }
      linkedExistingUnverified = true
      userId = byEmail.id
    } else
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
      db.prepare("INSERT INTO users (id, email, password_hash, salt, provider, provider_id, created_at, email_verified) VALUES (?, ?, '', '', ?, ?, ?, 1)")
        .bind(newUserId, email, provider, identity.id, now),
      db.prepare("INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, 'free', ?)")
        .bind(orgId, `${displayName}'s workspace`, `${slugBase}-${orgId.slice(-6)}`, now),
      db.prepare("INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
        .bind(createPrefixedId('mem'), orgId, newUserId, now),
    ])
    userId = newUserId
  }

  // A claimed account's session is minted at the cutoff so it survives the invalidation it caused.
  const session = await issueSession(c.env, { userId, orgId, role, ...(cutoff !== null ? { issuedAt: cutoff } : {}) })
  setRefreshCookie(c, session.refreshToken)
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

  const params = new URLSearchParams({ token: session.accessToken, userId, orgId, role })
  // Tell the dashboard that an existing, never-verified account was claimed (it shows a notice).
  if (linkedExistingUnverified) params.set('notice', 'account_linked')
  return c.redirect(`${webBase}/auth/callback#${params.toString()}`, 302)
}

const refreshSchema = z.object({ refreshToken: z.string().min(16).max(256).optional() })

/**
 * The refresh token comes from the request body (CLI) or the HttpOnly cookie (browser). Cookie use must
 * carry the custom client header: a cross-site form post cannot set it and a cross-origin fetch with it
 * needs a CORS preflight, so cookie-borne requests cannot be forged by other sites.
 */
type Presented = { token: string } | { missing: 'no_client_header' | 'no_cookie' }

function presentedRefreshToken(c: Context<{ Bindings: Env }>, bodyToken: string | undefined): Presented {
  if (bodyToken) return { token: bodyToken }
  if (!c.req.header('x-hushvault-client')) return { missing: 'no_client_header' }
  const cookie = readRefreshCookie(c)
  return cookie ? { token: cookie } : { missing: 'no_cookie' }
}

/** Why a refresh failed. A fixed vocabulary, safe to return: it describes the caller's own request, never other users. */
function refreshFailure(c: Context<{ Bindings: Env }>, reason: string, status: 401 | 409 = 401) {
  console.error(JSON.stringify({ level: 'warn', event: 'auth.refresh_failed', reason }))
  return c.json({ error: status === 409 ? 'REFRESH_RACE' : 'INVALID_REFRESH', message: status === 409 ? 'Please retry' : 'Session expired. Please sign in again.', reason }, status)
}

// POST /api/auth/refresh - exchange a refresh token for a new access token (rotates the refresh token)
authRoutes.post('/refresh', refreshRateLimit, zValidator('json', refreshSchema.default({}), validationHook), async (c) => {
  const bodyToken = c.req.valid('json').refreshToken
  const presented = presentedRefreshToken(c, bodyToken)
  // The token is only ever echoed in a body to a caller that already holds it there. A cookie-authenticated
  // request (browser, possibly script-driven by XSS) must never be able to read a refresh token back out.
  const viaCookie = !bodyToken
  const invalid = (reason: string) => {
    clearRefreshCookie(c)
    return refreshFailure(c, reason)
  }
  if (!('token' in presented)) return invalid(presented.missing)

  const rotated = await rotateRefreshToken(c.env, presented.token)
  if (!rotated.ok) {
    // Two tabs refreshing together: the loser retries with the cookie the winner just set.
    if (rotated.reason === 'race') return refreshFailure(c, 'race', 409)
    return invalid(rotated.reason)
  }

  // Role and org are re-read here, so a membership change reaches the session within one access TTL.
  const member = await c.env.DB.prepare('SELECT org_id, role FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
    .bind(rotated.userId).first<{ org_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }>()
  const user = await c.env.DB.prepare('SELECT email_verified FROM users WHERE id = ? LIMIT 1').bind(rotated.userId).first<{ email_verified: number }>()
  if (!member || !user) return invalid('no_membership')

  const session = await rotateSession(c.env, { userId: rotated.userId, orgId: member.org_id, role: member.role, family: rotated.family, consume: rotated.tokenId })
  if (!session) return refreshFailure(c, 'rotation_conflict', 409)
  if (viaCookie) setRefreshCookie(c, session.refreshToken)
  return c.json({
    data: {
      token: session.accessToken,
      expiresIn: session.expiresIn,
      userId: rotated.userId,
      orgId: member.org_id,
      role: member.role,
      emailVerified: user.email_verified === 1,
      ...(!viaCookie && wantsBodyRefresh(c) ? { refreshToken: session.refreshToken } : {}),
    },
  })
})

// POST /api/auth/logout - end this session (revokes its refresh token family). Always succeeds.
authRoutes.post('/logout', refreshRateLimit, zValidator('json', refreshSchema.default({}), validationHook), async (c) => {
  const presented = presentedRefreshToken(c, c.req.valid('json').refreshToken)
  if ('token' in presented) await revokeRefreshFamily(c.env, presented.token)
  clearRefreshCookie(c)
  return c.json({ data: { loggedOut: true } })
})

const logoutAllSchema = z
  .object({
    /**
     * API keys are machine credentials, not sessions, so "sign out everywhere" leaves them
     * alone by default — silently revoking them would break the caller's CI with no warning.
     * Someone recovering from a stolen laptop or a suspected takeover wants them gone too,
     * so it is an explicit opt-in and the response always reports how many keys are live.
     */
    revokeApiKeys: z.boolean().optional(),
  })
  .default({})

// POST /api/auth/logout-all - end every session of the signed-in user (access tokens too)
authRoutes.post('/logout-all', requireAuth, zValidator('json', logoutAllSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  if (auth.actorType !== 'user') {
    return c.json({ error: 'FORBIDDEN', message: 'Sign in as a user to end all sessions' }, 403)
  }
  const { revokeApiKeys } = c.req.valid('json')
  const nowSeconds = Math.floor(Date.now() / 1000)
  const cutoff = nowSeconds + 1
  const statements = [
    c.env.DB.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?').bind(cutoff, auth.userId),
    c.env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').bind(auth.userId),
  ]
  if (revokeApiKeys) {
    statements.push(revokeApiKeysStatement(c.env, auth.userId, nowSeconds, 'logout_all'))
  }
  await c.env.DB.batch(statements)
  clearRefreshCookie(c)
  await writeAuditLog(c.env, {
    orgId: auth.orgId,
    actorId: auth.userId,
    actorType: 'user',
    action: revokeApiKeys ? 'auth.logout_all_with_keys' : 'auth.logout_all',
    resourceType: 'user',
    resourceId: auth.userId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })
  // Reported so a client can tell the user what is still able to reach their secrets.
  const live = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NULL')
    .bind(auth.userId)
    .first<{ n: number }>()
  return c.json({ data: { loggedOut: true, apiKeysRevoked: Boolean(revokeApiKeys), apiKeysStillActive: live?.n ?? 0 } })
})

const OAUTH_COOKIE_TTL_SECONDS = 600

function oauthCookieName(c: Context<{ Bindings: Env }>): string {
  // The __Host- prefix needs Secure; plain http (local dev) cannot set it.
  return new URL(c.req.url).protocol === 'https:' ? '__Host-hv_oauth' : 'hv_oauth'
}

/** Start a flow: the PKCE verifier goes into an HttpOnly cookie, so only the browser that began it can finish it. */
async function beginOAuthBinding(c: Context<{ Bindings: Env }>): Promise<{ challenge: string }> {
  const pkce = await newPkce()
  const secure = new URL(c.req.url).protocol === 'https:'
  setCookie(c, oauthCookieName(c), pkce.verifier, {
    httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: OAUTH_COOKIE_TTL_SECONDS,
  })
  return { challenge: pkce.challenge }
}

/** Validate state and the browser binding; returns the PKCE verifier. The cookie is always cleared (single use). */
async function consumeOAuthBinding(c: Context<{ Bindings: Env }>, state: string): Promise<string | null> {
  const name = oauthCookieName(c)
  const verifier = getCookie(c, name)
  const verified = await verifyState(c.env.JWT_SECRET, state)
  if (!verified || !verifier) return null
  if (!timingSafeEqual(await challengeFor(verifier), verified.challenge)) return null
  // Cleared only after a match, so a stray callback hit cannot cancel someone else's in-flight login.
  deleteCookie(c, name, { path: '/', secure: new URL(c.req.url).protocol === 'https:' })
  return verifier
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
  const pkce = await beginOAuthBinding(c)
  authorizeUrl.searchParams.set('state', await signState(c.env.JWT_SECRET, pkce.challenge))
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')
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
  const verifier = code && state ? await consumeOAuthBinding(c, state) : null
  if (!code || !verifier) {
    return fail('invalid_state')
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/github/callback`
  const accessToken = await exchangeGitHubCode(clientId, clientSecret, code, redirectUri, verifier)
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
  const pkce = await beginOAuthBinding(c)
  authorizeUrl.searchParams.set('state', await signState(c.env.JWT_SECRET, pkce.challenge))
  authorizeUrl.searchParams.set('code_challenge', pkce.challenge)
  authorizeUrl.searchParams.set('code_challenge_method', 'S256')

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
  const verifier = code && state ? await consumeOAuthBinding(c, state) : null
  if (!code || !verifier) {
    return fail('invalid_state')
  }

  const redirectUri = `${new URL(c.req.url).origin}/api/auth/google/callback`
  const accessToken = await exchangeGoogleCode(clientId, clientSecret, code, redirectUri, verifier)
  if (!accessToken) {
    return fail('exchange_failed')
  }

  const identity = await fetchGoogleIdentity(accessToken)
  if (!identity || !identity.email) {
    return fail('no_verified_email')
  }

  return completeOAuthLogin(c, 'google', { ...identity, email: identity.email })
})

// POST /api/auth/github-oidc — exchange a GitHub Actions OIDC token for a short-lived, read-only token scoped to
// one environment (issue #43). Unauthenticated by design: the signed token from GitHub IS the credential, so no
// HushVault secret ever lives in a workflow. Nothing in the token is trusted until its signature verifies, and
// authorisation then needs an explicit rule created by an admin.
const githubOidcSchema = z.object({
  token: z.string().min(40).max(8192),
  envId: z.string().min(1).max(64),
}).strict()

authRoutes.post('/github-oidc', oidcExchangeRateLimit, zValidator('json', githubOidcSchema, (result, c) => {
  if (!result.success) return c.json({ error: 'VALIDATION_ERROR', message: 'Invalid request' }, 400)
  return undefined
}), async (c) => {
  const { token, envId } = c.req.valid('json')
  const config = githubOidcConfig(c.env)

  // The caller's address scopes the key-refetch budget, so a prober cannot starve everyone else's rotations. Only
  // cf-connecting-ip is trusted here (as in the rate limiter): x-forwarded-for is client-controlled, so accepting it
  // would let one caller mint itself an unlimited number of buckets.
  const verified = await verifyOidcToken<GitHubOidcClaims>(c.env, token, { ...config, callerKey: c.req.header('cf-connecting-ip') ?? 'unknown' })
  if (!verified.ok) {
    // One opaque response for every verification failure: a forger learns nothing about which part was wrong.
    // The code is logged (never the token) so an operator can tell a misconfiguration from an attack.
    console.error(JSON.stringify({ level: 'warn', event: 'auth.oidc.rejected', code: verified.code }))
    // A key-server problem on our side is an outage, not a verdict on the caller's token.
    const status = verified.code === 'JWKS_UNAVAILABLE' || verified.code === 'KEY_LOOKUP_THROTTLED' ? 503 : 401
    return c.json({ error: 'OIDC_REJECTED', message: 'The OIDC token was not accepted' }, status)
  }

  const claims = verified.claims
  const repository = typeof claims.repository === 'string' ? claims.repository.toLowerCase() : ''
  const rows = repository
    ? await c.env.DB.prepare(
        'SELECT id, org_id, env_id, repository, repository_id, ref, environment FROM oidc_repo_rules WHERE env_id = ? AND repository = ? ORDER BY created_at LIMIT 100',
      ).bind(envId, repository).all<{ id: string; org_id: string; env_id: string; repository: string; repository_id: string | null; ref: string | null; environment: string | null }>()
    : { results: [] }

  const rule = (rows.results ?? [])
    .map((r) => ({ id: r.id, orgId: r.org_id, envId: r.env_id, repository: r.repository, repositoryId: r.repository_id, ref: r.ref, environment: r.environment }))
    .find((r) => ruleMatches(r, claims))

  if (!rule) {
    // The repository, ref and environment are public facts about the caller's own workflow, not secrets: logging
    // them is what lets an operator tell a typo'd rule from a targeted probe.
    console.error(JSON.stringify({
      level: 'warn', event: 'auth.oidc.no_rule', repository, envId,
      ref: typeof claims.ref === 'string' ? claims.ref : null,
      environment: typeof claims.environment === 'string' ? claims.environment : null,
      eventName: typeof claims.event_name === 'string' ? claims.event_name : null,
    }))
    return c.json({ error: 'NOT_ALLOWED', message: 'No rule grants this workflow access to that environment' }, 403)
  }

  const issued = await signCiToken({ ruleId: rule.id, orgId: rule.orgId, envId: rule.envId }, c.env.JWT_SECRET)
  await c.env.DB.prepare('UPDATE oidc_repo_rules SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), rule.id).run()
  await writeAuditLog(c.env, {
    orgId: rule.orgId,
    actorId: null,
    actorType: 'system',
    action: 'auth.oidc.exchange',
    resourceType: 'oidc_repo_rule',
    resourceId: rule.id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { token: issued.token, expiresIn: issued.expiresIn, expiresAt: issued.expiresAt, envId: rule.envId, orgId: rule.orgId } })
})
