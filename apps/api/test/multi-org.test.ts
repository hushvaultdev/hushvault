// Multi-org foundation (issue #82, docs/plans/multi-org-and-invites.md Lane A).
//
// The tests marked REGRESSION are the ones that define the issue: each hand-inserts a SECOND
// membership and then asserts that the credential keeps acting in the org it was issued for. Every
// one of them fails against the code before this change, where three call sites answered "which
// org?" with `members ... ORDER BY created_at ASC LIMIT 1`:
//
//   * middleware/auth.ts (API-key auth)  -> the key acted in its owner's EARLIEST org
//   * routes/auth.ts (refresh)           -> a refresh moved the session to that org, with its role
//   * routes/secret-scanner.ts           -> a leaked key was filed in that org's audit trail
import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedApiKey, seedProject, seedUser, type Role, type TestEnv } from './helpers/env'
import { createPrefixedId } from '../src/lib/auth'

const PASSWORD = 'correct horse battery staple'
const WEB = { 'x-hushvault-client': 'web' }
const CLI = { 'x-hushvault-client': 'cli' }

function cookieOf(res: { headers: Headers }): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

function jwtClaims(token: string): { sub: string; orgId: string; role: string } {
  return JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString())
}

async function seedOrg(env: TestEnv, name = 'Second Org'): Promise<string> {
  const id = createPrefixedId('org')
  await env.DB.prepare('INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, name, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${id.slice(-6).toLowerCase()}`, 'free', new Date().toISOString())
    .run()
  return id
}

/**
 * The hand-inserted second membership the whole issue is about. `createdAt` defaults to a timestamp
 * AFTER the one seedUser writes, so the user's first org stays the earliest one — which is what the
 * old code would have resolved to no matter which org the credential belonged to.
 */
async function addMembership(
  env: TestEnv,
  opts: { userId: string; orgId: string; role: Role; createdAt?: string },
): Promise<void> {
  await env.DB.prepare('INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(createPrefixedId('mem'), opts.orgId, opts.userId, opts.role, opts.createdAt ?? new Date(Date.now() + 60_000).toISOString())
    .run()
}

/**
 * The EXACT expression the three fixed call sites used to answer "which org?".
 *
 * It is kept here, in the tests, as the proof that each REGRESSION fixture really does reproduce
 * the issue: every one of them asserts first that this resolves to the WRONG org (the user's
 * earliest membership, which is not the org the credential belongs to) and then that the endpoint
 * answers the right one. Reinstating the resolution in any of those three places therefore breaks
 * these tests on the endpoint assertion, not on a comment.
 */
async function earliestMembershipOrg(env: TestEnv, userId: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
    .bind(userId).first<{ org_id: string }>()
  return row?.org_id ?? null
}

/** Assert the fixture is adversarial: the old resolution picks `wrongOrgId`, the credential is elsewhere. */
async function expectOldResolutionWouldPick(env: TestEnv, userId: string, wrongOrgId: string, credentialOrgId: string) {
  expect(await earliestMembershipOrg(env, userId)).toBe(wrongOrgId)
  expect(wrongOrgId).not.toBe(credentialOrgId)
}

async function auditRows(env: TestEnv, action: string) {
  const { results } = await env.DB.prepare('SELECT org_id, action, resource_id FROM audit_log WHERE action = ? ORDER BY timestamp ASC')
    .bind(action).all<{ org_id: string; action: string; resource_id: string | null }>()
  return results
}

describe('API keys act in the org they were created in', () => {
  it('REGRESSION: a key made in the second org reads that org, with that org\'s role', async () => {
    const env = createTestEnv()
    // Org A: created first, so it is the EARLIEST membership and the old code's answer.
    const user = await seedUser(env, { role: 'owner' })
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'viewer' })
    const projectA = await seedProject(env, user.orgId, 'InOrgA')
    const projectB = await seedProject(env, orgB, 'InOrgB')

    const key = await seedApiKey(env, user.userId, orgB)
    await expectOldResolutionWouldPick(env, user.userId, user.orgId, orgB)
    const list = await call(env, 'GET', '/api/projects', { token: key.rawKey })
    expect(list.status).toBe(200)
    // Before the change this returned org A's project: the key crossed an org boundary on every
    // request, without the holder doing anything.
    expect(list.body.data.map((row: { id: string }) => row.id)).toEqual([projectB])
    expect(JSON.stringify(list.body)).not.toContain(projectA)

    // And the ROLE comes from org B's membership (viewer), not from owner-in-A. Creating a project
    // needs admin, so the old resolution handed this key permissions it was never granted.
    const create = await call(env, 'POST', '/api/projects', { token: key.rawKey, json: { name: 'Should not exist' } })
    expect(create.status).toBe(403)
    expect(create.body.error).toBe('FORBIDDEN')
  })

  it('fails closed when the key has no org, and never falls back to another membership', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    await seedProject(env, user.orgId, 'InOrgA')
    // A key minted by the pre-0018 code, or one whose owner had no membership when 0018 backfilled.
    const orphan = await seedApiKey(env, user.userId, null)
    const res = await call(env, 'GET', '/api/projects', { token: orphan.rawKey })
    expect(res.status).toBe(401)
    expect(res.body).toEqual({ error: 'KEY_ORG_UNRESOLVED', message: 'This API key has no usable organisation. Create a new key.' })
  })

  it('REGRESSION: losing the membership kills the key instead of moving it to the remaining org', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' }) // org A, earliest, membership kept
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'admin' })
    const key = await seedApiKey(env, user.userId, orgB)
    await expectOldResolutionWouldPick(env, user.userId, user.orgId, orgB)
    expect((await call(env, 'GET', '/api/projects', { token: key.rawKey })).status).toBe(200)

    // Removed from org B only. The old code would have answered with org A and kept working.
    await env.DB.prepare('DELETE FROM members WHERE user_id = ? AND org_id = ?').bind(user.userId, orgB).run()
    const res = await call(env, 'GET', '/api/projects', { token: key.rawKey })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('KEY_ORG_UNRESOLVED')
  })

  it('a new key records the org the creating session is acting in', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'owner' })
    const switched = await call(env, 'POST', `/api/orgs/${orgB}/switch`, { token: user.token, headers: WEB })
    expect(switched.status).toBe(200)

    const created = await call(env, 'POST', '/api/auth/api-keys', { token: switched.body.data.token, json: { name: 'made in B' } })
    expect(created.status).toBe(201)
    expect(created.body.data.orgId).toBe(orgB)
    const row = await env.DB.prepare('SELECT org_id FROM api_keys WHERE id = ?').bind(created.body.data.id).first<{ org_id: string }>()
    expect(row?.org_id).toBe(orgB)
  })

  it('revoking a key is audited against the key\'s org, not the actor\'s current one', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'owner' })
    const key = await seedApiKey(env, user.userId, orgB)

    // The session is acting in org A while deleting a key that belongs to org B.
    await expectOldResolutionWouldPick(env, user.userId, user.orgId, orgB)
    const res = await call(env, 'DELETE', `/api/auth/api-keys/${key.id}`, { token: user.token })
    expect(res.status).toBe(200)
    expect(await auditRows(env, 'auth.api_key.revoke')).toEqual([
      { org_id: orgB, action: 'auth.api_key.revoke', resource_id: key.id },
    ])
  })
})

describe('a refresh family is bound to one org for its whole life', () => {
  it('REGRESSION: refresh keeps the family\'s org and re-reads the role for THAT org', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' }) // org A, earliest
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'member' })

    const switched = await call(env, 'POST', `/api/orgs/${orgB}/switch`, { token: user.token, headers: WEB })
    expect(switched.status).toBe(200)
    await expectOldResolutionWouldPick(env, user.userId, user.orgId, orgB)
    const refreshed = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(switched) } })
    expect(refreshed.status).toBe(200)
    // Before the change: orgId = org A and role = owner, 15 minutes after the user switched.
    expect(refreshed.body.data.orgId).toBe(orgB)
    expect(refreshed.body.data.role).toBe('member')
    expect(jwtClaims(refreshed.body.data.token)).toMatchObject({ orgId: orgB, role: 'member' })

    // A demotion inside the family's own org still reaches the session at the next refresh.
    await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE user_id = ? AND org_id = ?").bind(user.userId, orgB).run()
    const again = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(refreshed) } })
    expect(again.body.data).toMatchObject({ orgId: orgB, role: 'viewer' })
  })

  it('the org survives repeated rotations, and the stored row carries it', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'admin' })
    let cookie = cookieOf(await call(env, 'POST', `/api/orgs/${orgB}/switch`, { token: user.token, headers: WEB }))
    for (let i = 0; i < 3; i += 1) {
      const res = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie } })
      expect(res.body.data.orgId).toBe(orgB)
      cookie = cookieOf(res)
    }
    const { results } = await env.DB.prepare('SELECT DISTINCT org_id FROM refresh_tokens').all<{ org_id: string }>()
    expect(results).toEqual([{ org_id: orgB }])
  })

  it('MEMBERSHIP_REVOKED: a family whose membership is gone fails closed, is revoked, and clears the cookie', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' }) // keeps org A throughout
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'admin' })
    const switched = await call(env, 'POST', `/api/orgs/${orgB}/switch`, { token: user.token, headers: WEB })
    const cookie = cookieOf(switched)
    await expectOldResolutionWouldPick(env, user.userId, user.orgId, orgB)

    await env.DB.prepare('DELETE FROM members WHERE user_id = ? AND org_id = ?').bind(user.userId, orgB).run()
    const res = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie } })
    expect(res.status).toBe(401)
    // Not a silent move to org A, which the user is still a member of — a distinct code the
    // dashboard can act on by sending the person back to org selection.
    expect(res.body).toMatchObject({ error: 'MEMBERSHIP_REVOKED', reason: 'membership_revoked' })
    expect(res.body.data).toBeUndefined()
    expect(res.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0|hv_refresh=;/i)
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').first<{ n: number }>()).toEqual({ n: 0 })
  })

  it('a pre-0018 family (no org recorded) fails closed rather than guessing one', async () => {
    const env = createTestEnv()
    const reg = await call(env, 'POST', '/api/auth/register', {
      headers: WEB,
      json: { email: 'ann@x.com', password: 'a-very-long-password-123', organisationName: 'Ann Org' },
    })
    expect(reg.status).toBe(201)
    // Exactly what the previously deployed code wrote: a family row with no org_id.
    await env.DB.prepare('UPDATE refresh_tokens SET org_id = NULL').run()
    const res = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(reg) } })
    expect(res.status).toBe(401)
    expect(res.body).toMatchObject({ error: 'INVALID_REFRESH', reason: 'org_unresolved' })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').first<{ n: number }>()).toEqual({ n: 0 })
  })
})

describe('GET /api/orgs', () => {
  it('lists every org the caller belongs to and marks the one the token acts in', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const orgB = await seedOrg(env, 'Beta')
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'viewer' })

    const res = await call(env, 'GET', '/api/orgs', { token: user.token })
    expect(res.status).toBe(200)
    expect(res.body.currentOrgId).toBe(user.orgId)
    expect(res.body.data).toEqual([
      { id: user.orgId, name: 'Test Org', slug: expect.any(String), plan: 'free', role: 'owner', current: true },
      { id: orgB, name: 'Beta', slug: expect.any(String), plan: 'free', role: 'viewer', current: false },
    ])
  })

  it('never lists an org the caller is not a member of', async () => {
    const env = createTestEnv()
    const mine = await seedUser(env, { role: 'owner' })
    const stranger = await seedUser(env, { role: 'owner' })
    const res = await call(env, 'GET', '/api/orgs', { token: mine.token })
    expect(res.body.data.map((row: { id: string }) => row.id)).toEqual([mine.orgId])
    expect(JSON.stringify(res.body)).not.toContain(stranger.orgId)
  })

  it('requires authentication', async () => {
    const env = createTestEnv()
    expect((await call(env, 'GET', '/api/orgs')).status).toBe(401)
  })
})

describe('POST /api/orgs', () => {
  it('creates the org with the caller as owner and audits it against the new org', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const res = await call(env, 'POST', '/api/orgs', { token: user.token, json: { name: 'Second Workspace' } })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name: 'Second Workspace', plan: 'free', role: 'owner' })
    expect(res.body.data.id).toMatch(/^org_/)
    expect(res.body.data.slug).toMatch(/^second-workspace-/)

    const member = await env.DB.prepare('SELECT role FROM members WHERE user_id = ? AND org_id = ? LIMIT 1')
      .bind(user.userId, res.body.data.id).first<{ role: string }>()
    expect(member).toEqual({ role: 'owner' })
    expect(await auditRows(env, 'org.create')).toEqual([
      { org_id: res.body.data.id, action: 'org.create', resource_id: res.body.data.id },
    ])

    // The caller is NOT moved into it: the switch is a separate, explicit call.
    const orgs = await call(env, 'GET', '/api/orgs', { token: user.token })
    expect(orgs.body.currentOrgId).toBe(user.orgId)
    expect(orgs.body.data).toHaveLength(2)
  })

  it('refuses API keys (a credential must not mint an org) and validates the name', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const key = await seedApiKey(env, user.userId)
    const byKey = await call(env, 'POST', '/api/orgs', { token: key.rawKey, json: { name: 'Sneaky' } })
    expect(byKey.status).toBe(403)
    expect(byKey.body.error).toBe('FORBIDDEN')

    const short = await call(env, 'POST', '/api/orgs', { token: user.token, json: { name: 'x' } })
    expect(short.status).toBe(400)
    expect(short.body.error).toBe('VALIDATION_ERROR')
  })

  it('gives two orgs of the same name distinct slugs', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const first = await call(env, 'POST', '/api/orgs', { token: user.token, json: { name: 'Same Name' } })
    const second = await call(env, 'POST', '/api/orgs', { token: user.token, json: { name: 'Same Name' } })
    expect(first.status).toBe(201)
    expect(second.status).toBe(201)
    expect(second.body.data.slug).not.toBe(first.body.data.slug)
  })
})

describe('POST /api/orgs/:id/switch', () => {
  it('rotates the refresh family into the new org, so the next refresh cannot drag the session back', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner', email: 'switcher@x.test' })
    const created = await call(env, 'POST', '/api/orgs', { token: user.token, json: { name: 'Target' } })
    const orgB = created.body.data.id as string

    // Start a real cookie-borne session in org A.
    const login = await call(env, 'POST', '/api/auth/login', {
      headers: WEB,
      json: { email: user.email, password: PASSWORD },
    })
    expect(login.body.data.orgId).toBe(user.orgId)
    const beforeFamilies = await env.DB.prepare('SELECT DISTINCT family_id FROM refresh_tokens').all<{ family_id: string }>()
    expect(beforeFamilies.results).toHaveLength(1)

    const switched = await call(env, 'POST', `/api/orgs/${orgB}/switch`, {
      token: login.body.data.token,
      headers: { ...WEB, cookie: cookieOf(login) },
    })
    expect(switched.status).toBe(200)
    expect(switched.body.data).toMatchObject({ orgId: orgB, role: 'owner', userId: user.userId })
    expect(jwtClaims(switched.body.data.token)).toMatchObject({ orgId: orgB, role: 'owner' })
    expect(switched.body.data.orgs.map((row: { id: string }) => row.id)).toEqual([user.orgId, orgB])

    // The old family is gone (not merely shadowed) and the only one left is bound to org B.
    const rows = await env.DB.prepare('SELECT family_id, org_id FROM refresh_tokens').all<{ family_id: string; org_id: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]?.org_id).toBe(orgB)
    expect(rows.results[0]?.family_id).not.toBe(beforeFamilies.results[0]?.family_id)

    // The cookie the browser now holds refreshes into org B, and the pre-switch cookie is dead.
    const after = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(switched) } })
    expect(after.body.data.orgId).toBe(orgB)
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(login) } })).status).toBe(401)

    expect(await auditRows(env, 'org.switch')).toEqual([{ org_id: orgB, action: 'org.switch', resource_id: orgB }])
  })

  it('403 NOT_A_MEMBER for an org the caller does not belong to, and the session is untouched', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const stranger = await seedUser(env, { role: 'owner' })
    const res = await call(env, 'POST', `/api/orgs/${stranger.orgId}/switch`, { token: user.token, headers: WEB })
    expect(res.status).toBe(403)
    expect(res.body).toEqual({ error: 'NOT_A_MEMBER', message: 'You are not a member of that organisation' })
    expect(await auditRows(env, 'org.switch')).toEqual([])
    // A non-existent org id is the same answer: membership is the only question asked.
    expect((await call(env, 'POST', '/api/orgs/org_nope/switch', { token: user.token, headers: WEB })).status).toBe(403)
  })

  it('refuses API keys: a key is bound to one org and cannot switch itself out of it', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'owner' })
    const key = await seedApiKey(env, user.userId, user.orgId)
    const res = await call(env, 'POST', `/api/orgs/${orgB}/switch`, { token: key.rawKey, headers: WEB })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('FORBIDDEN')
  })

  it('CLI: the new refresh token comes back in the body, and a cookie caller can never read one', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner', email: 'cli-switch@x.test' })
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'owner' })

    const login = await call(env, 'POST', '/api/auth/login', {
      headers: CLI,
      json: { email: user.email, password: PASSWORD },
    })
    const cli = await call(env, 'POST', `/api/orgs/${orgB}/switch`, {
      token: login.body.data.token,
      headers: CLI,
      json: { refreshToken: login.body.data.refreshToken },
    })
    expect(cli.status).toBe(200)
    expect(cli.body.data.refreshToken).toMatch(/^hvr_/)
    expect(cli.body.data.refreshToken).not.toBe(login.body.data.refreshToken)
    // The old CLI refresh token died with its family.
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: CLI, json: { refreshToken: login.body.data.refreshToken } })).status).toBe(401)

    // Cookie transport: no refresh token in the body, even claiming to be the CLI.
    const web = await call(env, 'POST', '/api/auth/login', { headers: WEB, json: { email: user.email, password: PASSWORD } })
    const viaCookie = await call(env, 'POST', `/api/orgs/${orgB}/switch`, {
      token: web.body.data.token,
      headers: { ...CLI, cookie: cookieOf(web) },
    })
    expect(viaCookie.status).toBe(200)
    expect(viaCookie.body.data.refreshToken).toBeUndefined()
    expect(JSON.stringify(viaCookie.body)).not.toMatch(/hvr_/)
  })

  it('cannot end another user\'s session by handing in their refresh token', async () => {
    const env = createTestEnv()
    const victim = await seedUser(env, { role: 'owner', email: 'victim@x.test' })
    const attacker = await seedUser(env, { role: 'owner', email: 'attacker@x.test' })
    const victimLogin = await call(env, 'POST', '/api/auth/login', {
      headers: CLI,
      json: { email: victim.email, password: PASSWORD },
    })
    const stolen = victimLogin.body.data.refreshToken as string

    const res = await call(env, 'POST', `/api/orgs/${attacker.orgId}/switch`, {
      token: attacker.token,
      headers: CLI,
      json: { refreshToken: stolen },
    })
    expect(res.status).toBe(200)
    // The victim's family is scoped out of the revoke, so their session still works.
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: CLI, json: { refreshToken: stolen } })).status).toBe(200)
  })
})

// ── GitHub secret-scanner callback ─────────────────────────────────────────────────────────────
// Driven end to end through a real signature: the route's own key lookup is satisfied by seeding
// the KV cache GitHub's key set is held in, so nothing about the verification is bypassed.

function derInteger(bytes: Uint8Array): number[] {
  let start = 0
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1
  let value = [...bytes.slice(start)]
  if (((value[0] ?? 0) & 0x80) !== 0) value = [0x00, ...value] // keep it a positive INTEGER
  return [0x02, value.length, ...value]
}

/** WebCrypto signs ECDSA as raw r||s; GitHub sends ASN.1 DER, which is what the route parses. */
function rawSignatureToDer(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.slice(0, 32)), ...derInteger(raw.slice(32))]
  return new Uint8Array([0x30, body.length, ...body])
}

async function seedScannerKey(env: TestEnv, keyId: string): Promise<CryptoKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const spki = Buffer.from(await crypto.subtle.exportKey('spki', pair.publicKey)).toString('base64')
  const pem = `-----BEGIN PUBLIC KEY-----\n${(spki.match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`
  await env.SECRETS_KV.put('ghss:public-keys', JSON.stringify({ public_keys: [{ key_identifier: keyId, key: pem, is_current: true }] }))
  return pair.privateKey
}

async function reportLeak(env: TestEnv, privateKey: CryptoKey, keyId: string, matches: unknown[]) {
  const body = JSON.stringify(matches)
  const raw = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(body),
  ))
  return call(env, 'POST', '/api/integrations/secret-scanner/github', {
    json: matches,
    headers: {
      'GITHUB-PUBLIC-KEY-IDENTIFIER': keyId,
      'GITHUB-PUBLIC-KEY-SIGNATURE': Buffer.from(rawSignatureToDer(raw)).toString('base64'),
    },
  })
}

describe('secret-scanner revocation', () => {
  it('REGRESSION: the audit row and the alert go to the org the leaked key belongs to', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' }) // org A, earliest membership
    const orgB = await seedOrg(env)
    await addMembership(env, { userId: user.userId, orgId: orgB, role: 'admin' })
    const key = await seedApiKey(env, user.userId, orgB)

    await expectOldResolutionWouldPick(env, user.userId, user.orgId, orgB)
    const privateKey = await seedScannerKey(env, 'k1')
    const res = await reportLeak(env, privateKey, 'k1', [{ token: key.rawKey, type: 'hushvault_api_key', url: 'https://github.com/x/y/blob/abc/.env' }])
    expect(res.status).toBe(200)
    expect(res.body).toEqual([{ token_raw: key.rawKey, token_type: 'hushvault_api_key', label: 'true_positive' }])

    // Before the change both rows were written against org A — the leak was reported to a team
    // with no responsibility for the key, and org B's trail showed nothing at all.
    expect(await auditRows(env, 'auth.api_key.revoke')).toEqual([
      { org_id: orgB, action: 'auth.api_key.revoke', resource_id: key.id },
    ])
    expect(await auditRows(env, 'notify.api_key_revoked')).toEqual([
      { org_id: orgB, action: 'notify.api_key_revoked', resource_id: key.id },
    ])

    // And the key really is dead.
    expect((await call(env, 'GET', '/api/projects', { token: key.rawKey })).status).toBe(401)
  })

  it('still revokes a key with no org, and says so instead of filing it somewhere wrong', async () => {
    const env = createTestEnv()
    const user = await seedUser(env, { role: 'owner' })
    const orphan = await seedApiKey(env, user.userId, null) // pre-0018 key, nothing to backfill from
    const privateKey = await seedScannerKey(env, 'k1')
    const res = await reportLeak(env, privateKey, 'k1', [{ token: orphan.rawKey, type: 'hushvault_api_key' }])
    expect(res.status).toBe(200)
    expect(res.body[0].label).toBe('true_positive')

    const row = await env.DB.prepare('SELECT revoked_reason FROM api_keys WHERE id = ?').bind(orphan.id).first<{ revoked_reason: string }>()
    expect(row).toEqual({ revoked_reason: 'leaked_in_github' })
    // No audit row invented for an org that was never established.
    expect(await auditRows(env, 'auth.api_key.revoke')).toEqual([])
    expect(await auditRows(env, 'notify.api_key_revoked')).toEqual([])
  })

  it('a token that is not ours is a false positive and writes nothing', async () => {
    const env = createTestEnv()
    await seedUser(env, { role: 'owner' })
    const privateKey = await seedScannerKey(env, 'k1')
    const res = await reportLeak(env, privateKey, 'k1', [{ token: 'hv_live_not_a_real_key', type: 'hushvault_api_key' }])
    expect(res.status).toBe(200)
    expect(res.body[0].label).toBe('false_positive')
    expect(await auditRows(env, 'auth.api_key.revoke')).toEqual([])
  })
})
