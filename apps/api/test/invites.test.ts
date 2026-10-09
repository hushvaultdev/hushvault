// Invitations and member management (issue #82 Lane B, docs/plans/multi-org-and-invites.md).
//
// An invitation is a CREDENTIAL, so most of this file is refusals rather than happy paths: a
// revoked token, an expired one, a spent one, a token for org A in the hands of a member of org B,
// the wrong account signed in, an unverified address, two accepts of the same token at once, and an
// invitation to somebody who is already in. Each one is a way the feature could have let the wrong
// account into an organisation.
//
// The other half is `LAST_OWNER`, which is tested by racing two writes rather than by calling the
// endpoint twice: the interesting failure is not "it refuses when I ask nicely", it is "two admins
// demoting each other both pass a check that was read before either wrote".
import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedApiKey, seedUser, type Role, type TestEnv } from './helpers/env'
import { createPrefixedId } from '../src/lib/auth'
import { hashInviteToken } from '../src/lib/invites'
import { housekeepingTick } from '../src/lib/housekeeping'

type Sent = { from: string; to: string; subject: string; text: string; html: string }

function makeEnv(extra: Record<string, unknown> = {}) {
  const sent: Sent[] = []
  const env = createTestEnv({
    WEB_APP_URL: 'https://beta.hushvault.dev',
    MAIL_FROM: 'no-reply@hushvault.dev',
    EMAIL: { send: async (m: Sent) => { sent.push(m); return { messageId: 'm' } } },
    ...extra,
  })
  return { env, sent }
}

async function seedOrg(env: TestEnv, name = 'Second Org'): Promise<string> {
  const id = createPrefixedId('org')
  await env.DB.prepare('INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(-6).toLowerCase()}`, 'free', new Date().toISOString())
    .run()
  return id
}

async function addMembership(env: TestEnv, opts: { userId: string; orgId: string; role: Role; createdAt?: string }) {
  await env.DB.prepare('INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(createPrefixedId('mem'), opts.orgId, opts.userId, opts.role, opts.createdAt ?? new Date(Date.now() + 60_000).toISOString())
    .run()
}

/** An invitation row written straight into D1, for the states no endpoint can produce on demand. */
async function seedInvite(env: TestEnv, opts: {
  orgId: string
  email: string
  token: string
  role?: Role
  invitedBy?: string | null
  expiresAt?: string
  acceptedAt?: string | null
  acceptedBy?: string | null
  revokedAt?: string | null
}): Promise<string> {
  const id = createPrefixedId('inv')
  await env.DB.prepare(
    'INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at, accepted_at, accepted_by, revoked_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(
    id,
    opts.orgId,
    opts.email.toLowerCase(),
    opts.role ?? 'member',
    await hashInviteToken(opts.token),
    opts.invitedBy ?? null,
    new Date().toISOString(),
    opts.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString(),
    opts.acceptedAt ?? null,
    opts.acceptedBy ?? null,
    opts.revokedAt ?? null,
  ).run()
  return id
}

type Row = Record<string, unknown>

/**
 * The same env with ONE read doctored: a statement whose SQL starts with `sqlPrefix` returns
 * whatever `patch` says instead of what the table holds. Everything else goes to the real
 * database.
 *
 * This is how the two check-then-write windows in this feature are stood in. Both routes read the
 * state of an invitation and then write under a guard that re-checks it, and the interesting
 * question is what happens when those two disagree — which cannot be arranged by calling the
 * endpoint twice, because the window is inside one request. Doctoring the READ puts a test in that
 * window while leaving the WRITE to meet the real constraint.
 */
function withPatchedRead(
  env: TestEnv,
  sqlPrefix: string,
  patch: (row: Row | null, values: unknown[]) => Row | null,
): TestEnv {
  const real = env.DB
  const db = {
    prepare(sql: string) {
      const statement = real.prepare(sql)
      if (!sql.startsWith(sqlPrefix)) return statement
      return {
        bind: (...values: unknown[]) => {
          const bound = statement.bind(...(values as never[]))
          return {
            first: async () => patch(await bound.first<Row>(), values),
            all: () => bound.all(),
            run: () => bound.run(),
          }
        },
      }
    },
    batch: (statements: unknown[]) => real.batch(statements as never),
    sqlite: real.sqlite,
  }
  return { ...env, DB: db as unknown as TestEnv['DB'] }
}

/** The route's "is there already an open invitation?" pre-check answers no, whatever the table says. */
const withBlindDuplicateCheck = (env: TestEnv) =>
  withPatchedRead(env, 'SELECT id FROM org_invites WHERE org_id = ?', () => null)

/**
 * The accept route's state read says "open" — not accepted, not revoked, not expired — whatever the
 * table says. The batch below it reads the real row, so this is what puts a test in the window
 * between the two and leaves the three guards inside the write as the only things that can refuse.
 */
const withBlindInviteState = (env: TestEnv) =>
  withPatchedRead(env, 'SELECT i.id, i.org_id, i.email, i.role, i.accepted_at', (row) =>
    row === null ? null : { ...row, accepted_at: null, revoked_at: null, expires_at: '2999-01-01T00:00:00.000Z' })

/**
 * The member-write routes read the target's role, then write under a guard, then read the row back.
 * This under-reports `targetUserId`'s `owner` as a plain `member` for EXACTLY ONE of those reads —
 * the route's own pre-read — so the route is asked to demote or remove an owner that every check it
 * makes for itself says is fair game. The write's guards and the read-back are left alone, because
 * they are what has to catch it.
 *
 * `skip` is how many earlier matching reads to let through, and it is 1 when the actor IS the
 * target: `requireOrgRole` reads the same (org, user) pair first, and blinding that one would only
 * demote the ACTOR's authority and never reach the write at all.
 */
function withBlindTargetRole(env: TestEnv, targetUserId: string, skip = 0): TestEnv {
  let seen = 0
  let blinded = false
  return withPatchedRead(env, 'SELECT role FROM members WHERE org_id = ?', (row, values) => {
    if (row === null || blinded || !values.includes(targetUserId)) return row
    if (seen++ < skip) return row
    blinded = true
    return { ...row, role: 'member' }
  })
}

function tokenFromUrl(url: string): string {
  const m = /#token=([A-Za-z0-9_-]+)/.exec(url)
  if (!m) throw new Error(`no fragment token in ${url}`)
  return m[1] as string
}

async function auditFor(env: TestEnv, action: string) {
  const { results } = await env.DB.prepare('SELECT org_id, actor_id, actor_type, resource_type, resource_id FROM audit_log WHERE action = ? ORDER BY timestamp ASC')
    .bind(action).all()
  return results
}

/** The `metadata` column for an action's rows, parsed (issue #96). Raw string, not NULL-coalesced,
 * so a test can tell a stored `null` apart from an absent row. */
async function auditMeta(env: TestEnv, action: string) {
  const { results } = await env.DB.prepare('SELECT metadata FROM audit_log WHERE action = ? ORDER BY timestamp ASC')
    .bind(action).all<{ metadata: string | null }>()
  return results.map((r) => (r.metadata === null ? null : JSON.parse(r.metadata)))
}

async function members(env: TestEnv, orgId: string) {
  const { results } = await env.DB.prepare('SELECT user_id, role FROM members WHERE org_id = ? ORDER BY created_at ASC').bind(orgId).all()
  return results as { user_id: string; role: string }[]
}

const invite = (env: TestEnv, token: string, orgId: string, body: unknown) =>
  call(env, 'POST', `/api/orgs/${orgId}/invites`, { token, json: body })

const accept = (env: TestEnv, token: string, inviteToken: string) =>
  call(env, 'POST', '/api/invites/accept', { token, json: { token: inviteToken } })

// ── Creating an invitation ─────────────────────────────────────────────────────────────────────

describe('POST /api/orgs/:id/invites', () => {
  it('stores only the hash, mails a fragment link, and hands the token back exactly once', async () => {
    const { env, sent } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', email: 'admin@acme.test', emailVerified: true })
    await env.DB.prepare('UPDATE organisations SET name = ? WHERE id = ?').bind('Acme Ltd', admin.orgId).run()

    const res = await invite(env, admin.token, admin.orgId, { email: '  Ann.Smith@Example.TEST ', role: 'admin' })
    expect(res.status).toBe(201)

    // The shape apps/web/src/lib/orgs-api.ts normaliseInviteCreated reads.
    expect(res.body.data.invite).toMatchObject({
      orgId: admin.orgId,
      email: 'ann.smith@example.test', // trimmed and lower-cased: the index is per ADDRESS
      role: 'admin',
      invitedBy: admin.userId,
    })
    expect(res.body.data.invite.id).toMatch(/^inv_/)
    const token = tokenFromUrl(res.body.data.acceptUrl)

    // 7 days, within a minute.
    const ttl = new Date(res.body.data.invite.expiresAt).getTime() - new Date(res.body.data.invite.createdAt).getTime()
    expect(ttl).toBe(7 * 86_400_000)

    // Only the hash is stored. The raw token appears nowhere in the row.
    const row = await env.DB.prepare('SELECT token_hash, email FROM org_invites WHERE id = ?')
      .bind(res.body.data.invite.id).first<{ token_hash: string; email: string }>()
    expect(row!.token_hash).toBe(await hashInviteToken(token))
    expect(row!.token_hash).not.toBe(token)
    expect(JSON.stringify(row)).not.toContain(token)

    // The mail: fragment token, never a query string, and the address hint rides in the fragment too.
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ to: 'ann.smith@example.test', from: 'no-reply@hushvault.dev' })
    expect(sent[0]!.text).toContain('https://beta.hushvault.dev/invites/accept#token=')
    expect(sent[0]!.text).not.toMatch(/[?]token=/)
    expect(sent[0]!.text).toContain('Acme Ltd')
    expect(res.body.data.acceptUrl).toContain('&email=ann.smith%40example.test')

    expect(await auditFor(env, 'org.invite.create')).toEqual([
      { org_id: admin.orgId, actor_id: admin.userId, actor_type: 'user', resource_type: 'org_invite', resource_id: res.body.data.invite.id },
    ])
    // Issue #96: the invited role is in the trail, not only on the org_invites row the cron sweep
    // later collects. A non-secret role name — never the token or the address.
    expect(await auditMeta(env, 'org.invite.create')).toEqual([{ role: 'admin' }])
    expect(await auditFor(env, 'org.invite.sent')).toEqual([
      { org_id: admin.orgId, actor_id: null, actor_type: 'system', resource_type: 'org_invite', resource_id: res.body.data.invite.id },
    ])

    // And the listing never carries the token or its hash, in any spelling.
    const list = await call(env, 'GET', `/api/orgs/${admin.orgId}/invites`, { token: admin.token })
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toMatchObject({ email: 'ann.smith@example.test', role: 'admin' })
    const serialised = JSON.stringify(list.body)
    expect(serialised).not.toContain(token)
    expect(serialised).not.toContain(row!.token_hash)
    expect(serialised).not.toContain('token_hash')
  })

  it('refuses a second OPEN invitation to the same address, as a 409 and not a 500', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    expect((await invite(env, admin.token, admin.orgId, { email: 'ann@x.test' })).status).toBe(201)

    const again = await invite(env, admin.token, admin.orgId, { email: 'ANN@x.test' })
    expect(again.status).toBe(409)
    expect(again.body.error).toBe('CONFLICT')
    expect(again.body.message).toMatch(/already waiting/i)

    // Revoking frees the address (the index is partial), so the admin is not stuck.
    const open = await env.DB.prepare('SELECT id FROM org_invites WHERE org_id = ? LIMIT 1').bind(admin.orgId).first<{ id: string }>()
    expect((await call(env, 'DELETE', `/api/orgs/${admin.orgId}/invites/${open!.id}`, { token: admin.token })).status).toBe(200)
    expect((await invite(env, admin.token, admin.orgId, { email: 'ann@x.test' })).status).toBe(201)
  })

  it('maps the partial unique index\'s own violation to the same 409, not a 500', async () => {
    // The duplicate check in the route is a courtesy; `org_invites_open_idx` is the authority, and
    // the gap between the two is a real window a second request can land in. Blinding the check is
    // the only way to stand in that window from a test, and what it proves is that the constraint
    // firing is a refusal rather than an unhandled exception.
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    expect((await invite(env, admin.token, admin.orgId, { email: 'ann@x.test' })).status).toBe(201)

    const res = await invite(withBlindDuplicateCheck(env), admin.token, admin.orgId, { email: 'ann@x.test' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({
      error: 'CONFLICT',
      message: 'An invitation to that address is already waiting. Revoke it first to send a new one.',
    })
    // Nothing half-written: still one row, and no audit row claiming an invitation was created.
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM org_invites').first<{ n: number }>()).toEqual({ n: 1 })
    expect(await auditFor(env, 'org.invite.create')).toHaveLength(1)
  })

  it('two simultaneous invitations to one address leave exactly one open, and neither 500s', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const [a, b] = await Promise.all([
      invite(env, admin.token, admin.orgId, { email: 'race@x.test' }),
      invite(env, admin.token, admin.orgId, { email: 'race@x.test' }),
    ])
    const statuses = [a.status, b.status].sort()
    expect(statuses).toEqual([201, 409])
    expect([a, b].every((r) => r.status !== 500)).toBe(true)
    const { results } = await env.DB.prepare(
      'SELECT id FROM org_invites WHERE org_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL',
    ).bind(admin.orgId, 'race@x.test').all()
    expect(results).toHaveLength(1)
  })

  it('refuses an address that is already a member', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const existing = await seedUser(env, { role: 'member', orgId: admin.orgId, email: 'bob@x.test' })
    expect(existing.orgId).toBe(admin.orgId)

    const res = await invite(env, admin.token, admin.orgId, { email: 'BOB@X.TEST' })
    expect(res.status).toBe(409)
    expect(res.body).toEqual({ error: 'ALREADY_MEMBER', message: 'That address is already a member of this organisation' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM org_invites').first<{ n: number }>()).toEqual({ n: 0 })
  })

  it('only an owner can invite an owner, and below admin nobody can invite at all', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 'adm@x.test', emailVerified: true })
    const plain = await seedUser(env, { role: 'member', orgId: owner.orgId, email: 'mem@x.test', emailVerified: true })
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId, email: 'vie@x.test', emailVerified: true })

    const byAdmin = await invite(env, admin.token, owner.orgId, { email: 'o1@x.test', role: 'owner' })
    expect(byAdmin.status).toBe(403)
    expect(byAdmin.body.error).toBe('FORBIDDEN')
    expect((await invite(env, owner.token, owner.orgId, { email: 'o2@x.test', role: 'owner' })).status).toBe(201)
    expect((await invite(env, admin.token, owner.orgId, { email: 'a1@x.test', role: 'admin' })).status).toBe(201)

    for (const actor of [plain, viewer]) {
      const res = await invite(env, actor.token, owner.orgId, { email: `${actor.userId}@x.test` })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('FORBIDDEN')
    }
  })

  it('rejects an API key: a deployment credential must not be able to invite an owner', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const key = await seedApiKey(env, owner.userId, owner.orgId)
    const res = await invite(env, key.rawKey, owner.orgId, { email: 'x@x.test', role: 'owner' })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('FORBIDDEN')
    expect((await call(env, 'GET', `/api/orgs/${owner.orgId}/invites`, { token: key.rawKey })).status).toBe(403)
  })

  it('validates the address with the house validation shape', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const res = await invite(env, admin.token, admin.orgId, { email: 'not-an-address', role: 'member' })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('VALIDATION_ERROR')
    const badRole = await invite(env, admin.token, admin.orgId, { email: 'a@x.test', role: 'superuser' })
    expect(badRole.status).toBe(400)
    expect(badRole.body.error).toBe('VALIDATION_ERROR')
  })

  it('still creates the invitation when mail cannot be sent, and says nothing about why', async () => {
    const { env } = makeEnv({ EMAIL: { send: async () => { throw Object.assign(new Error('x'), { code: 'E_X' }) } } })
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const res = await invite(env, admin.token, admin.orgId, { email: 'ann@x.test' })
    expect(res.status).toBe(201)
    // The handed-back link is the only path left, which is the production situation today (#75).
    expect(res.body.data.acceptUrl).toContain('#token=')
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM org_invites').first<{ n: number }>()).toEqual({ n: 1 })
  })

  it('spends the invite budget bucket, not verification\'s', async () => {
    const { env, sent } = makeEnv({ EMAIL_DAILY_BUDGET: '1' })
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    expect((await invite(env, admin.token, admin.orgId, { email: 'one@x.test' })).status).toBe(201)
    expect((await invite(env, admin.token, admin.orgId, { email: 'two@x.test' })).status).toBe(201)
    expect(sent).toHaveLength(1) // the second send was skipped: budget 1

    // Verification mail still works, which is the whole point of a separate bucket.
    const reg = await call(env, 'POST', '/api/auth/register', {
      json: { email: 'new@x.test', password: 'correct horse battery staple', organisationName: 'New Org' },
    })
    expect(reg.status).toBe(201)
    expect(sent.filter((m) => m.subject.includes('Confirm'))).toHaveLength(1)
  })
})

// ── What a stranger can learn ─────────────────────────────────────────────────────────────────

describe('an organisation the caller is not in', () => {
  it('answers identically for a real organisation and one that does not exist', async () => {
    const { env } = makeEnv()
    const outsider = await seedUser(env, { role: 'owner', emailVerified: true })
    const other = await seedOrg(env, 'Private Co')
    const nonexistent = createPrefixedId('org')

    for (const path of ['/members', '/invites']) {
      const real = await call(env, 'GET', `/api/orgs/${other}${path}`, { token: outsider.token })
      const fake = await call(env, 'GET', `/api/orgs/${nonexistent}${path}`, { token: outsider.token })
      expect(real.status).toBe(404)
      expect(real.body).toEqual({ error: 'NOT_FOUND', message: 'Organisation not found' })
      expect(fake.body).toEqual(real.body)
      expect(fake.status).toBe(real.status)
      // Nothing about the organisation leaks: not its name, not its plan, not that it exists.
      expect(JSON.stringify(real.body)).not.toContain('Private')
    }

    const created = await invite(env, outsider.token, other, { email: 'x@x.test' })
    expect(created.status).toBe(404)
    expect(created.body).toEqual({ error: 'NOT_FOUND', message: 'Organisation not found' })
    const patched = await call(env, 'PATCH', `/api/orgs/${other}/members/${outsider.userId}`, { token: outsider.token, json: { role: 'owner' } })
    expect(patched.body).toEqual(created.body)
  })

  it('but a credential that NAMES the organisation gets MEMBERSHIP_REVOKED, which the dashboard needs', async () => {
    const { env } = makeEnv()
    const user = await seedUser(env, { role: 'owner', emailVerified: true })
    // The access token still says org A; the membership is gone (removed by another admin).
    await env.DB.prepare('DELETE FROM members WHERE org_id = ? AND user_id = ?').bind(user.orgId, user.userId).run()
    const res = await call(env, 'GET', `/api/orgs/${user.orgId}/members`, { token: user.token })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'MEMBERSHIP_REVOKED', message: 'Your membership of this organisation has ended' })
  })
})

// ── Revoking ──────────────────────────────────────────────────────────────────────────────────

describe('DELETE /api/orgs/:id/invites/:inviteId', () => {
  it('revokes, audits once, and the token then refuses with its own code', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    const created = await invite(env, admin.token, admin.orgId, { email: guest.email })
    const inviteId = created.body.data.invite.id
    const token = tokenFromUrl(created.body.data.acceptUrl)

    const res = await call(env, 'DELETE', `/api/orgs/${admin.orgId}/invites/${inviteId}`, { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(inviteId)

    const row = await env.DB.prepare('SELECT revoked_by FROM org_invites WHERE id = ?').bind(inviteId).first()
    expect(row).toEqual({ revoked_by: admin.userId })

    const used = await accept(env, guest.token, token)
    expect(used.status).toBe(403)
    expect(used.body).toEqual({ error: 'INVITE_REVOKED', message: 'This invitation was revoked. Ask an admin to send a new one.' })
    expect(await members(env, admin.orgId)).toHaveLength(1)

    // Idempotent, and a second DELETE does not file a second audit row.
    expect((await call(env, 'DELETE', `/api/orgs/${admin.orgId}/invites/${inviteId}`, { token: admin.token })).status).toBe(200)
    expect(await auditFor(env, 'org.invite.revoke')).toEqual([
      { org_id: admin.orgId, actor_id: admin.userId, actor_type: 'user', resource_type: 'org_invite', resource_id: inviteId },
    ])
  })

  it('cannot revoke another organisation\'s invitation, and says "no such invitation"', async () => {
    const { env } = makeEnv()
    const a = await seedUser(env, { role: 'owner', emailVerified: true })
    const b = await seedUser(env, { role: 'owner', email: 'b@x.test', emailVerified: true })
    const theirs = await seedInvite(env, { orgId: b.orgId, email: 'ann@x.test', token: 'tok-for-b-'.padEnd(40, 'x') })

    const res = await call(env, 'DELETE', `/api/orgs/${a.orgId}/invites/${theirs}`, { token: a.token })
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'NOT_FOUND', message: 'Invitation not found' })
    expect(await env.DB.prepare('SELECT revoked_at FROM org_invites WHERE id = ?').bind(theirs).first()).toEqual({ revoked_at: null })
  })

  it('refuses to revoke an invitation that was already accepted', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const id = await seedInvite(env, {
      orgId: admin.orgId, email: 'ann@x.test', token: 'already-accepted-'.padEnd(40, 'x'),
      acceptedAt: new Date().toISOString(), acceptedBy: admin.userId,
    })
    const res = await call(env, 'DELETE', `/api/orgs/${admin.orgId}/invites/${id}`, { token: admin.token })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('CONFLICT')
    expect(res.body.message).toMatch(/already been accepted/i)
  })

  it('lists only open invitations', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    await seedInvite(env, { orgId: admin.orgId, email: 'open@x.test', token: 'open-'.padEnd(40, 'x') })
    await seedInvite(env, { orgId: admin.orgId, email: 'gone@x.test', token: 'revoked-'.padEnd(40, 'x'), revokedAt: new Date().toISOString() })
    await seedInvite(env, { orgId: admin.orgId, email: 'old@x.test', token: 'expired-'.padEnd(40, 'x'), expiresAt: new Date(Date.now() - 1000).toISOString() })
    await seedInvite(env, { orgId: admin.orgId, email: 'in@x.test', token: 'accepted-'.padEnd(40, 'x'), acceptedAt: new Date().toISOString() })

    const res = await call(env, 'GET', `/api/orgs/${admin.orgId}/invites`, { token: admin.token })
    expect(res.status).toBe(200)
    expect(res.body.data.map((r: { email: string }) => r.email)).toEqual(['open@x.test'])
    expect(res.body.total).toBe(1)
  })
})

// ── Accepting ─────────────────────────────────────────────────────────────────────────────────

describe('POST /api/invites/accept', () => {
  it('joins the organisation at the invited role without moving the caller\'s session', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    await env.DB.prepare('UPDATE organisations SET name = ? WHERE id = ?').bind('Acme Ltd', admin.orgId).run()
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })

    const created = await invite(env, admin.token, admin.orgId, { email: 'GUEST@x.test', role: 'admin' })
    const res = await accept(env, guest.token, tokenFromUrl(created.body.data.acceptUrl))
    expect(res.status).toBe(201)
    // The shape normaliseAccepted reads, so the dashboard can offer "Open Acme Ltd".
    expect(res.body.data).toEqual({ orgId: admin.orgId, orgName: 'Acme Ltd', role: 'admin', userId: guest.userId })

    expect(await members(env, admin.orgId)).toEqual([
      { user_id: admin.userId, role: 'owner' },
      { user_id: guest.userId, role: 'admin' },
    ])
    const row = await env.DB.prepare('SELECT accepted_by FROM org_invites WHERE id = ?').bind(created.body.data.invite.id).first()
    expect(row).toEqual({ accepted_by: guest.userId })

    expect(await auditFor(env, 'org.invite.accept')).toEqual([
      { org_id: admin.orgId, actor_id: guest.userId, actor_type: 'user', resource_type: 'org_invite', resource_id: created.body.data.invite.id },
    ])
    // Issue #96: the role actually granted. A non-secret role name.
    expect(await auditMeta(env, 'org.invite.accept')).toEqual([{ role: 'admin' }])

    // The session is untouched: the guest's token still acts in their own organisation, and
    // nothing in the response is a new credential.
    expect(JSON.stringify(res.body)).not.toMatch(/hvr_|eyJ/)
    const orgs = await call(env, 'GET', '/api/orgs', { token: guest.token })
    expect(orgs.body.currentOrgId).toBe(guest.orgId)
    expect(orgs.body.data.map((o: { id: string; current: boolean }) => [o.id, o.current]).sort())
      .toEqual([[admin.orgId, false], [guest.orgId, true]].sort())
  })

  it('an unknown token is 404 and writes nothing', async () => {
    const { env } = makeEnv()
    const user = await seedUser(env, { role: 'owner', emailVerified: true })
    const res = await accept(env, user.token, 'x'.repeat(43))
    expect(res.status).toBe(404)
    expect(res.body).toEqual({ error: 'INVITE_NOT_FOUND', message: 'This invitation link is not valid.' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>()).toEqual({ n: 1 })
  })

  it('an expired token is refused with its own code and creates no membership', async () => {
    const { env } = makeEnv()
    const org = await seedOrg(env, 'Target')
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    const token = 'expired-token-'.padEnd(43, 'z')
    await seedInvite(env, { orgId: org, email: guest.email, token, expiresAt: new Date(Date.now() - 1000).toISOString() })

    const res = await accept(env, guest.token, token)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'INVITE_EXPIRED', message: 'This invitation has expired. Ask an admin to send a new one.' })
    expect(await members(env, org)).toHaveLength(0)

    // Expiry is enforced by the write as well, not only by the read: `expires_at > ?` is in both
    // statements of the batch, so a doctored read cannot resurrect a dead invitation.
    const blinded = await accept(withBlindInviteState(env), guest.token, token)
    expect(blinded.status).toBe(403)
    expect(blinded.body.error).toBe('INVITE_EXPIRED')
    expect(await members(env, org)).toHaveLength(0)
  })

  it('a token already used is refused, and the first membership is not duplicated', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    const created = await invite(env, admin.token, admin.orgId, { email: guest.email })
    const token = tokenFromUrl(created.body.data.acceptUrl)

    expect((await accept(env, guest.token, token)).status).toBe(201)
    const again = await accept(env, guest.token, token)
    expect(again.status).toBe(403)
    expect(again.body).toEqual({ error: 'INVITE_ACCEPTED', message: 'This invitation has already been used.' })
    expect(await members(env, admin.orgId)).toHaveLength(2)
  })

  it('the WRONG ACCOUNT is told only the address, never anything about the organisation', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    await env.DB.prepare('UPDATE organisations SET name = ?, plan = ? WHERE id = ?').bind('Secret Project', 'free', admin.orgId).run()
    // A member of org B, holding a token for org A that was forwarded to them.
    const stranger = await seedUser(env, { role: 'owner', email: 'stranger@x.test', emailVerified: true })
    const created = await invite(env, admin.token, admin.orgId, { email: 'intended@x.test', role: 'owner' })
    const token = tokenFromUrl(created.body.data.acceptUrl)

    const res = await accept(env, stranger.token, token)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('INVITE_EMAIL_MISMATCH')
    // Read by the dashboard as ApiError.details.invitedEmail — `details` is the whole error body.
    expect(res.body.invitedEmail).toBe('intended@x.test')

    const serialised = JSON.stringify(res.body)
    expect(serialised).not.toContain('Secret Project')
    expect(serialised).not.toContain(admin.orgId)
    expect(serialised).not.toContain(admin.userId)
    expect(serialised).not.toContain('owner')
    expect(serialised).not.toContain(token)

    // Nothing happened: no membership, and the invitation is still open for its real recipient.
    expect(await members(env, admin.orgId)).toHaveLength(1)
    expect(await env.DB.prepare('SELECT accepted_at FROM org_invites WHERE id = ?').bind(created.body.data.invite.id).first())
      .toEqual({ accepted_at: null })
  })

  it('an UNVERIFIED address cannot accept, so a typed-in address is not a way in', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    // Signed up on the invited address but never proved it.
    const impostor = await seedUser(env, { role: 'owner', email: 'cfo@acme.test', emailVerified: false })
    const created = await invite(env, admin.token, admin.orgId, { email: 'cfo@acme.test', role: 'owner' })

    const res = await accept(env, impostor.token, tokenFromUrl(created.body.data.acceptUrl))
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('EMAIL_NOT_VERIFIED')
    expect(await members(env, admin.orgId)).toHaveLength(1)

    // Verifying the address is all that was missing.
    await env.DB.prepare('UPDATE users SET email_verified = 1 WHERE id = ?').bind(impostor.userId).run()
    expect((await accept(env, impostor.token, tokenFromUrl(created.body.data.acceptUrl))).status).toBe(201)
    expect(await members(env, admin.orgId)).toHaveLength(2)
  })

  it('two accepts of the SAME token at once create exactly one membership', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    const created = await invite(env, admin.token, admin.orgId, { email: guest.email, role: 'member' })
    const token = tokenFromUrl(created.body.data.acceptUrl)

    const [a, b] = await Promise.all([accept(env, guest.token, token), accept(env, guest.token, token)])
    // Whatever the interleaving, neither is a 500 and neither reports a role it did not get.
    for (const res of [a, b]) {
      expect([201, 403]).toContain(res.status)
      if (res.status === 201) expect(res.body.data.role).toBe('member')
    }
    // The property that matters, read back from the database rather than from meta.changes.
    expect(await members(env, admin.orgId)).toEqual([
      { user_id: admin.userId, role: 'owner' },
      { user_id: guest.userId, role: 'member' },
    ])
    const { results } = await env.DB.prepare('SELECT user_id FROM members WHERE org_id = ? AND user_id = ?')
      .bind(admin.orgId, guest.userId).all()
    expect(results).toHaveLength(1)
  })

  it('an invitation to somebody who joined in the meantime adds no second row and does not re-grade them', async () => {
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    // An invitation to owner, created while the address was still outside the organisation…
    const token = 'joined-meanwhile-'.padEnd(43, 'q')
    await seedInvite(env, { orgId: admin.orgId, email: guest.email, token, role: 'owner', invitedBy: admin.userId })
    // …and then they were added as a viewer by hand.
    await addMembership(env, { userId: guest.userId, orgId: admin.orgId, role: 'viewer' })

    const res = await accept(env, guest.token, token)
    expect(res.status).toBe(201)
    // Their EXISTING role, not the invitation's: an invitation must not be a way to re-grade
    // somebody's access behind a role change endpoint's back.
    expect(res.body.data.role).toBe('viewer')
    expect(await members(env, admin.orgId)).toEqual([
      { user_id: admin.userId, role: 'owner' },
      { user_id: guest.userId, role: 'viewer' },
    ])
    // The token is spent either way, so it cannot be held back and replayed later.
    expect((await accept(env, guest.token, token)).body.error).toBe('INVITE_ACCEPTED')
  })

  it('a spent token cannot be replayed to re-join after leaving', async () => {
    // The case the single-use guard is really for. A member who accepted and then left is no longer
    // in the organisation, so the "already a member" guard does not apply to them any more — only
    // the invitation's own state stops them walking back in on the link that is still in their
    // mailbox. Nobody has to revoke anything for that to hold.
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    const created = await invite(env, admin.token, admin.orgId, { email: guest.email })
    const token = tokenFromUrl(created.body.data.acceptUrl)

    expect((await accept(env, guest.token, token)).status).toBe(201)
    expect((await call(env, 'DELETE', `/api/orgs/${admin.orgId}/members/${guest.userId}`, { token: guest.token })).status).toBe(200)
    expect(await members(env, admin.orgId)).toHaveLength(1)

    const replay = await accept(env, guest.token, token)
    expect(replay.status).toBe(403)
    expect(replay.body.error).toBe('INVITE_ACCEPTED')
    expect(await members(env, admin.orgId)).toHaveLength(1)

    // And it still does not work when the route's state read is doctored to say the invitation is
    // open: the `accepted_at IS NULL` guard inside the batch is what refuses it then, and the
    // refusal is classified from the row as it really is.
    const blinded = await accept(withBlindInviteState(env), guest.token, token)
    expect(blinded.status).toBe(403)
    expect(blinded.body.error).toBe('INVITE_ACCEPTED')
    expect(await members(env, admin.orgId)).toHaveLength(1)
    expect(await auditFor(env, 'org.invite.accept')).toHaveLength(1)
  })

  it('an invitation revoked between the check and the write is still refused, by the write', async () => {
    // The guards live in the two statements of the batch, not in the read above them, and this is
    // the test that says so: the state read is made to report "open" for a row that is revoked,
    // so the only thing left that can refuse is the `revoked_at IS NULL` inside the INSERT ... SELECT
    // and the UPDATE. The refusal is then classified from the row as it really is.
    const { env } = makeEnv()
    const admin = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'owner', email: 'guest@x.test', emailVerified: true })
    const token = 'revoked-under-us-'.padEnd(43, 'w')
    await seedInvite(env, { orgId: admin.orgId, email: guest.email, token, revokedAt: new Date().toISOString() })

    const res = await accept(withBlindInviteState(env), guest.token, token)
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'INVITE_REVOKED', message: 'This invitation was revoked. Ask an admin to send a new one.' })
    expect(await members(env, admin.orgId)).toHaveLength(1)
    expect(await auditFor(env, 'org.invite.accept')).toHaveLength(0)
  })

  it('a member of org B can accept an invitation to org A, and org B is untouched', async () => {
    const { env } = makeEnv()
    const a = await seedUser(env, { role: 'owner', emailVerified: true })
    const guest = await seedUser(env, { role: 'admin', email: 'guest@x.test', emailVerified: true })
    const created = await invite(env, a.token, a.orgId, { email: guest.email, role: 'viewer' })

    expect((await accept(env, guest.token, tokenFromUrl(created.body.data.acceptUrl))).status).toBe(201)
    expect(await members(env, a.orgId)).toContainEqual({ user_id: guest.userId, role: 'viewer' })
    expect(await members(env, guest.orgId)).toEqual([{ user_id: guest.userId, role: 'admin' }])
  })

  it('refuses an API key and a token outside the plausible length range', async () => {
    const { env } = makeEnv()
    const user = await seedUser(env, { role: 'owner', emailVerified: true })
    const key = await seedApiKey(env, user.userId, user.orgId)
    expect((await accept(env, key.rawKey, 'x'.repeat(43))).status).toBe(403)
    const short = await accept(env, user.token, 'short')
    expect(short.status).toBe(400)
    expect(short.body.error).toBe('VALIDATION_ERROR')
  })
})

// ── Members ───────────────────────────────────────────────────────────────────────────────────

describe('GET /api/orgs/:id/members', () => {
  it('is readable by every member, down to viewer, in the shape the dashboard parses', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', email: 'own@x.test', emailVerified: true })
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId, email: 'vie@x.test', emailVerified: true })

    for (const actor of [owner, viewer]) {
      const res = await call(env, 'GET', `/api/orgs/${owner.orgId}/members`, { token: actor.token })
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual([
        { user_id: owner.userId, email: 'own@x.test', role: 'owner', joined_at: expect.any(String) },
        { user_id: viewer.userId, email: 'vie@x.test', role: 'viewer', joined_at: expect.any(String) },
      ])
    }
  })
})

describe('PATCH /api/orgs/:id/members/:userId', () => {
  it('changes a role, audits it against the organisation, and takes effect at once', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const target = await seedUser(env, { role: 'viewer', orgId: owner.orgId, email: 't@x.test', emailVerified: true })

    const res = await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${target.userId}`, { token: owner.token, json: { role: 'admin' } })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ userId: target.userId, role: 'admin' })
    expect(await members(env, owner.orgId)).toContainEqual({ user_id: target.userId, role: 'admin' })
    expect(await auditFor(env, 'org.member.role_change')).toEqual([
      { org_id: owner.orgId, actor_id: owner.userId, actor_type: 'user', resource_type: 'member', resource_id: target.userId },
    ])
    // Issue #96: the row records what the role changed TO, not only that it changed.
    expect(await auditMeta(env, 'org.member.role_change')).toEqual([{ from: 'viewer', to: 'admin' }])

    // A no-op change writes nothing and audits nothing.
    expect((await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${target.userId}`, { token: owner.token, json: { role: 'admin' } })).status).toBe(200)
    expect(await auditFor(env, 'org.member.role_change')).toHaveLength(1)
  })

  it('records a non-secret {from,to} of role names only, and nothing from the request body', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const target = await seedUser(env, { role: 'member', orgId: owner.orgId, email: 't2@x.test', emailVerified: true })

    expect((await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${target.userId}`, { token: owner.token, json: { role: 'admin' } })).status).toBe(200)
    const [meta] = await auditMeta(env, 'org.member.role_change')
    // The whole object: two keys, both role names from the fixed vocabulary — a bounded, non-secret
    // shape (.claude/rules/audit-log.md). No email, id, token or other request-derived field leaks in.
    expect(meta).toEqual({ from: 'member', to: 'admin' })
    expect(Object.keys(meta).sort()).toEqual(['from', 'to'])
    for (const v of Object.values(meta)) expect(['owner', 'admin', 'member', 'viewer']).toContain(v)
  })

  it('an admin can neither grant the owner role nor change an owner\'s', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 'adm@x.test', emailVerified: true })
    const target = await seedUser(env, { role: 'member', orgId: owner.orgId, email: 't@x.test', emailVerified: true })

    const promote = await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${target.userId}`, { token: admin.token, json: { role: 'owner' } })
    expect(promote.status).toBe(403)
    expect(promote.body.error).toBe('FORBIDDEN')
    const demoteOwner = await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${owner.userId}`, { token: admin.token, json: { role: 'viewer' } })
    expect(demoteOwner.status).toBe(403)
    expect(await members(env, owner.orgId)).toContainEqual({ user_id: owner.userId, role: 'owner' })
  })

  it('an owner promoted while the request was in flight is still out of an admin\'s reach', async () => {
    // The owner fence is appended to the UPDATE and the DELETE, not only checked in the read above
    // them, so an admin whose read said "member" cannot land a write on an owner. Here the read is
    // made to say exactly that.
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const second = await seedUser(env, { role: 'owner', orgId: owner.orgId, email: 'o2@x.test', emailVerified: true })
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 'adm@x.test', emailVerified: true })

    // Unblinded, the read refuses it. That is the ordinary path and it is covered above; it is here
    // only so the blinded calls below are known to differ in the read and nothing else.
    const direct = await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${second.userId}`, {
      token: admin.token, json: { role: 'viewer' },
    })
    expect(direct.status).toBe(403)

    // Blinded, the route gets past `mayAssign` with a role of `member`. There are two owners, so
    // the last-owner guard would not stop the demotion either: without the fence on the UPDATE this
    // returns 200 and `second` is demoted by an admin.
    const patched = await call(withBlindTargetRole(env, second.userId), 'PATCH', `/api/orgs/${owner.orgId}/members/${second.userId}`, {
      token: admin.token, json: { role: 'viewer' },
    })
    expect(patched.status).toBe(403)
    expect(patched.body).toEqual({ error: 'FORBIDDEN', message: 'Only an owner can grant or change the owner role' })
    expect(await members(env, owner.orgId)).toContainEqual({ user_id: second.userId, role: 'owner' })

    const removed = await call(withBlindTargetRole(env, second.userId), 'DELETE', `/api/orgs/${owner.orgId}/members/${second.userId}`, {
      token: admin.token,
    })
    expect(removed.status).toBe(403)
    expect(removed.body.error).toBe('FORBIDDEN')
    expect(await members(env, owner.orgId)).toContainEqual({ user_id: second.userId, role: 'owner' })
  })

  it('404 for somebody who is not a member of this organisation', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const elsewhere = await seedUser(env, { role: 'owner', email: 'e@x.test', emailVerified: true })
    for (const id of [elsewhere.userId, 'usr_nope']) {
      const res = await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${id}`, { token: owner.token, json: { role: 'admin' } })
      expect(res.status).toBe(404)
      expect(res.body.error).toBe('NOT_FOUND')
    }
  })

  it('LAST_OWNER: the only owner cannot be demoted, and can be once there is another', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const second = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 's@x.test', emailVerified: true })

    const refused = await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${owner.userId}`, { token: owner.token, json: { role: 'admin' } })
    expect(refused.status).toBe(409)
    expect(refused.body).toEqual({ error: 'LAST_OWNER', message: 'An organisation must keep an owner. Make someone else an owner first.' })
    expect(await members(env, owner.orgId)).toContainEqual({ user_id: owner.userId, role: 'owner' })
    expect(await auditFor(env, 'org.member.role_change')).toHaveLength(0)

    expect((await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${second.userId}`, { token: owner.token, json: { role: 'owner' } })).status).toBe(200)
    expect((await call(env, 'PATCH', `/api/orgs/${owner.orgId}/members/${owner.userId}`, { token: owner.token, json: { role: 'admin' } })).status).toBe(200)
  })

  it('RACE: two owners demoting each other at the same moment cannot leave zero owners', async () => {
    const { env } = makeEnv()
    const a = await seedUser(env, { role: 'owner', email: 'a@x.test', emailVerified: true })
    const b = await seedUser(env, { role: 'owner', orgId: a.orgId, email: 'b@x.test', emailVerified: true })

    const [first, second] = await Promise.all([
      call(env, 'PATCH', `/api/orgs/${a.orgId}/members/${b.userId}`, { token: a.token, json: { role: 'admin' } }),
      call(env, 'PATCH', `/api/orgs/${a.orgId}/members/${a.userId}`, { token: b.token, json: { role: 'admin' } }),
    ])
    // Exactly one wins. The loser is refused by one of two independent guards, depending on how
    // the two interleave: either it is no longer an owner by the time its role is re-read (403 —
    // the demotion took effect at once, which is why the role is read per request and not taken
    // from the token), or it is still an owner and the guard inside its own UPDATE refuses it
    // (409 LAST_OWNER). Both are enforced against the database, neither against a count read
    // earlier, and the invariant below holds for either.
    expect([first.status, second.status].sort((x, y) => x - y)[0]).toBe(200)
    expect([403, 409]).toContain([first.status, second.status].sort((x, y) => y - x)[0])
    expect((await members(env, a.orgId)).filter((m) => m.role === 'owner')).toHaveLength(1)
  })

  it('the guard is evaluated by the UPDATE, against the row, not against what the route read', async () => {
    // The race above shows the invariant holds; this shows WHY, deterministically and in one
    // request. The route's read of the target's role is doctored to say `member`, so every check
    // the route makes for itself passes — the only thing left is the correlated subquery inside the
    // UPDATE, which sees the real `owner` row and that there is no other owner. Were the last-owner
    // condition a count read before the write instead, this would return 200 and empty the
    // organisation of owners.
    const { env } = makeEnv()
    const a = await seedUser(env, { role: 'owner', email: 'a@x.test', emailVerified: true })

    const res = await call(withBlindTargetRole(env, a.userId, 1), 'PATCH', `/api/orgs/${a.orgId}/members/${a.userId}`, {
      token: a.token, json: { role: 'viewer' },
    })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('LAST_OWNER')
    expect(await members(env, a.orgId)).toEqual([{ user_id: a.userId, role: 'owner' }])
    expect(await auditFor(env, 'org.member.role_change')).toHaveLength(0)

    // Same for removal.
    const removed = await call(withBlindTargetRole(env, a.userId, 1), 'DELETE', `/api/orgs/${a.orgId}/members/${a.userId}`, { token: a.token })
    expect(removed.status).toBe(409)
    expect(removed.body.error).toBe('LAST_OWNER')
    expect(await members(env, a.orgId)).toHaveLength(1)
  })
})

describe('DELETE /api/orgs/:id/members/:userId', () => {
  it('removes the member and kills that organisation\'s credentials for them in the same batch', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const other = await seedOrg(env, 'Their Other Org')
    const target = await seedUser(env, { role: 'member', orgId: owner.orgId, email: 't@x.test', emailVerified: true })
    await addMembership(env, { userId: target.userId, orgId: other, role: 'owner' })

    const hereKey = await seedApiKey(env, target.userId, owner.orgId)
    const elsewhereKey = await seedApiKey(env, target.userId, other)
    await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, family_started_at, org_id) VALUES (?, ?, ?, ?, 1, 9999999999, 1, ?)')
      .bind('rt_here', target.userId, 'f1', 'hash-here', owner.orgId).run()
    await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, family_started_at, org_id) VALUES (?, ?, ?, ?, 1, 9999999999, 1, ?)')
      .bind('rt_there', target.userId, 'f2', 'hash-there', other).run()

    const res = await call(env, 'DELETE', `/api/orgs/${owner.orgId}/members/${target.userId}`, { token: owner.token })
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ userId: target.userId, removed: true })
    expect(await members(env, owner.orgId)).toEqual([{ user_id: owner.userId, role: 'owner' }])

    // This organisation's credentials are gone; the other organisation's are untouched.
    expect(await env.DB.prepare('SELECT revoked_reason FROM api_keys WHERE id = ?').bind(hereKey.id).first())
      .toEqual({ revoked_reason: 'membership_removed' })
    expect(await env.DB.prepare('SELECT revoked_reason FROM api_keys WHERE id = ?').bind(elsewhereKey.id).first())
      .toEqual({ revoked_reason: null })
    expect(await env.DB.prepare("SELECT id FROM refresh_tokens WHERE id = 'rt_here'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT id FROM refresh_tokens WHERE id = 'rt_there'").first()).toEqual({ id: 'rt_there' })

    // The key really is dead, and the other one still works.
    expect((await call(env, 'GET', '/api/projects', { token: hereKey.rawKey })).status).toBe(401)
    expect((await call(env, 'GET', '/api/projects', { token: elsewhereKey.rawKey })).status).toBe(200)

    expect(await auditFor(env, 'org.member.remove')).toEqual([
      { org_id: owner.orgId, actor_id: owner.userId, actor_type: 'user', resource_type: 'member', resource_id: target.userId },
    ])
    // Issue #96: the role the removed member held. A non-secret role name.
    expect(await auditMeta(env, 'org.member.remove')).toEqual([{ role: 'member' }])
  })

  it('a member may leave on their own, whatever their role', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId, email: 'v@x.test', emailVerified: true })

    const res = await call(env, 'DELETE', `/api/orgs/${owner.orgId}/members/${viewer.userId}`, { token: viewer.token })
    expect(res.status).toBe(200)
    expect(await members(env, owner.orgId)).toEqual([{ user_id: owner.userId, role: 'owner' }])
    expect(await auditFor(env, 'org.member.leave')).toHaveLength(1)
    // Issue #96: the role held when leaving. A non-secret role name.
    expect(await auditMeta(env, 'org.member.leave')).toEqual([{ role: 'viewer' }])
  })

  it('but not somebody else, and an admin may not remove an owner', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 'adm@x.test', emailVerified: true })
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId, email: 'v@x.test', emailVerified: true })

    const byViewer = await call(env, 'DELETE', `/api/orgs/${owner.orgId}/members/${admin.userId}`, { token: viewer.token })
    expect(byViewer.status).toBe(403)
    const ownerByAdmin = await call(env, 'DELETE', `/api/orgs/${owner.orgId}/members/${owner.userId}`, { token: admin.token })
    expect(ownerByAdmin.status).toBe(403)
    expect(await members(env, owner.orgId)).toHaveLength(3)
  })

  it('LAST_OWNER on removal leaves the credentials alone too', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const key = await seedApiKey(env, owner.userId, owner.orgId)
    await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, family_started_at, org_id) VALUES (?, ?, ?, ?, 1, 9999999999, 1, ?)')
      .bind('rt_1', owner.userId, 'f1', 'hash-1', owner.orgId).run()

    const res = await call(env, 'DELETE', `/api/orgs/${owner.orgId}/members/${owner.userId}`, { token: owner.token })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('LAST_OWNER')
    expect(await members(env, owner.orgId)).toHaveLength(1)
    // The refused delete must not have taken their session and keys with it: all three statements
    // are in one batch, and the two credential statements are conditional on the membership
    // actually having gone.
    expect(await env.DB.prepare("SELECT id FROM refresh_tokens WHERE id = 'rt_1'").first()).toEqual({ id: 'rt_1' })
    expect(await env.DB.prepare('SELECT revoked_at FROM api_keys WHERE id = ?').bind(key.id).first()).toEqual({ revoked_at: null })
    expect((await call(env, 'GET', '/api/projects', { token: key.rawKey })).status).toBe(200)
    expect(await auditFor(env, 'org.member.leave')).toHaveLength(0)
  })

  it('RACE: two owners leaving at the same moment cannot empty the organisation', async () => {
    const { env } = makeEnv()
    const a = await seedUser(env, { role: 'owner', email: 'a@x.test', emailVerified: true })
    const b = await seedUser(env, { role: 'owner', orgId: a.orgId, email: 'b@x.test', emailVerified: true })

    const [first, second] = await Promise.all([
      call(env, 'DELETE', `/api/orgs/${a.orgId}/members/${a.userId}`, { token: a.token }),
      call(env, 'DELETE', `/api/orgs/${a.orgId}/members/${b.userId}`, { token: b.token }),
    ])
    expect([first.status, second.status].sort()).toEqual([200, 409])
    expect((await members(env, a.orgId)).filter((m) => m.role === 'owner')).toHaveLength(1)
  })

  it('an admin may remove an admin, and removing frees the address to be invited again', async () => {
    const { env } = makeEnv()
    const owner = await seedUser(env, { role: 'owner', emailVerified: true })
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 'adm@x.test', emailVerified: true })
    const peer = await seedUser(env, { role: 'admin', orgId: owner.orgId, email: 'peer@x.test', emailVerified: true })

    expect((await call(env, 'DELETE', `/api/orgs/${owner.orgId}/members/${peer.userId}`, { token: admin.token })).status).toBe(200)
    // Not a member any more, so inviting them back is allowed rather than ALREADY_MEMBER.
    expect((await invite(env, owner.token, owner.orgId, { email: 'peer@x.test' })).status).toBe(201)
  })
})

// ── Housekeeping ──────────────────────────────────────────────────────────────────────────────

describe('the cron sweep collects closed invitations', () => {
  it('deletes expired and revoked rows, keeps open ones, and is bounded per tick', async () => {
    const env = createTestEnv()
    const org = await seedOrg(env, 'Sweepy')
    const open = await seedInvite(env, { orgId: org, email: 'open@x.test', token: 'open-'.padEnd(43, 'o') })
    const expired = await seedInvite(env, { orgId: org, email: 'old@x.test', token: 'old-'.padEnd(43, 'e'), expiresAt: new Date(Date.now() - 1000).toISOString() })
    const revoked = await seedInvite(env, { orgId: org, email: 'gone@x.test', token: 'gone-'.padEnd(43, 'r'), revokedAt: new Date().toISOString() })
    // Accepted but still inside its seven days: kept, so a re-clicked link still says
    // INVITE_ACCEPTED rather than INVITE_NOT_FOUND.
    const accepted = await seedInvite(env, { orgId: org, email: 'in@x.test', token: 'in-'.padEnd(43, 'a'), acceptedAt: new Date().toISOString() })

    const result = await housekeepingTick(env)
    expect(result.orgInvitesDeleted).toBe(2)
    const { results } = await env.DB.prepare('SELECT id FROM org_invites ORDER BY id').all<{ id: string }>()
    expect(results.map((r) => r.id).sort()).toEqual([accepted, open].sort())
    expect(results.map((r) => r.id)).not.toContain(expired)
    expect(results.map((r) => r.id)).not.toContain(revoked)

    // And an accepted row goes once it is past its expiry, so nothing accumulates for ever.
    await env.DB.prepare('UPDATE org_invites SET expires_at = ? WHERE id = ?').bind(new Date(Date.now() - 1000).toISOString(), accepted).run()
    expect((await housekeepingTick(env)).orgInvitesDeleted).toBe(1)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM org_invites').first<{ n: number }>()).toEqual({ n: 1 })
  })

  it('bounds its own delete per tick', async () => {
    const env = createTestEnv()
    const org = await seedOrg(env, 'Lots')
    const { INVITE_PURGE_PER_TICK } = await import('../src/lib/housekeeping')
    for (let i = 0; i < INVITE_PURGE_PER_TICK + 5; i += 1) {
      await seedInvite(env, {
        orgId: org, email: `p${i}@x.test`, token: `tok-${i}-`.padEnd(43, 'p'),
        revokedAt: new Date().toISOString(),
      })
    }
    expect((await housekeepingTick(env)).orgInvitesDeleted).toBe(INVITE_PURGE_PER_TICK)
    expect((await housekeepingTick(env)).orgInvitesDeleted).toBe(5)
  })
})
