// Account deletion / GDPR erasure (issue #81).
//
// `DELETE /api/account` — self-service, and self-service ONLY: it deletes the CALLER's own
// account. There is no admin-initiated deletion of another user, by design.
//
// THE THREE THINGS THIS FILE EXISTS TO GET RIGHT.
//
// 1. THE FOREIGN-KEY FIX, WITHOUT A MIGRATION. `DELETE FROM users` is blocked by three columns that
//    reference `users(id)` with NO `ON DELETE` clause: `integration_connections.created_by` (0010),
//    `sync_targets.created_by` (0011) and `oidc_repo_rules.created_by` (0013). Per
//    `.claude/rules/database-schema.md`, those tables must NOT be rebuilt — a rename-and-drop rebuild
//    of a referenced table silently fires the children's cascades and destroys the sync ledger. So
//    `ON DELETE SET NULL` semantics are reached from the application instead: the three columns are
//    nulled for this user in the SAME `batch()` as the delete, BEFORE the user row goes. The
//    `NO ACTION` foreign key stays a SAFETY PROPERTY — no code path can remove a user while rows
//    still attribute work to them.
//
// 2. ORGANISATIONS. A sole-member org is erased with the user (D1 cascades its data, and this file
//    sweeps its KV secret blobs, which no cascade reaches). A shared org loses only this member — via
//    the `members` cascade from the user delete — UNLESS the user is its last owner, in which case
//    the WHOLE deletion is refused (`LAST_OWNER`) and nothing is touched.
//
// 3. THE AUDIT ROW. `audit_log.actor_id` is `ON DELETE SET NULL`, so the `user.delete` row is written
//    BEFORE the user row, in the same batch, into every SURVIVING org the user belonged to, with the
//    deleted user's id in `resource_id` as a literal TEXT string (it survives the actor_id null-ing).
//    Erased orgs get no row — their `audit_log` is cascaded away and no one is left to read it.
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { verifyPassword } from '../lib/auth'
import { clearRefreshCookie } from '../lib/sessions'
import { auditLogStatement, getRequestIp } from '../lib/security'
import { KV_DELETE_CHUNK, allSecretBlobKeys } from '../lib/secret-blobs'
import { accountDeleteRateLimit, requireAuth, requireHuman } from '../middleware/auth'
import { LAST_OWNER_REFUSAL } from './members'
import { validationHook } from '../lib/validation'

export const accountRoutes = new Hono<{ Bindings: Env }>()

type MemberRole = 'owner' | 'admin' | 'member' | 'viewer'

/**
 * Re-authentication, not just authorisation: a bearer token already got the caller here, so the
 * confirmation proves it is still the account owner at the keyboard before anything irreversible.
 * A password account re-sends its current password; an OAuth-only account (no password set) types
 * its own email address. One of the two is required — neither is accepted in place of the other.
 */
const deleteAccountSchema = z
  .object({
    password: z.string().min(1).max(128).optional(),
    confirmEmail: z.string().max(254).optional(),
  })
  .strict()

// DELETE /api/account — erase the caller's own account.
//
// requireHuman: an API key must never be able to delete its owner's account. A leaked CI key
// deleting the workspace it belongs to is exactly the irreversible act the human gate exists for,
// the same reasoning as minting/revoking keys and managing outbound credentials.
accountRoutes.delete(
  '/',
  requireAuth,
  requireHuman,
  accountDeleteRateLimit,
  zValidator('json', deleteAccountSchema, validationHook),
  async (c) => {
    const auth = c.get('auth')
    const db = c.env.DB
    const { password, confirmEmail } = c.req.valid('json')

    const user = await db.prepare('SELECT email, password_hash, salt FROM users WHERE id = ? LIMIT 1')
      .bind(auth.userId).first<{ email: string; password_hash: string; salt: string }>()
    if (!user) {
      // requireAuth proved the user exists this request; a row that vanished between the two reads
      // is not a state to invent an answer for.
      return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401)
    }

    // An OAuth-only account has an empty password hash and salt (the OAuth signup path stores '').
    // Such an account has no password to re-enter, so it confirms by typing its own email instead.
    const hasPassword = user.password_hash !== '' && user.salt !== ''
    if (hasPassword) {
      if (!password) {
        return c.json({ error: 'REAUTH_REQUIRED', message: 'Re-enter your current password to delete your account' }, 403)
      }
      if (!(await verifyPassword(password, user.salt, user.password_hash))) {
        // Opaque: it says the confirmation failed, never anything about the stored hash.
        return c.json({ error: 'REAUTH_FAILED', message: 'Password is incorrect' }, 403)
      }
    } else if (!confirmEmail || confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      return c.json({ error: 'REAUTH_REQUIRED', message: 'Type your account email address to confirm deletion' }, 403)
    }

    // Resolve every org the user belongs to, with the member count and owner count of each — one
    // query, so the decision below is made against a single consistent read.
    const memberships = await db.prepare(
      'SELECT m.org_id AS org_id, m.role AS role,'
      + ' (SELECT COUNT(*) FROM members mc WHERE mc.org_id = m.org_id) AS member_count,'
      + " (SELECT COUNT(*) FROM members mo WHERE mo.org_id = m.org_id AND mo.role = 'owner') AS owner_count"
      + ' FROM members m WHERE m.user_id = ?',
    ).bind(auth.userId).all<{ org_id: string; role: MemberRole; member_count: number; owner_count: number }>()

    const soleMemberOrgIds: string[] = []
    const sharedOrgIds: string[] = []
    for (const row of memberships.results ?? []) {
      if (row.member_count <= 1) {
        soleMemberOrgIds.push(row.org_id)
      } else {
        // A shared org where this user is the ONLY owner: deleting them would leave it ownerless.
        // Refuse the WHOLE deletion and touch nothing — they must hand ownership over first. Same
        // rule and message as removing the last owner from a shared org (routes/members.ts).
        if (row.role === 'owner' && row.owner_count <= 1) {
          return c.json(LAST_OWNER_REFUSAL, 409)
        }
        sharedOrgIds.push(row.org_id)
      }
    }

    // Collect every KV blob key owned by the orgs about to be ERASED, BEFORE the D1 cascade removes
    // the `secrets` rows that name them. Same collection + bounded-delete path as the project and
    // secret delete routes (routes/projects.ts, routes/secrets.ts): KV is a separate store that no
    // D1 cascade reaches, so leaving these behind would strand encrypted secrets and defeat the
    // erasure. `secret_history` is gone (issue #84), so there is no second set of keys to join for.
    const kvKeySet = new Set<string>()
    if (soleMemberOrgIds.length > 0) {
      const placeholders = soleMemberOrgIds.map(() => '?').join(', ')
      const secretRows = await db.prepare(
        'SELECT s.id AS id, s.blob_rev AS blob_rev FROM secrets s'
        + ` INNER JOIN projects p ON p.id = s.project_id WHERE p.org_id IN (${placeholders})`,
      ).bind(...soleMemberOrgIds).all<{ id: string; blob_rev: number }>()
      for (const r of secretRows.results ?? []) {
        for (const key of allSecretBlobKeys(r.id, r.blob_rev)) kvKeySet.add(key)
      }
    }
    const kvKeys = [...kvKeySet]

    const ip = getRequestIp(c)
    const userAgent = c.req.header('user-agent') ?? null
    const statements = [
      // 1. SET NULL semantics for the three NO ACTION `created_by` refs (issue #81). Null every row
      //    this user created that will OUTLIVE them, so the final `DELETE FROM users` is not blocked.
      //    Rows inside erased orgs are removed by the org cascade below anyway, so nulling them first
      //    is harmless; doing it unconditionally keeps this correct for rows in surviving orgs too.
      db.prepare('UPDATE integration_connections SET created_by = NULL WHERE created_by = ?').bind(auth.userId),
      db.prepare('UPDATE sync_targets SET created_by = NULL WHERE created_by = ?').bind(auth.userId),
      db.prepare('UPDATE oidc_repo_rules SET created_by = NULL WHERE created_by = ?').bind(auth.userId),
      // 2. The deletion audit row, into every SURVIVING org (Decision B). Written before the user
      //    row and in the same batch, because actor_id is ON DELETE SET NULL; resource_id holds the
      //    deleted user's id as plain TEXT so the trail still names them after actor_id is nulled.
      //    metadata is a bounded, non-secret, server-set object (.claude/rules/audit-log.md): a flag
      //    that this was a self-service deletion, and the count of orgs erased with the account.
      ...sharedOrgIds.map((orgId) => auditLogStatement(c.env, {
        orgId,
        actorId: auth.userId,
        actorType: 'user',
        action: 'user.delete',
        resourceType: 'user',
        resourceId: auth.userId,
        metadata: { self: true, orgs_erased: soleMemberOrgIds.length },
        ip,
        userAgent,
      })),
      // 3. Erase sole-member orgs. D1 cascades projects -> environments -> secrets, members,
      //    api_keys/refresh_tokens bound to the org, audit_log, org_invites, and
      //    integration_connections -> sync_targets -> sync_items/runs/outbox and oidc_repo_rules.
      ...soleMemberOrgIds.map((orgId) => db.prepare('DELETE FROM organisations WHERE id = ?').bind(orgId)),
      // 4. Delete the user. members / api_keys / refresh_tokens / auth_tokens all cascade from
      //    users(id), so the user's memberships of the surviving (shared) orgs and ALL their
      //    credentials go with this one statement — "remove membership from shared orgs" and "revoke
      //    the user's refresh tokens and API keys" together. The three created_by refs were nulled in
      //    step 1, so the NO ACTION foreign keys no longer block it.
      db.prepare('DELETE FROM users WHERE id = ?').bind(auth.userId),
    ]

    await db.batch(statements)

    // Confirm the erasure by reading the row back, never by trusting meta.changes.
    const stillThere = await db.prepare('SELECT id FROM users WHERE id = ? LIMIT 1').bind(auth.userId).first<{ id: string }>()
    if (stillThere) {
      // The user row survived the batch, which can only mean a foreign key still blocks it (a
      // created_by this file did not null). Nothing is deleted from KV, because KV deletion runs
      // only after D1 confirms the data is gone.
      return c.json({ error: 'INTERNAL_ERROR', message: 'Account could not be deleted' }, 500)
    }

    // KV only after D1 has committed: data must never be gone from KV while still present in D1 (the
    // same ordering the project/secret delete paths use). A superseded blob with no D1 pointer is
    // unreachable; a best-effort failure here leaves an orphan for the housekeeping sweep, never a
    // live secret, so individual failures must not fail the request.
    for (let i = 0; i < kvKeys.length; i += KV_DELETE_CHUNK) {
      await Promise.all(kvKeys.slice(i, i + KV_DELETE_CHUNK).map(async (key) => {
        try {
          await c.env.SECRETS_KV.delete(key)
        } catch {
          // orphaned blob is unreachable (no D1 row / wrapped DEK); ignore
        }
      }))
    }

    clearRefreshCookie(c)
    return c.json({ data: { deleted: true, orgsErased: soleMemberOrgIds.length } })
  },
)
