// Members and invitations (issue #82, docs/plans/multi-org-and-invites.md Lane B).
//
// Two routers, because they are mounted in two places: `orgMemberRoutes` under `/api/orgs` (the
// organisation's own member list and invitations, named by `:id` in the path) and `inviteRoutes`
// under `/api/invites` (accepting one, which cannot be under `/api/orgs/:id` — the person
// accepting is, by definition, not yet a member of any organisation that would let them address
// it, and must not have to name it to redeem a token that already does).
//
// THE THREE PROPERTIES THIS FILE EXISTS TO HOLD UP.
//
// 1. An invitation is a credential, so it behaves like one. 256 random bits, stored only as
//    SHA-256, returned exactly once, seven days, single use enforced by a conditional UPDATE
//    rather than by a read-then-write, and bound to an address rather than to its bearer. See
//    lib/invites.ts.
//
// 2. A refusal tells the caller nothing they did not already hold. Someone probing
//    `/api/orgs/<guess>/members` gets the same 404 as for an organisation that does not exist
//    (middleware/auth.ts `requireOrgRole`), and someone holding a forwarded invitation learns
//    only the address it was sent to — never the organisation's name, id, size or plan.
//
// 3. An organisation always keeps an owner, and that is enforced by the DATABASE in the same
//    statement that does the write, never by a count read beforehand. Two admins demoting each
//    other at the same moment cannot both pass a check and leave zero owners, because neither
//    `UPDATE` can see a world where the other has not happened: each is a single statement whose
//    guard is a correlated subquery over `members`, and D1 serialises them. The route then READS
//    THE ROW BACK and reports `LAST_OWNER` from what it finds — `meta.changes` is documented by
//    D1 as a rough indication and is never the thing a refusal rests on.
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { runBackground } from '../lib/background'
import { spendEmailBudget } from '../lib/account-security'
import { sendEmail } from '../lib/email'
import { buildInviteLink, orgInviteMessage } from '../lib/email-templates'
import {
  INVITE_LIST_LIMIT,
  INVITE_REFUSALS,
  INVITE_TTL_MS,
  createInviteToken,
  hashInviteToken,
  inviteState,
} from '../lib/invites'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { validationHook } from '../lib/validation'
import {
  inviteAcceptRateLimit,
  inviteCreateRateLimit,
  memberWriteRateLimit,
  requireAuth,
  requireHuman,
  requireOrgRole,
  requireVerifiedEmailIfEnforced,
} from '../middleware/auth'

export const orgMemberRoutes = new Hono<{ Bindings: Env }>()
export const inviteRoutes = new Hono<{ Bindings: Env }>()

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

const ROLES = ['owner', 'admin', 'member', 'viewer'] as const

/** How many members one listing returns. A bound, not a page: nothing pages this yet. */
const MEMBER_LIST_LIMIT = 500

const inviteSchema = z.object({
  // Lower-cased by the route, not here: the stored spelling is what makes `org_invites_open_idx`
  // a constraint per ADDRESS rather than per spelling of one.
  email: z.string().trim().min(3).max(254).email(),
  role: z.enum(ROLES).default('member'),
})

const roleSchema = z.object({
  role: z.enum(ROLES),
})

const acceptSchema = z.object({
  // The length bound matches lib/auth-tokens.ts: a token this codebase issues is 43 characters,
  // and anything outside the range cannot be one, so it is refused before it costs a digest.
  token: z.string().min(16).max(256),
})

/**
 * Who may hand out which role. Only an owner can create or change an owner; an admin cannot
 * promote anyone past their own level. The dashboard offers the same set
 * (`orgs-helpers.assignableRoles`), but this is where it is decided — the UI only avoids
 * offering a choice that would be refused.
 */
function mayAssign(actorRole: MemberRole, target: MemberRole): boolean {
  if (actorRole === 'owner') return true
  return actorRole === 'admin' && target !== 'owner'
}

const FORBIDDEN_ROLE = {
  error: 'FORBIDDEN',
  message: 'Only an owner can grant or change the owner role',
} as const

const OPEN_INVITE_CONFLICT = {
  error: 'CONFLICT',
  message: 'An invitation to that address is already waiting. Revoke it first to send a new one.',
} as const

/**
 * A uniqueness failure, whatever wrapper it arrives in. D1 reports it as
 * `D1_ERROR: UNIQUE constraint failed: org_invites.org_id, org_invites.email: SQLITE_CONSTRAINT`,
 * and the test harness's SQLite as `UNIQUE constraint failed: ...`; the cause chain is read too
 * because which of the two carries the text is not something to depend on. Deliberately narrower
 * than "any constraint": a foreign-key or CHECK failure here would be a bug, not a refusal, and
 * must keep surfacing as a 500 with its request id.
 */
function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Error)) return /unique/i.test(String(err))
  return /unique/i.test(`${err.message} ${String((err as { cause?: unknown }).cause ?? '')}`)
}

// ── Invitations ────────────────────────────────────────────────────────────────────────────────

/**
 * Issue a token, mail the link, and audit that the mail was attempted.
 *
 * Runs in the background (`runBackground` at the call site), so a mail failure can never fail the
 * request that created the invitation — the invitation exists either way, and the create response
 * carries the link so an admin can pass it on by hand. This matters today rather than in theory:
 * the production `EMAIL` binding is commented out pending domain onboarding (#75), so the
 * handed-back link is currently the ONLY path an invitation has.
 *
 * `kind: 'invite'` is its own budget bucket. Borrowing `verify` would mean a run of invitations
 * could silently disable email verification deployment-wide, which is the exact failure #80 fixed
 * for the reset bucket.
 */
async function sendInviteEmail(env: Env, input: { token: string; email: string; orgId: string; orgName: string; inviteId: string }): Promise<void> {
  if (!(await spendEmailBudget(env, 'invite', 'org_invite'))) return
  const link = buildInviteLink(env, input.token, input.email)
  if (!link) return // WEB_APP_URL is not configured: there is no link to send. See OPERATIONS.md § 6.
  await sendEmail(env, orgInviteMessage(input.email, link, input.orgName))
  await writeAuditLog(env, {
    orgId: input.orgId,
    actorId: null,
    actorType: 'system',
    action: 'org.invite.sent',
    resourceType: 'org_invite',
    resourceId: input.inviteId,
  })
}

// POST /api/orgs/:id/invites — invite an address to this organisation.
//
// requireHuman, like POST /api/orgs and switch: an API key is a deployment credential bound to one
// organisation for life, and a leaked CI key must not be able to invite a new owner into an
// organisation or send mail from the deployment. The rate limit runs after requireOrgRole so it
// can be keyed on the organisation the invitation is FOR.
orgMemberRoutes.post(
  '/:id/invites',
  requireAuth,
  requireHuman,
  requireVerifiedEmailIfEnforced,
  requireOrgRole('admin'),
  inviteCreateRateLimit,
  zValidator('json', inviteSchema, validationHook),
  async (c) => {
    const auth = c.get('auth')
    const { orgId, role: actorRole } = c.get('orgScope')
    const body = c.req.valid('json')
    const email = body.email.toLowerCase()
    const role: MemberRole = body.role

    if (!mayAssign(actorRole, role)) return c.json(FORBIDDEN_ROLE, 403)

    // The organisation's name goes in the mail, so it is read here rather than guessed.
    const org = await c.env.DB.prepare('SELECT name FROM organisations WHERE id = ? LIMIT 1')
      .bind(orgId).first<{ name: string }>()
    if (!org) return c.json({ error: 'NOT_FOUND', message: 'Organisation not found' }, 404)

    // Already in: inviting an existing member would create a token that, once accepted, changes
    // nothing. Refused with a code of its own so the dashboard can say why rather than show a
    // generic conflict. This tells an admin only about their own organisation's member list,
    // which they can read directly from the endpoint above.
    //
    // `u.email = ?` relies on `users.email` being stored lower-cased, which every signup path does
    // (`routes/auth.ts` register and the OAuth callback both lower-case before the INSERT). A row
    // that somehow is not only makes this check miss, and the accept path then refuses to insert a
    // second membership anyway — it degrades to a late refusal, never to a duplicate.
    const existing = await c.env.DB.prepare(
      'SELECT m.user_id FROM members m INNER JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND u.email = ? LIMIT 1',
    ).bind(orgId, email).first<{ user_id: string }>()
    if (existing) {
      return c.json({ error: 'ALREADY_MEMBER', message: 'That address is already a member of this organisation' }, 409)
    }

    const inviteId = createPrefixedId('inv')
    const token = createInviteToken()
    const now = new Date()
    const nowIso = now.toISOString()
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString()

    // One open invitation per address per organisation. `org_invites_open_idx` (migration 0018) is
    // the authority; this read only lets the common case answer without relying on an exception.
    // Both paths return the same 409, because to the admin they are the same situation.
    const open = await c.env.DB.prepare(
      'SELECT id FROM org_invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL LIMIT 1',
    ).bind(orgId, email).first<{ id: string }>()
    if (open) return c.json(OPEN_INVITE_CONFLICT, 409)

    try {
      await c.env.DB.prepare(
        'INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(inviteId, orgId, email, role, await hashInviteToken(token), auth.userId, nowIso, expiresAt).run()
    } catch (err) {
      // The partial unique index fired, so another request won the race between the read above and
      // this insert. A constraint doing its job is a refusal, not a 500.
      if (isUniqueViolation(err)) return c.json(OPEN_INVITE_CONFLICT, 409)
      throw err
    }

    await writeAuditLog(c.env, {
      orgId,
      actorId: auth.userId,
      actorType: auth.actorType,
      action: 'org.invite.create',
      resourceType: 'org_invite',
      resourceId: inviteId,
      // The role this address was invited at, known here from the request. Until acceptance the
      // role lived only on the `org_invites` row, which the cron sweep collects after seven days
      // (issue #96) — recording it keeps the trail answerable afterwards. A non-secret role name.
      metadata: { role },
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent'),
    })

    await runBackground(c, sendInviteEmail(c.env, { token, email, orgId, orgName: org.name, inviteId }))

    // `acceptUrl` is the ONE time the token leaves the server. It goes to the admin who just
    // created the invitation, who already knows the address and could invite it again anyway, so
    // it grants them nothing new — and the invitation is bound to that address, so the link cannot
    // add a different account. Every response carries `Cache-Control: no-store`
    // (middleware/security-headers.ts), and the dashboard keeps it in component state only.
    return c.json({
      data: {
        invite: { id: inviteId, orgId, email, role, createdAt: nowIso, expiresAt, invitedBy: auth.userId },
        acceptUrl: buildInviteLink(c.env, token, email),
      },
    }, 201)
  },
)

// GET /api/orgs/:id/invites — the invitations still waiting.
//
// Open means: not accepted, not revoked, not yet expired. An expired row may sit here until the
// cron sweep collects it (lib/housekeeping.ts), so expiry is filtered in the query rather than
// left to whatever the sweep has got round to.
//
// The projection is the point of this handler: `token_hash` is never selected. Not redacted after
// the fact, not selected and dropped — never read, so no later edit to the response shape can
// leak it by accident.
orgMemberRoutes.get('/:id/invites', requireAuth, requireHuman, requireOrgRole('admin'), async (c) => {
  const { orgId } = c.get('orgScope')
  const { results } = await c.env.DB.prepare(
    'SELECT id, email, role, created_at, expires_at, invited_by FROM org_invites'
    + ' WHERE org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?'
    + ' ORDER BY created_at DESC LIMIT ?',
  ).bind(orgId, new Date().toISOString(), INVITE_LIST_LIMIT).all()
  return c.json({ data: results, total: results.length })
})

// DELETE /api/orgs/:id/invites/:inviteId — revoke.
//
// Soft, not a delete: the row keeps saying that the invitation happened and who ended it, and the
// cron sweep collects it later. `org_invites_open_idx` is partial on
// `accepted_at IS NULL AND revoked_at IS NULL`, so revoking frees the address immediately.
orgMemberRoutes.delete('/:id/invites/:inviteId', requireAuth, requireHuman, requireOrgRole('admin'), memberWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { orgId } = c.get('orgScope')
  const { inviteId } = c.req.param()
  const nowIso = new Date().toISOString()

  // `org_id = ?` is what makes an invitation id from another organisation read as "no such
  // invitation" rather than as somebody else's row to revoke.
  await c.env.DB.prepare(
    'UPDATE org_invites SET revoked_at = ?, revoked_by = ?'
    + ' WHERE id = ? AND org_id = ? AND accepted_at IS NULL AND revoked_at IS NULL',
  ).bind(nowIso, auth.userId, inviteId, orgId).run()

  // Read back rather than trust `meta.changes`: zero changes here has three different meanings
  // (no such invitation, already accepted, already revoked) and only the row can tell them apart.
  const row = await c.env.DB.prepare('SELECT accepted_at, revoked_at, revoked_by FROM org_invites WHERE id = ? AND org_id = ? LIMIT 1')
    .bind(inviteId, orgId).first<{ accepted_at: string | null; revoked_at: string | null; revoked_by: string | null }>()
  if (!row) return c.json({ error: 'NOT_FOUND', message: 'Invitation not found' }, 404)
  if (row.revoked_at === null) {
    // It was not revoked and it is not revoked now, so the only thing that can have stopped the
    // UPDATE is that it had already been accepted. Revoking a membership is a different endpoint.
    return c.json({ error: 'CONFLICT', message: 'That invitation has already been accepted. Remove the member instead.' }, 409)
  }

  // Audited only when THIS request is the one that revoked it, so a repeated DELETE is idempotent
  // without filing a second row saying it happened twice.
  if (row.revoked_at === nowIso && row.revoked_by === auth.userId) {
    await writeAuditLog(c.env, {
      orgId,
      actorId: auth.userId,
      actorType: auth.actorType,
      action: 'org.invite.revoke',
      resourceType: 'org_invite',
      resourceId: inviteId,
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent'),
    })
  }

  return c.json({ data: { id: inviteId, revokedAt: row.revoked_at } })
})

// POST /api/invites/accept — redeem a token.
//
// Authenticated: an invitation names an address, and the only proof this API has that somebody
// holds an address is a verified account on it. So the caller signs in first and the token is
// matched against THAT account — which is why a forwarded link is useless, and why the refusals
// below are the interesting part of this handler.
inviteRoutes.post('/accept', inviteAcceptRateLimit, requireAuth, requireHuman, zValidator('json', acceptSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const { token } = c.req.valid('json')
  const nowIso = new Date().toISOString()

  // Hashed once: it is the only handle on the invitation and it is used by three statements below.
  const tokenHash = await hashInviteToken(token)

  const invite = await c.env.DB.prepare(
    'SELECT i.id, i.org_id, i.email, i.role, i.accepted_at, i.revoked_at, i.expires_at, o.name AS org_name'
    + ' FROM org_invites i INNER JOIN organisations o ON o.id = i.org_id WHERE i.token_hash = ? LIMIT 1',
  ).bind(tokenHash).first<{
    id: string
    org_id: string
    email: string
    role: MemberRole
    accepted_at: string | null
    revoked_at: string | null
    expires_at: string
    org_name: string
  }>()

  if (!invite) {
    return c.json({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid.' }, 404)
  }

  // State before identity. Both orderings disclose the same thing — the invited address is
  // disclosed to any token holder either way (it is pinned, and whoever holds the emailed token
  // already has the address) — so the order is chosen for usefulness: "this expired, ask for a new
  // one" is more actionable than "you are the wrong person for a link that is dead anyway".
  const state = inviteState(invite, nowIso)
  if (state !== 'open') return c.json(INVITE_REFUSALS[state], 403)

  const user = await c.env.DB.prepare('SELECT email, email_verified FROM users WHERE id = ? LIMIT 1')
    .bind(auth.userId).first<{ email: string; email_verified: number }>()
  if (!user) {
    // requireAuth already proved the user exists; a row that vanished between the two reads is
    // not a case to invent an answer for.
    return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
  }

  // Both sides lower-cased at the point of comparison. The writers already store both lower-cased,
  // but "equal, case-insensitively" is the rule the contract states and it should not be a property
  // of two other files being right.
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    // The wrong-account refusal. `invitedEmail` is TOP LEVEL on purpose: the dashboard reads it as
    // `ApiError.details.invitedEmail`, and `details` is the whole error body (apps/web/src/lib/api.ts),
    // so a nested `details` object would never reach the page. Without the address the page can
    // only say "this was sent to someone else", which does not tell the person which account to
    // sign in as. Nothing about the organisation goes in it — not the name, not the id: a stranger
    // holding a forwarded link must learn no more than the address it was forwarded from.
    return c.json({
      error: 'INVITE_EMAIL_MISMATCH',
      message: 'This invitation was sent to a different email address. Sign in with that address to accept it.',
      invitedEmail: invite.email,
    }, 403)
  }

  if (user.email_verified !== 1) {
    // Unconditional, unlike `requireVerifiedEmailIfEnforced`: without it, anyone could type a
    // colleague's address at sign-up and walk into their organisation on an invitation meant for
    // them. The address is the whole credential here, so proving it is not optional.
    return c.json({
      error: 'EMAIL_NOT_VERIFIED',
      message: 'Confirm your email address first. An invitation is accepted by a verified address.',
    }, 403)
  }

  // ── The redemption. One batch, so the membership and the invitation's state move together. ──
  //
  // Both statements carry their own guard, which is what makes this safe under concurrency rather
  // than the batch being a transaction (it is, but a transaction that writes a row twice still
  // writes it twice). The second of two concurrent accepts of the same token matches NEITHER
  // guard: `accepted_at IS NULL` is false by then. And the `NOT EXISTS` on members means a caller
  // who is somehow already a member gets no second row — whichever order the two arrive in.
  const memberId = createPrefixedId('mem')
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO members (id, org_id, user_id, role, created_at)'
      + ' SELECT ?, i.org_id, ?, i.role, ? FROM org_invites i'
      + ' WHERE i.token_hash = ? AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?'
      + '   AND NOT EXISTS (SELECT 1 FROM members m WHERE m.org_id = i.org_id AND m.user_id = ?)',
    ).bind(memberId, auth.userId, nowIso, tokenHash, nowIso, auth.userId),
    c.env.DB.prepare(
      'UPDATE org_invites SET accepted_at = ?, accepted_by = ?'
      + ' WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?',
    ).bind(nowIso, auth.userId, tokenHash, nowIso),
  ])

  // The answer comes from the row, not from the batch's counters. Exactly one membership can exist
  // for a (org, user) pair after the statements above, so reading it back both confirms the write
  // and supplies the role to report — which is the EXISTING role when the caller was already a
  // member: accepting an invitation must not quietly re-grade somebody's access, and a role change
  // is PATCH .../members/:userId.
  const membership = await c.env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ? LIMIT 1')
    .bind(invite.org_id, auth.userId).first<{ role: MemberRole }>()
  if (!membership) {
    // No membership means neither statement's guard matched, which means the invitation was revoked,
    // accepted or expired between the read at the top and the batch — the window the guards exist
    // to close. Re-read the row and say which, rather than reporting the state that was read before.
    const after = await c.env.DB.prepare('SELECT accepted_at, revoked_at, expires_at FROM org_invites WHERE id = ? LIMIT 1')
      .bind(invite.id).first<{ accepted_at: string | null; revoked_at: string | null; expires_at: string }>()
    // Gone entirely: the cron sweep collected it, which it only does for a row already past its
    // expiry or revoked. There is nothing left to describe, so it is the same answer as a token
    // this deployment has never seen.
    if (!after) return c.json({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid.' }, 404)
    const raced = inviteState(after, nowIso)
    // 'open' is unreachable (the guards would have matched), and is reported as spent rather than
    // as a 500: whatever happened, this token did not add anybody.
    return c.json(raced === 'open' ? INVITE_REFUSALS.accepted : INVITE_REFUSALS[raced], 403)
  }

  await writeAuditLog(c.env, {
    orgId: invite.org_id,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: 'org.invite.accept',
    resourceType: 'org_invite',
    resourceId: invite.id,
    // The role actually granted (`membership.role`), which is the EXISTING role when the caller was
    // already a member — not necessarily `invite.role`. A non-secret role name (issue #96).
    metadata: { role: membership.role },
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  // The caller's session is NOT moved into the organisation they just joined, and no new token is
  // minted here. An organisation is chosen explicitly (`POST /api/orgs/:id/switch`), which the
  // dashboard offers as a button once this returns.
  return c.json({
    data: { orgId: invite.org_id, orgName: invite.org_name, role: membership.role, userId: auth.userId },
  }, 201)
})

// ── Members ───────────────────────────────────────────────────────────────────────────────────

// GET /api/orgs/:id/members — everyone with access, oldest membership first.
//
// Any member may read it, down to `viewer`: knowing who else can see your organisation's secrets
// is not privileged information, and the dashboard says as much ("you can still see who has
// access") while hiding the controls. It carries addresses and nothing else about the people.
orgMemberRoutes.get('/:id/members', requireAuth, requireHuman, requireOrgRole('viewer'), async (c) => {
  const { orgId } = c.get('orgScope')
  const { results } = await c.env.DB.prepare(
    'SELECT m.user_id, u.email, m.role, m.created_at AS joined_at FROM members m'
    + ' INNER JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created_at ASC LIMIT ?',
  ).bind(orgId, MEMBER_LIST_LIMIT).all()
  return c.json({ data: results, total: results.length })
})

/**
 * The `LAST_OWNER` guard, as a SQL fragment: true when this membership is not the last owner, so
 * it can be demoted or removed.
 *
 * It is a correlated subquery INSIDE the write statement, not a count read beforehand, and that is
 * the whole of the race-safety argument. A `SELECT COUNT(*) ... WHERE role = 'owner'` followed by
 * an `UPDATE` is two statements: two owners demoting each other at the same moment both read 2,
 * both decide they are allowed, and the organisation ends with none. Here the condition is
 * evaluated as part of the single statement that performs the write, and D1 serialises writes to a
 * database, so the second one evaluates it against a database in which the first has committed and
 * matches no row.
 *
 * Binds, in order: the organisation id and the target user id.
 */
const NOT_LAST_OWNER = "(role <> 'owner' OR EXISTS ("
  + " SELECT 1 FROM members m2 WHERE m2.org_id = ? AND m2.role = 'owner' AND m2.user_id <> ?))"

/**
 * Exported so the whole-account deletion path (routes/account.ts, issue #81) refuses with the SAME
 * rule and message when a departing user is the last owner of a shared organisation, rather than
 * drifting a second copy of the wording.
 */
export const LAST_OWNER_REFUSAL = {
  error: 'LAST_OWNER',
  message: 'An organisation must keep an owner. Make someone else an owner first.',
} as const

/**
 * "An admin may not touch an owner", as a SQL fragment, so that it is decided by the write and not
 * only by the read above it.
 *
 * The read-then-write version has a window, narrow but real: an admin reads a member as `member`,
 * an owner promotes that member to `owner`, and the admin's write lands on an owner they were
 * never allowed to touch. A fixed internal fragment — no caller value reaches it — appended to the
 * statement closes it, and the read-back then tells the two refusals apart.
 */
function ownerFence(actorRole: MemberRole): string {
  return actorRole === 'owner' ? '' : " AND role <> 'owner'"
}

// PATCH /api/orgs/:id/members/:userId — change a member's role.
orgMemberRoutes.patch(
  '/:id/members/:userId',
  requireAuth,
  requireHuman,
  requireOrgRole('admin'),
  memberWriteRateLimit,
  zValidator('json', roleSchema, validationHook),
  async (c) => {
    const auth = c.get('auth')
    const { orgId, role: actorRole } = c.get('orgScope')
    const { userId } = c.req.param()
    const { role } = c.req.valid('json')

    const current = await c.env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ? LIMIT 1')
      .bind(orgId, userId).first<{ role: MemberRole }>()
    // Not a member of THIS organisation: the same answer whether the account exists or not, so
    // this endpoint cannot be used to test whether an account id is real.
    if (!current) return c.json({ error: 'NOT_FOUND', message: 'That person is not a member of this organisation' }, 404)

    // An admin may neither grant the owner role nor touch an owner's. Checked against both the
    // role being set and the role being replaced, because either direction crosses the line.
    if (!mayAssign(actorRole, role) || !mayAssign(actorRole, current.role)) return c.json(FORBIDDEN_ROLE, 403)

    if (current.role === role) return c.json({ data: { userId, role } }) // nothing to write, nothing to audit

    // The last-owner guard only bites when an owner is being demoted; `? = 'owner'` short-circuits
    // a promotion TO owner, which can never reduce the owner count.
    await c.env.DB.prepare(
      `UPDATE members SET role = ? WHERE org_id = ? AND user_id = ?${ownerFence(actorRole)}`
      + ` AND (? = 'owner' OR ${NOT_LAST_OWNER})`,
    ).bind(role, orgId, userId, role, orgId, userId).run()

    const after = await c.env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ? LIMIT 1')
      .bind(orgId, userId).first<{ role: MemberRole }>()
    if (!after) return c.json({ error: 'NOT_FOUND', message: 'That person is not a member of this organisation' }, 404)
    // They are an owner now, and this actor may not change an owner's role: either they already
    // were (refused above) or they were promoted while this request was in flight.
    if (after.role === 'owner' && !mayAssign(actorRole, 'owner')) return c.json(FORBIDDEN_ROLE, 403)
    if (after.role !== role) return c.json(LAST_OWNER_REFUSAL, 409)

    await writeAuditLog(c.env, {
      orgId,
      actorId: auth.userId,
      actorType: auth.actorType,
      action: 'org.member.role_change',
      resourceType: 'member',
      resourceId: userId,
      // The whole point of issue #96: the trail now says what the role changed to, not only that it
      // changed. Both are non-secret role names from a fixed four-value vocabulary (`ROLES`).
      metadata: { from: current.role, to: role },
      ip: getRequestIp(c),
      userAgent: c.req.header('user-agent'),
    })

    return c.json({ data: { userId, role } })
  },
)

// DELETE /api/orgs/:id/members/:userId — remove a member, or leave yourself.
//
// `requireOrgRole('viewer')` because leaving is every member's own business; removing somebody
// ELSE then needs admin, which is checked below against the role in THIS organisation.
orgMemberRoutes.delete('/:id/members/:userId', requireAuth, requireHuman, requireOrgRole('viewer'), memberWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { orgId, role: actorRole } = c.get('orgScope')
  const { userId } = c.req.param()
  const isSelf = userId === auth.userId

  if (!isSelf && actorRole !== 'owner' && actorRole !== 'admin') {
    return c.json({ error: 'FORBIDDEN', message: 'You do not have permission to perform this action' }, 403)
  }

  const current = await c.env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ? LIMIT 1')
    .bind(orgId, userId).first<{ role: MemberRole }>()
  if (!current) return c.json({ error: 'NOT_FOUND', message: 'That person is not a member of this organisation' }, 404)

  // An admin cannot remove an owner. Leaving is exempt — an owner may always leave, as long as
  // they are not the last one, which the statement below decides.
  if (!isSelf && !mayAssign(actorRole, current.role)) return c.json(FORBIDDEN_ROLE, 403)

  const nowSeconds = Math.floor(Date.now() / 1000)
  await c.env.DB.batch([
    // `ownerFence` is skipped when leaving: an owner may always remove themselves, as long as they
    // are not the last one — which is the other guard's job.
    c.env.DB.prepare(
      `DELETE FROM members WHERE org_id = ? AND user_id = ?${isSelf ? '' : ownerFence(actorRole)} AND ${NOT_LAST_OWNER}`,
    ).bind(orgId, userId, orgId, userId),
    // The credentials this person holds FOR THIS ORGANISATION, in the same batch as the membership
    // (plan, Lane B). Lane A already makes both fail closed after removal — a refresh answers
    // MEMBERSHIP_REVOKED, a key answers KEY_ORG_UNRESOLVED — so this is not what authorises
    // nothing: it makes removal immediate instead of eventual (an access token already issued would
    // otherwise work for up to its 15 minutes) and legible (an operator reading `api_keys` can see
    // which keys are dead).
    //
    // `NOT EXISTS` is load-bearing, not belt-and-braces. These run inside the same transaction as
    // the delete above, so they see its result: if the delete was REFUSED by the last-owner guard,
    // the membership still exists and neither statement touches anything. Without it, refusing to
    // remove the last owner would still have destroyed their sessions and keys.
    c.env.DB.prepare(
      'DELETE FROM refresh_tokens WHERE user_id = ? AND org_id = ?'
      + ' AND NOT EXISTS (SELECT 1 FROM members WHERE org_id = ? AND user_id = ?)',
    ).bind(userId, orgId, orgId, userId),
    c.env.DB.prepare(
      "UPDATE api_keys SET revoked_at = ?, revoked_reason = 'membership_removed'"
      + ' WHERE user_id = ? AND org_id = ? AND revoked_at IS NULL'
      + ' AND NOT EXISTS (SELECT 1 FROM members WHERE org_id = ? AND user_id = ?)',
    ).bind(nowSeconds, userId, orgId, orgId, userId),
  ])

  const after = await c.env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ? LIMIT 1')
    .bind(orgId, userId).first<{ role: MemberRole }>()
  if (after) {
    // Still a member, so one of the two guards refused. As in PATCH: an owner this actor may not
    // touch (promoted while the request was in flight) is a permission answer, not a last-owner one.
    if (after.role === 'owner' && !isSelf && !mayAssign(actorRole, 'owner')) return c.json(FORBIDDEN_ROLE, 403)
    return c.json(LAST_OWNER_REFUSAL, 409)
  }

  // Against the organisation the membership belonged to, never the actor's current one — which is
  // the same thing here, and is read from `orgScope` so that it stays true if it ever is not.
  await writeAuditLog(c.env, {
    orgId,
    actorId: auth.userId,
    actorType: auth.actorType,
    action: isSelf ? 'org.member.leave' : 'org.member.remove',
    resourceType: 'member',
    resourceId: userId,
    // The role the person held when they were removed (or left), read above as `current.role` —
    // known without an extra query. A non-secret role name; records which privilege was given up.
    metadata: { role: current.role },
    ip: getRequestIp(c),
    userAgent: c.req.header('user-agent'),
  })

  // Any invitation still open for this address becomes sendable again on its own, because
  // `org_invites_open_idx` only constrains OPEN rows and there is no open row for a member.
  return c.json({ data: { userId, removed: true } })
})
