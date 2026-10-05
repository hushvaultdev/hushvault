// Organisation context: the list the dashboard's switcher reads, creating an org, and switching
// the current session into one (issue #82, docs/plans/multi-org-and-invites.md Lane A).
//
// The rule the whole file exists to hold up: an org is chosen EXPLICITLY and then carried by the
// credential. Nothing here re-derives an org from the caller's memberships, and switching is a
// real session rotation — a new refresh family bound to the new org — not just a fresh access
// token, because otherwise the next refresh would drag the session back to the old org.
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { auditLogStatement, getRequestIp, writeAuditLog } from '../lib/security'
import {
  issueSession,
  presentedRefreshToken,
  revokeRefreshFamily,
  setRefreshCookie,
  wantsBodyRefresh,
} from '../lib/sessions'
import { orgCreateRateLimit, orgSwitchRateLimit, requireAuth, requireHuman, requireVerifiedEmailIfEnforced } from '../middleware/auth'
import { validationHook } from '../lib/validation'

export const orgRoutes = new Hono<{ Bindings: Env }>()

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

type OrgRow = { id: string; name: string; slug: string; plan: string; role: MemberRole }

const createSchema = z.object({
  name: z.string().min(2).max(120),
})

/** Switching rotates the refresh family, so a CLI caller hands its refresh token in like on refresh. */
const switchSchema = z.object({
  refreshToken: z.string().min(16).max(256).optional(),
}).default({})

/** Every org the caller belongs to, oldest membership first. One indexed read of members(user_id). */
async function membershipsOf(env: Env, userId: string): Promise<OrgRow[]> {
  const { results } = await env.DB.prepare(
    'SELECT o.id, o.name, o.slug, o.plan, m.role FROM members m INNER JOIN organisations o ON o.id = m.org_id'
    + ' WHERE m.user_id = ? ORDER BY m.created_at ASC',
  ).bind(userId).all<OrgRow>()
  return results
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
}

// GET /api/orgs — the switcher's source of truth: which orgs the caller is in, their role in each,
// and which one the credential presented on THIS request is acting in.
orgRoutes.get('/', requireAuth, async (c) => {
  const auth = c.get('auth')
  const orgs = await membershipsOf(c.env, auth.userId)
  return c.json({
    data: orgs.map((org) => ({ ...org, current: org.id === auth.orgId })),
    currentOrgId: auth.orgId,
  })
})

// POST /api/orgs — create an organisation; the caller becomes its owner.
//
// requireHuman: an API key is bound to one org for life, so letting a credential mint an org it
// could never act in has no use and gives a leaked key a way to make noise. The caller's session
// is NOT switched into the new org — that is an explicit call to switch below.
orgRoutes.post('/', orgCreateRateLimit, requireAuth, requireHuman, requireVerifiedEmailIfEnforced, zValidator('json', createSchema, validationHook), async (c) => {
  const { name } = c.req.valid('json')
  const auth = c.get('auth')
  const orgId = createPrefixedId('org')
  const now = new Date().toISOString()
  // organisations.slug is globally UNIQUE, so the id suffix is what keeps two orgs of the same
  // name from colliding — same construction as registration.
  const slug = `${toSlug(name) || 'org'}-${orgId.slice(-6).toLowerCase()}`

  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, 'free', ?)")
      .bind(orgId, name, slug, now),
    c.env.DB.prepare("INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)")
      .bind(createPrefixedId('mem'), orgId, auth.userId, now),
  ])

  // Against the NEW org: an audit row's org comes from the resource it is about.
  await writeAuditLog(c.env, {
    orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'org.create',
    resourceType: 'organisation',
    resourceId: orgId,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  return c.json({ data: { id: orgId, name, slug, plan: 'free', role: 'owner' as const } }, 201)
})

// POST /api/orgs/:id/switch — act in another org the caller is already a member of.
//
// Both halves of the credential move: a new access token for the target org, AND a new refresh
// family bound to it. Minting only the access token would leave the refresh family pointing at the
// old org, so the next refresh (within 15 minutes) would silently move the session back — the same
// class of bug as the one this change removes.
orgRoutes.post('/:id/switch', orgSwitchRateLimit, requireAuth, requireHuman, zValidator('json', switchSchema, validationHook), async (c) => {
  const { id } = c.req.param()
  const auth = c.get('auth')
  const bodyToken = c.req.valid('json').refreshToken

  // Membership is verified against the target org, and the role is read from it — never inherited
  // from the current session. A non-member gets 403 with a code of its own: pretending the org does
  // not exist would be a 404 that the dashboard cannot tell from a deleted org.
  const member = await c.env.DB.prepare('SELECT role FROM members WHERE user_id = ? AND org_id = ? LIMIT 1')
    .bind(auth.userId, id).first<{ role: MemberRole }>()
  if (!member) {
    return c.json({ error: 'NOT_A_MEMBER', message: 'You are not a member of that organisation' }, 403)
  }

  // Retire the family the caller came in on, so no token of it survives bound to the old org.
  // Scoped to this user: the presented token is not what authenticates this request, so it must not
  // be able to revoke somebody else's session.
  const presented = presentedRefreshToken(c, bodyToken)
  if ('token' in presented) await revokeRefreshFamily(c.env, presented.token, auth.userId)

  const session = await issueSession(c.env, { userId: auth.userId, orgId: id, role: member.role })
  const viaCookie = !bodyToken
  if (viaCookie) setRefreshCookie(c, session.refreshToken)

  // Two rows, because an audit log is read per org and a switch is an event in both: the org being
  // left records that this session stopped acting there, which is otherwise invisible to its
  // admins, and the org being entered records the arrival. The source row is skipped when the
  // caller is already acting in the target org (a no-op switch the dashboard can send on reload).
  const auditRows = [auditLogStatement(c.env, {
    orgId: id,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'org.switch_in',
    resourceType: 'organisation',
    resourceId: id,
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })]
  if (auth.orgId !== id) {
    auditRows.push(auditLogStatement(c.env, {
      orgId: auth.orgId,
      actorId: auth.userId,
      actorType: auth.actorType,
      action: 'org.switch_out',
      resourceType: 'organisation',
      resourceId: id,
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent'),
    }))
  }
  await c.env.DB.batch(auditRows)

  return c.json({
    data: {
      token: session.accessToken,
      expiresIn: session.expiresIn,
      userId: auth.userId,
      orgId: id,
      role: member.role,
      orgs: await membershipsOf(c.env, auth.userId),
      // Same rule as refresh: a cookie-authenticated caller never reads a refresh token back out,
      // whatever client it claims to be.
      ...(!viaCookie && wantsBodyRefresh(c) ? { refreshToken: session.refreshToken } : {}),
    },
  })
})
