import { apiFetch } from './api'
import type { Role, Session } from './types'

// Typed client for the multi-org endpoints (docs/plans/multi-org-and-invites.md, Lanes A and B).
//
// The API deploys separately from this app, so every response is read through a normaliser rather
// than cast. Two reasons, both load-bearing:
//   1. The web app can ship before the API. A missing route answers 404 and the pages degrade
//      (see isOrgsUnavailable in orgs-helpers) instead of rendering half an organisation.
//   2. The wire format is not uniform in this API: list endpoints return raw snake_case D1 rows
//      while create responses are camelCase (see the note at the top of types.ts). The
//      normalisers accept both spellings, so a Lane A/B naming choice cannot silently produce
//      `undefined` where an org name belongs.
//
// Nothing here carries a secret value. The one credential-shaped field is an invite token, which
// the API returns exactly once on create; it is handed to the caller and never stored or logged.

const VALID_ROLES: readonly string[] = ['owner', 'admin', 'member', 'viewer']

export interface OrgSummary {
  id: string
  /** Display name. Falls back to the id when the API sent none — never another org's name. */
  name: string
  /** The caller's role in this org. The least privileged role when unknown. */
  role: Role
  plan: string | null
}

export interface OrgList {
  orgs: OrgSummary[]
  /** The org the current access token acts in, as the API sees it. Null when the API did not say. */
  currentOrgId: string | null
}

export interface MemberSummary {
  userId: string
  email: string | null
  role: Role
  joinedAt: string | null
}

export interface InviteSummary {
  id: string
  email: string
  role: Role
  createdAt: string | null
  expiresAt: string | null
  invitedBy: string | null
}

export interface InviteCreated {
  invite: InviteSummary
  /**
   * The single-use accept link, when the API returns one. Shown once so an admin whose email did
   * not arrive can pass it on; never persisted by this app. The invite is bound to its email
   * address server-side, so the link alone cannot add a different account.
   */
  acceptUrl: string | null
}

export interface AcceptedInvite {
  orgId: string | null
  orgName: string | null
  role: Role | null
}

type Row = Record<string, unknown>

function asRow(value: unknown): Row | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Row) : null
}

/** First non-empty string among the given keys, or null. */
function text(row: Row, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return null
}

function roleOf(row: Row, ...keys: string[]): Role | null {
  for (const key of keys) {
    const value = row[key]
    if (typeof value === 'string' && VALID_ROLES.includes(value)) return value as Role
  }
  return null
}

function rowsOf(value: unknown, ...keys: string[]): Row[] {
  if (Array.isArray(value)) return value.map(asRow).filter((r): r is Row => r !== null)
  const container = asRow(value)
  if (!container) return []
  for (const key of keys) {
    if (Array.isArray(container[key])) return rowsOf(container[key])
  }
  return []
}

export function normaliseOrgList(payload: unknown): OrgList {
  const container = asRow(payload)
  const currentOrgId = container ? text(container, 'currentOrgId', 'current_org_id', 'orgId', 'org_id') : null
  const list = rowsOf(payload, 'orgs', 'organisations', 'organizations', 'data')
  const orgs: OrgSummary[] = []
  let flaggedCurrent: string | null = null
  for (const row of list) {
    const id = text(row, 'id', 'orgId', 'org_id')
    if (!id) continue // an org we cannot address is not an org we can offer
    if (row['isCurrent'] === true || row['current'] === true || row['is_current'] === true) flaggedCurrent = id
    orgs.push({
      id,
      name: text(row, 'name', 'orgName', 'org_name', 'organisationName', 'organisation_name') ?? id,
      // Unknown role: assume the least privileged one. The server decides what is allowed;
      // guessing high would only show controls that then fail.
      role: roleOf(row, 'role', 'memberRole', 'member_role') ?? 'viewer',
      plan: text(row, 'plan', 'planName', 'plan_name'),
    })
  }
  return { orgs, currentOrgId: currentOrgId ?? flaggedCurrent }
}

export function normaliseMembers(payload: unknown): MemberSummary[] {
  return rowsOf(payload, 'members', 'data')
    .map((row) => {
      const userId = text(row, 'userId', 'user_id', 'id')
      if (!userId) return null
      return {
        userId,
        email: text(row, 'email', 'userEmail', 'user_email'),
        role: roleOf(row, 'role', 'memberRole', 'member_role') ?? 'viewer',
        joinedAt: text(row, 'joinedAt', 'joined_at', 'createdAt', 'created_at'),
      }
    })
    .filter((m): m is MemberSummary => m !== null)
}

function normaliseInvite(row: Row): InviteSummary | null {
  const id = text(row, 'id', 'inviteId', 'invite_id')
  const email = text(row, 'email', 'inviteeEmail', 'invitee_email')
  if (!id || !email) return null
  return {
    id,
    email,
    role: roleOf(row, 'role') ?? 'member',
    createdAt: text(row, 'createdAt', 'created_at'),
    expiresAt: text(row, 'expiresAt', 'expires_at'),
    invitedBy: text(row, 'invitedBy', 'invited_by'),
  }
}

export function normaliseInvites(payload: unknown): InviteSummary[] {
  return rowsOf(payload, 'invites', 'data')
    .map(normaliseInvite)
    .filter((i): i is InviteSummary => i !== null)
}

/**
 * A session from a switch (or any endpoint that mints a token). `previous` supplies only fields
 * the response omits and that cannot differ between orgs (the user id); the org and the role
 * always come from the response, because reusing the old ones is exactly how a token for org B
 * ends up labelled org A. Returns null when the response carries no usable token.
 */
export function normaliseSession(payload: unknown, previous: Session | null): Session | null {
  const container = asRow(payload)
  if (!container) return null
  const inner = asRow(container['session']) ?? container
  const token = text(inner, 'token', 'accessToken', 'access_token')
  const orgId = text(inner, 'orgId', 'org_id')
  const userId = text(inner, 'userId', 'user_id') ?? previous?.userId ?? null
  const nextRole = roleOf(inner, 'role')
  if (!token || !orgId || !userId || !nextRole) return null
  const verified = inner['emailVerified'] ?? inner['email_verified']
  return {
    token,
    userId,
    orgId,
    role: nextRole,
    emailVerified: typeof verified === 'boolean' ? verified : previous?.emailVerified,
  }
}

export function normaliseAccepted(payload: unknown): AcceptedInvite {
  const container = asRow(payload)
  const inner = container ? (asRow(container['membership']) ?? asRow(container['org']) ?? container) : null
  if (!inner) return { orgId: null, orgName: null, role: null }
  return {
    orgId: text(inner, 'orgId', 'org_id', 'id'),
    orgName: text(inner, 'orgName', 'org_name', 'name'),
    role: roleOf(inner, 'role'),
  }
}

export function normaliseInviteCreated(payload: unknown, fallbackEmail: string, fallbackRole: Role): InviteCreated {
  const container = asRow(payload) ?? {}
  const inviteRow = asRow(container['invite']) ?? container
  const invite = normaliseInvite(inviteRow)
  return {
    invite:
      invite ?? {
        id: text(inviteRow, 'id', 'inviteId', 'invite_id') ?? '',
        email: text(inviteRow, 'email') ?? fallbackEmail,
        role: roleOf(inviteRow, 'role') ?? fallbackRole,
        createdAt: null,
        expiresAt: text(inviteRow, 'expiresAt', 'expires_at'),
        invitedBy: null,
      },
    acceptUrl: text(container, 'acceptUrl', 'accept_url', 'url', 'inviteUrl', 'invite_url'),
  }
}

const ORGS = '/api/orgs'
const orgPath = (orgId: string, suffix: string) => `${ORGS}/${encodeURIComponent(orgId)}${suffix}`

export async function fetchOrgs(): Promise<OrgList> {
  return normaliseOrgList(await apiFetch<unknown>(ORGS))
}

export async function createOrg(name: string): Promise<OrgSummary | null> {
  // `{ name }` is settled: POST /api/orgs takes `name` (POST /api/auth/register calls the same
  // thing `organisationName`, which is why this was written tolerantly before the API landed).
  // Both spellings are documented in docs/API.md; do not re-add a retry for the other one.
  const payload = await apiFetch<unknown>(ORGS, { method: 'POST', body: { name } })
  const container = asRow(payload)
  const row = container ? (asRow(container['org']) ?? container) : null
  const id = row ? text(row, 'id', 'orgId', 'org_id') : null
  if (!row || !id) return null
  return {
    id,
    name: text(row, 'name', 'orgName', 'org_name') ?? name,
    role: roleOf(row, 'role') ?? 'owner',
    plan: text(row, 'plan', 'planName', 'plan_name'),
  }
}

export async function switchOrg(orgId: string, previous: Session | null): Promise<Session | null> {
  return normaliseSession(await apiFetch<unknown>(orgPath(orgId, '/switch'), { method: 'POST' }), previous)
}

export async function fetchMembers(orgId: string): Promise<MemberSummary[]> {
  return normaliseMembers(await apiFetch<unknown>(orgPath(orgId, '/members')))
}

export async function updateMemberRole(orgId: string, userId: string, nextRole: Role): Promise<void> {
  await apiFetch<unknown>(orgPath(orgId, `/members/${encodeURIComponent(userId)}`), { method: 'PATCH', body: { role: nextRole } })
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  await apiFetch<unknown>(orgPath(orgId, `/members/${encodeURIComponent(userId)}`), { method: 'DELETE' })
}

export async function fetchInvites(orgId: string): Promise<InviteSummary[]> {
  return normaliseInvites(await apiFetch<unknown>(orgPath(orgId, '/invites')))
}

export async function createInvite(orgId: string, email: string, inviteRole: Role): Promise<InviteCreated> {
  const payload = await apiFetch<unknown>(orgPath(orgId, '/invites'), { method: 'POST', body: { email, role: inviteRole } })
  return normaliseInviteCreated(payload, email, inviteRole)
}

export async function revokeInvite(orgId: string, inviteId: string): Promise<void> {
  await apiFetch<unknown>(orgPath(orgId, `/invites/${encodeURIComponent(inviteId)}`), { method: 'DELETE' })
}

export async function acceptInvite(token: string): Promise<AcceptedInvite> {
  return normaliseAccepted(await apiFetch<unknown>('/api/invites/accept', { method: 'POST', body: { token } }))
}
