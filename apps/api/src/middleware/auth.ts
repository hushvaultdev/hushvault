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

/**
 * The caller's membership of the organisation named in the request PATH (`:id`), as resolved by
 * `requireOrgRole`. Separate from `auth`, which is the organisation the credential acts in: the
 * two are the same for every dashboard request, and must never be assumed to be.
 */
export type OrgScope = {
  /** The organisation from the path. */
  orgId: string
  /** The caller's role IN THAT organisation, read from `members` on this request. */
  role: AuthContext['role']
}

declare module 'hono' {
  interface ContextVariableMap {
    auth: AuthContext
    orgScope: OrgScope
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
  const apiKey = await c.env.DB.prepare('SELECT user_id, org_id, key_hash, expires_at, last_used_at FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL LIMIT 1')
    .bind(apiKeyHash)
    .first<{ user_id: string; org_id: string | null; key_hash: string; expires_at: string | null; last_used_at: string | null }>()

  if (!apiKey) {
    return c.json({ error: 'UNAUTHORIZED', message: 'Invalid credentials' }, 401)
  }

  if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= Date.now()) {
    return c.json({ error: 'UNAUTHORIZED', message: 'API key expired' }, 401)
  }

  // The key acts in the organisation it was CREATED in (api_keys.org_id, migration 0018), and the
  // membership for exactly that org decides its role. It used to be the owner's earliest
  // membership, which meant a key made in org B acted in org A the moment its owner joined two
  // orgs — issue #82. Nothing here falls back to a membership lookup: a key with no org (one
  // minted by the pre-0018 code, or whose owner had no membership when 0018 backfilled) and a key
  // whose membership is gone are both dead, and say so distinctly from a bad key so an operator
  // can tell "re-create this key" from "this key is not ours".
  const member = apiKey.org_id
    ? await c.env.DB.prepare('SELECT role FROM members WHERE user_id = ? AND org_id = ? LIMIT 1')
      .bind(apiKey.user_id, apiKey.org_id).first<{ role: AuthContext['role'] }>()
    : null

  if (!apiKey.org_id || !member) {
    return c.json({ error: 'KEY_ORG_UNRESOLVED', message: 'This API key has no usable organisation. Create a new key.' }, 401)
  }

  c.set('auth', {
    userId: apiKey.user_id,
    orgId: apiKey.org_id,
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
 * Membership of the organisation in the `:id` PATH parameter, re-read from `members` on this
 * request, with the role it grants put on the context as `orgScope`. For the members and
 * invitations endpoints (issue #82 Lane B), which name their organisation in the path rather than
 * taking it from the credential. Run after `requireAuth`.
 *
 * Two things it must get right, and both are about what a refusal TELLS the caller.
 *
 * 1. The role comes from the membership of the ORGANISATION IN THE PATH, never from `auth.role`
 *    (which belongs to the credential's organisation). Reading it here is also what makes a
 *    demotion take effect at once instead of within an access token's lifetime — the same reason
 *    `requireCurrentAdmin` re-reads, except keyed on the path.
 *
 * 2. A caller with no membership gets `404 NOT_FOUND`, the SAME answer as an organisation id that
 *    does not exist. Probing `/api/orgs/<guess>/members` therefore cannot be used to discover
 *    which organisations exist, who is in them, or whether an id is real.
 *
 *    The one exception is not an exception to that rule: when the credential presented ITSELF
 *    names this organisation (`auth.orgId === :id`) and the membership is gone, the answer is
 *    `403 MEMBERSHIP_REVOKED`. That tells the caller nothing they did not already hold — their
 *    own token says which organisation it acts in — and it is the code the dashboard needs in
 *    order to send someone whose membership ended to the organisation picker rather than show
 *    them an error on a page they can no longer load.
 */
export function requireOrgRole(minimum: AuthContext['role']): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const auth = c.get('auth')
    const orgId = c.req.param('id')
    if (!orgId) {
      return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
    }
    const member = await c.env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ? LIMIT 1')
      .bind(orgId, auth.userId).first<{ role: AuthContext['role'] }>()
    if (!member) {
      if (auth.orgId === orgId) {
        return c.json({ error: 'MEMBERSHIP_REVOKED', message: 'Your membership of this organisation has ended' }, 403)
      }
      return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)
    }
    if (ROLE_RANK[member.role] === undefined || ROLE_RANK[member.role] < ROLE_RANK[minimum]) {
      return c.json({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' }, 403)
    }
    c.set('orgScope', { orgId, role: member.role })
    return next()
  }
}

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

// Deliberately fail-open: if the limiter backend is unreachable, a 503 here would stop
// every CI deploy and every `hv run` worldwide, and a rate limit is not what contains a
// stolen credential (revocation and the audit row are). The middleware degrades to the
// per-isolate counter on a backend error, so the endpoint is still bounded, just loosely.
export const secretReadRateLimit = createRateLimitMiddleware({
  scope: 'secret-read',
  limit: 120,
  windowMs: 60_000,
})

// Audit reads return every member's IP and user-agent history, so they get their own
// bucket rather than only the coarse global net. The export is far heavier (up to
// 50,000 rows per call), so it is capped much lower and keyed per organisation.
export const auditReadRateLimit = createRateLimitMiddleware({
  scope: 'audit-read',
  limit: 60,
  windowMs: 60_000,
})

export const auditExportRateLimit = createRateLimitMiddleware({
  scope: 'audit-export',
  limit: 6,
  windowMs: 60_000,
  keyFn: byOrganisation,
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

// Creating an organisation is an account-level write that inserts two rows and an audit row, so it
// is capped like register. Switching is a session rotation a person does by hand, so it is capped
// like refresh — loosely, because hitting it would just lock someone out of their own workspace.
export const orgCreateRateLimit = createRateLimitMiddleware({
  scope: 'org-create',
  limit: 5,
  windowMs: 60_000,
  failClosed: true,
})

export const orgSwitchRateLimit = createRateLimitMiddleware({
  scope: 'org-switch',
  limit: 60,
  windowMs: 60_000,
  failClosed: true,
})

/**
 * Keyed on the organisation in the request PATH, as `requireOrgRole` resolved it — so these
 * limiters must run AFTER it. `auth.orgId` is only the fallback, for a route that has no `:id`.
 * Taking the id straight off the request instead would let a caller mint a fresh bucket per
 * made-up org id; `orgScope` is only ever set for an organisation they are a member of.
 */
const byPathOrganisation = (c: Parameters<NonNullable<Parameters<typeof createRateLimitMiddleware>[0]['keyFn']>>[0]): string | undefined => {
  const orgId = c.get('orgScope')?.orgId ?? c.get('auth')?.orgId
  return orgId ? `org:${orgId}` : undefined
}

/**
 * Creating an invitation sends mail to an address the caller chose, which makes it the one
 * authenticated endpoint that can be pointed at a stranger's inbox. Capped per organisation, not
 * per IP: the thing to bound is "how much mail can one organisation send", which an attacker with
 * a stolen admin session must not be able to raise by changing IP. Fails closed — a 503 here costs
 * an admin a retry, while an unmetered one costs somebody else a mail-bomb.
 */
export const inviteCreateRateLimit = createRateLimitMiddleware({
  scope: 'invite-create',
  limit: 20,
  windowMs: 60_000,
  failClosed: true,
  keyFn: byPathOrganisation,
})

/**
 * Accepting an invitation. Per IP and fail-closed: the tokens carry 256 bits, so this is not what
 * stops guessing — it caps the database work an unauthenticated-ish flood can cause, the same
 * reasoning as `auth-token-submit`.
 */
export const inviteAcceptRateLimit = createRateLimitMiddleware({
  scope: 'invite-accept',
  limit: 10,
  windowMs: 60_000,
  failClosed: true,
})

/**
 * Role changes and removals. Per organisation, because each one writes to `members`, revokes
 * credentials and files an audit row for THAT organisation, and because a stolen admin session
 * must not be able to churn a whole member list faster than anyone can read the audit trail.
 */
export const memberWriteRateLimit = createRateLimitMiddleware({
  scope: 'member-write',
  limit: 30,
  windowMs: 60_000,
  failClosed: true,
  keyFn: byPathOrganisation,
})

/**
 * Account deletion (issue #81). Irreversible and rare, so it is capped tightly per IP and fails
 * closed, like register: a 503 here costs the caller a retry, which is the right side to err on
 * for a destructive endpoint. It runs after requireAuth/requireHuman, so an unauthenticated flood
 * is already turned away by the coarse global net above it.
 */
export const accountDeleteRateLimit = createRateLimitMiddleware({
  scope: 'account-delete',
  limit: 5,
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