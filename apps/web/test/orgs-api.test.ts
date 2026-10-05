import { afterEach, describe, expect, it, vi } from 'vitest'

import { API_BASE, ApiError } from '../src/lib/api'
import {
  acceptInvite,
  createInvite,
  createOrg,
  fetchInvites,
  fetchMembers,
  fetchOrgs,
  normaliseOrgList,
  normaliseSession,
  removeMember,
  revokeInvite,
  switchOrg,
  updateMemberRole,
} from '../src/lib/orgs-api'
import type { Session } from '../src/lib/types'

// The API is built by another lane and is not running here, so the client is exercised against a
// stubbed fetch. What is being checked is the two things that can break silently: the URL and
// method each call makes, and that a response shape we did not predict degrades predictably
// instead of putting `undefined` where an organisation name belongs.

interface Call {
  url: string
  method: string
  body: unknown
}

function stubApi(reply: (call: Call) => { status?: number; body?: unknown }): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url).replace(API_BASE, ''),
      method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    const { status = 200, body = { data: null } } = reply(call)
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
    )
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normaliseOrgList', () => {
  it('reads the documented envelope', () => {
    const list = normaliseOrgList({
      orgs: [
        { id: 'org_a', name: 'Acme', role: 'owner', plan: 'free' },
        { id: 'org_b', name: 'Beta', role: 'member', plan: 'free' },
      ],
      currentOrgId: 'org_b',
    })
    expect(list.currentOrgId).toBe('org_b')
    expect(list.orgs.map((o) => o.name)).toEqual(['Acme', 'Beta'])
  })

  it('reads a flat array, with the current org flagged on the row', () => {
    const list = normaliseOrgList([
      { id: 'org_a', name: 'Acme', role: 'admin' },
      { id: 'org_b', name: 'Beta', role: 'viewer', isCurrent: true },
    ])
    expect(list.currentOrgId).toBe('org_b')
    expect(list.orgs).toHaveLength(2)
  })

  it('reads raw snake_case rows, which is what this API returns from list endpoints', () => {
    const list = normaliseOrgList({ organisations: [{ org_id: 'org_a', org_name: 'Acme', member_role: 'admin', plan_name: 'pro' }] })
    expect(list.orgs[0]).toEqual({ id: 'org_a', name: 'Acme', role: 'admin', plan: 'pro' })
  })

  it('never leaves a name undefined: an org with no name shows its id', () => {
    const list = normaliseOrgList([{ id: 'org_a', role: 'owner' }])
    expect(list.orgs[0]?.name).toBe('org_a')
  })

  it('drops an org it could not address and distrusts an unknown role', () => {
    const list = normaliseOrgList([{ name: 'No id here' }, { id: 'org_b', name: 'Beta', role: 'superuser' }])
    expect(list.orgs).toHaveLength(1)
    // An unrecognised role becomes the least privileged one: the UI must not offer admin controls
    // on a guess, and the server decides anyway.
    expect(list.orgs[0]?.role).toBe('viewer')
  })

  it('survives nonsense without throwing', () => {
    for (const payload of [null, undefined, 'nope', 42, {}, { orgs: 'not an array' }]) {
      expect(normaliseOrgList(payload)).toEqual({ orgs: [], currentOrgId: null })
    }
  })
})

describe('normaliseSession', () => {
  const previous: Session = { token: 'old', userId: 'usr_1', orgId: 'org_a', role: 'owner', emailVerified: true }

  it('takes the org and role from the response, never from the old session', () => {
    const next = normaliseSession({ token: 'new', userId: 'usr_1', orgId: 'org_b', role: 'viewer' }, previous)
    expect(next).toEqual({ token: 'new', userId: 'usr_1', orgId: 'org_b', role: 'viewer', emailVerified: true })
  })

  it('accepts a nested session and snake_case fields', () => {
    const next = normaliseSession({ session: { access_token: 'new', user_id: 'usr_9', org_id: 'org_c', role: 'admin', email_verified: false } }, null)
    expect(next).toEqual({ token: 'new', userId: 'usr_9', orgId: 'org_c', role: 'admin', emailVerified: false })
  })

  it('refuses a response with no token, no org or no role rather than inventing one', () => {
    expect(normaliseSession({ userId: 'usr_1', orgId: 'org_b', role: 'owner' }, previous)).toBeNull()
    expect(normaliseSession({ token: 't', role: 'owner' }, previous)).toBeNull()
    expect(normaliseSession({ token: 't', orgId: 'org_b' }, previous)).toBeNull()
    expect(normaliseSession(null, previous)).toBeNull()
  })
})

describe('the org endpoints the dashboard calls', () => {
  it('lists organisations', async () => {
    const calls = stubApi(() => ({ body: { data: { orgs: [{ id: 'org_a', name: 'Acme', role: 'owner' }], currentOrgId: 'org_a' } } }))
    const list = await fetchOrgs()
    expect(calls[0]).toMatchObject({ url: '/api/orgs', method: 'GET' })
    expect(list.orgs[0]?.name).toBe('Acme')
  })

  it('switches with a POST to the org it names', async () => {
    const calls = stubApi(() => ({ body: { data: { token: 't2', userId: 'usr_1', orgId: 'org b', role: 'member' } } }))
    const session = await switchOrg('org b', { token: 't1', userId: 'usr_1', orgId: 'org_a', role: 'owner' })
    expect(calls[0]).toMatchObject({ url: '/api/orgs/org%20b/switch', method: 'POST' })
    expect(session?.orgId).toBe('org b')
    expect(session?.role).toBe('member')
  })

  // POST /api/orgs takes `name` (the API landed after this client was written; register's
  // `organisationName` spelling is not accepted here and is not retried).
  it('creates an organisation with the one field name the API takes', async () => {
    const calls = stubApi(() => ({ body: { data: { id: 'org_new', name: 'Acme', role: 'owner' } } }))
    const created = await createOrg('Acme')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ name: 'Acme' })
    expect(created?.id).toBe('org_new')
  })

  it('surfaces a refusal instead of guessing another field name', async () => {
    const calls = stubApi(() => ({ status: 400, body: { error: 'VALIDATION_ERROR', message: 'name is too short' } }))
    await expect(createOrg('A')).rejects.toBeInstanceOf(ApiError)
    expect(calls).toHaveLength(1)
  })

  it('reads members from either spelling', async () => {
    stubApi(() => ({
      body: {
        data: [
          { user_id: 'usr_1', email: 'a@example.com', role: 'owner', created_at: '2026-10-01T00:00:00Z' },
          { userId: 'usr_2', email: 'b@example.com', role: 'member', joinedAt: '2026-10-02T00:00:00Z' },
        ],
      },
    }))
    const members = await fetchMembers('org_a')
    expect(members).toEqual([
      { userId: 'usr_1', email: 'a@example.com', role: 'owner', joinedAt: '2026-10-01T00:00:00Z' },
      { userId: 'usr_2', email: 'b@example.com', role: 'member', joinedAt: '2026-10-02T00:00:00Z' },
    ])
  })

  it('changes a role with PATCH and removes with DELETE, on the member path', async () => {
    const calls = stubApi(() => ({ body: { data: null } }))
    await updateMemberRole('org_a', 'usr_2', 'admin')
    await removeMember('org_a', 'usr_2')
    expect(calls[0]).toMatchObject({ url: '/api/orgs/org_a/members/usr_2', method: 'PATCH', body: { role: 'admin' } })
    expect(calls[1]).toMatchObject({ url: '/api/orgs/org_a/members/usr_2', method: 'DELETE' })
  })

  it('lists and revokes invitations, and never asks for a token', async () => {
    const calls = stubApi((call) =>
      call.method === 'GET'
        ? { body: { data: { invites: [{ id: 'inv_1', email: 'a@example.com', role: 'member', expires_at: '2026-10-12T00:00:00Z' }] } } }
        : { body: { data: null } },
    )
    const invites = await fetchInvites('org_a')
    expect(invites[0]).toEqual({
      id: 'inv_1',
      email: 'a@example.com',
      role: 'member',
      createdAt: null,
      expiresAt: '2026-10-12T00:00:00Z',
      invitedBy: null,
    })
    await revokeInvite('org_a', 'inv_1')
    expect(calls[1]).toMatchObject({ url: '/api/orgs/org_a/invites/inv_1', method: 'DELETE' })
  })

  it('creates an invitation and surfaces the one-time link when the API returns one', async () => {
    const calls = stubApi(() => ({
      body: { data: { invite: { id: 'inv_2', email: 'new@example.com', role: 'admin' }, acceptUrl: 'https://hushvault.dev/invites/accept#token=abc' } },
    }))
    const created = await createInvite('org_a', 'new@example.com', 'admin')
    expect(calls[0]).toMatchObject({ url: '/api/orgs/org_a/invites', method: 'POST', body: { email: 'new@example.com', role: 'admin' } })
    expect(created.invite.id).toBe('inv_2')
    expect(created.acceptUrl).toBe('https://hushvault.dev/invites/accept#token=abc')
  })

  it('still shows who was invited when the create response is thinner than expected', async () => {
    stubApi(() => ({ body: { data: { ok: true } } }))
    const created = await createInvite('org_a', 'new@example.com', 'viewer')
    expect(created.invite.email).toBe('new@example.com')
    expect(created.invite.role).toBe('viewer')
    expect(created.acceptUrl).toBeNull()
  })

  it('accepts an invitation by token and reports the org joined', async () => {
    const calls = stubApi(() => ({ body: { data: { orgId: 'org_b', orgName: 'Beta', role: 'member' } } }))
    const accepted = await acceptInvite('tok_abc')
    expect(calls[0]).toMatchObject({ url: '/api/invites/accept', method: 'POST', body: { token: 'tok_abc' } })
    expect(accepted).toEqual({ orgId: 'org_b', orgName: 'Beta', role: 'member' })
  })

  it('reports an acceptance it cannot read, rather than a half-made org', async () => {
    stubApi(() => ({ body: { data: { accepted: true } } }))
    expect(await acceptInvite('tok_abc')).toEqual({ orgId: null, orgName: null, role: null })
  })

  it('carries the API error code and its fields through for the page to explain', async () => {
    stubApi(() => ({ status: 403, body: { error: 'INVITE_EMAIL_MISMATCH', message: 'wrong address', invitedEmail: 'real@example.com' } }))
    await expect(acceptInvite('tok_abc')).rejects.toMatchObject({
      status: 403,
      code: 'INVITE_EMAIL_MISMATCH',
      details: { invitedEmail: 'real@example.com' },
    })
  })
})
