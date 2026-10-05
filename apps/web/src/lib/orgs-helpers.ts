import { ApiError } from './api'
import type { OrgSummary } from './orgs-api'
import type { Role } from './types'

// Pure helpers for the organisation switcher, the members page and the accept-invite page.
// Nothing here fetches; everything is unit-tested in test/orgs-helpers.test.ts.

/** Roles in order of privilege, most privileged first. */
export const ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer']

export const ROLE_LABEL: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
}

export const ROLE_DESCRIPTION: Record<Role, string> = {
  owner: 'Full control, including billing and ownership. An organisation always keeps at least one owner.',
  admin: 'Manage projects, secrets, members, invitations and integrations.',
  member: 'Read and write secrets in the projects they can see.',
  viewer: 'Read-only access to projects and secrets.',
}

export function canManageMembers(role: Role | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Roles the actor may hand out. Only an owner can create another owner; an admin cannot promote
 * past their own level. The server enforces this too — this only keeps the UI from offering a
 * choice that will be refused.
 */
export function assignableRoles(actorRole: Role | undefined): Role[] {
  if (actorRole === 'owner') return ['owner', 'admin', 'member', 'viewer']
  if (actorRole === 'admin') return ['admin', 'member', 'viewer']
  return []
}

/**
 * True when the failure means "this API deployment does not have these endpoints", so the page
 * should degrade to a single organisation rather than show an error.
 *
 * The API answers an unmounted route with `{ "error": "Not found" }` (see apps/api/src/index.ts),
 * while a route that exists and did not find a row answers the SCREAMING_SNAKE_CASE code
 * `NOT_FOUND`. A non-JSON 404 (a proxy's error page) reaches us as the synthetic code `ERROR`.
 * Both of those mean "no such endpoint"; `NOT_FOUND` means "no such invite".
 */
export function isEndpointMissing(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 404) return false
  return err.code === 'ERROR' || !/^[A-Z][A-Z0-9_]*$/.test(err.code)
}

/**
 * True when the org endpoints cannot be used at all and the dashboard should fall back to "one
 * organisation". Deliberately includes a bare 401/403 with no code: the API may deploy after the
 * web app, and a user must never be signed out or shown a blank dashboard because a route they
 * did not ask for is missing. A 403 that names a membership or permission problem is NOT
 * "unavailable" — that is a real answer and is reported as one.
 */
export function isOrgsUnavailable(err: unknown): boolean {
  if (!(err instanceof ApiError)) return false
  if (isEndpointMissing(err)) return true
  if (err.status === 405 || err.status === 501) return true
  if (err.status === 401) return true
  if (err.status === 403) return err.code === 'ERROR' || err.code === 'FORBIDDEN'
  return false
}

export const MEMBERSHIP_CODES: readonly string[] = ['NOT_A_MEMBER', 'MEMBERSHIP_REVOKED']

/** The caller's membership of the org their token names is gone, or never existed. */
export function isMembershipError(err: unknown): boolean {
  return err instanceof ApiError && MEMBERSHIP_CODES.includes(err.code)
}

export function membershipReason(code: string | null): string {
  if (code === 'MEMBERSHIP_REVOKED') {
    return 'Your membership of that organisation has ended, so its projects and secrets are no longer available to you. Pick another organisation to continue.'
  }
  if (code === 'NOT_A_MEMBER') {
    return 'You are not a member of that organisation. Pick one of your own organisations to continue.'
  }
  return 'That organisation is no longer available to you. Pick one of your organisations to continue.'
}

const ORG_ERROR_MESSAGES: Record<string, string> = {
  LAST_OWNER:
    'An organisation must keep an owner — make someone else an owner first, then change or remove this one.',
  INVITE_EMAIL_MISMATCH:
    'This invitation was sent to a different email address. Accept it while signed in with that address.',
  MEMBERSHIP_REVOKED: 'Your membership of this organisation has ended.',
  NOT_A_MEMBER: 'You are not a member of this organisation.',
  KEY_ORG_UNRESOLVED: 'That API key is not bound to an organisation. Create a new key and use that instead.',
  INVITE_NOT_FOUND:
    'This invitation link is not valid. It may already have been used, revoked, or replaced by a newer one. Ask an admin to send a new invitation.',
  INVITE_INVALID:
    'This invitation link is not valid. It may already have been used, revoked, or replaced by a newer one. Ask an admin to send a new invitation.',
  INVITE_EXPIRED: 'This invitation has expired — invitations last seven days. Ask an admin to send a new one.',
  INVITE_ACCEPTED: 'This invitation has already been used.',
  INVITE_REVOKED: 'This invitation was revoked. Ask an admin to send a new one.',
  ALREADY_MEMBER: 'You are already a member of this organisation.',
  EMAIL_NOT_VERIFIED:
    'Verify your email address first. An invitation is accepted by a verified address, so nobody can join an organisation with an address they have not proven they own.',
  EMAIL_UNVERIFIED:
    'Verify your email address first. An invitation is accepted by a verified address, so nobody can join an organisation with an address they have not proven they own.',
  LIMIT_REACHED: 'This organisation has reached its member limit. Remove a member or an open invitation first.',
  PLAN_LIMIT: 'Your plan does not allow more members yet.',
}

/**
 * A refusal explained in words, never a raw code. Falls back to the API's own message, which is
 * written for people, and only then to the caller's fallback. Never includes request bodies, so
 * no invite token can end up in an error shown on screen.
 */
export function describeOrgError(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback
  const known = ORG_ERROR_MESSAGES[err.code]
  if (known) return known
  if (isEndpointMissing(err)) return 'This feature is not available on this deployment yet.'
  if (err.code === 'CONFLICT' || err.status === 409) return err.message || 'That conflicts with existing data.'
  if (err.code === 'VALIDATION_ERROR' || err.status === 400 || err.status === 422) {
    return err.message || 'Some of those details could not be used.'
  }
  if (err.status === 403) return err.message || 'You do not have permission to do that.'
  if (err.status === 429) return 'Too many requests. Wait a moment and try again.'
  if (err.status === 0) return err.message
  if (err.status >= 500) return 'The server had a problem. Try again shortly.'
  return err.message || fallback
}

/**
 * The address an invitation was sent to, when it can be known without asking the API for anything
 * about the organisation: either the non-secret hint on the invitation link, or a field the API
 * itself returned with the mismatch refusal. Returns null when neither is there, and the page
 * says so honestly instead of naming the wrong address.
 */
export function invitedEmailFromError(err: unknown, hint: string | null): string | null {
  if (err instanceof ApiError) {
    const details = err.details
    if (details) {
      for (const key of ['invitedEmail', 'invited_email', 'email']) {
        const value = details[key]
        if (typeof value === 'string' && value.includes('@')) return value
      }
    }
  }
  return hint
}

/** The org the access token acts in, by name. Never falls back to another org's name. */
export function currentOrgName(orgs: readonly OrgSummary[], orgId: string | null | undefined): string | null {
  if (!orgId) return null
  return orgs.find((o) => o.id === orgId)?.name ?? null
}

/** A short, recognisable form of an id for when there is no name to show. */
export function shortId(id: string | null | undefined): string {
  if (!id) return 'Unknown'
  return id.length > 14 ? `${id.slice(0, 14)}…` : id
}

export function orgNameOrId(orgs: readonly OrgSummary[], orgId: string | null | undefined): string {
  return currentOrgName(orgs, orgId) ?? shortId(orgId)
}

export function validateOrgName(value: string): string | null {
  const length = value.trim().length
  if (length < 2) return 'Give the organisation a name of at least 2 characters.'
  if (length > 120) return 'That name is too long (120 characters at most).'
  return null
}

// Deliberately permissive: the API is the authority on what it accepts, and a client-side
// rejection of a valid address is worse than one round trip.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function validateInviteEmail(value: string): string | null {
  const email = value.trim()
  if (email.length === 0) return 'Enter the email address to invite.'
  if (email.length > 254) return 'That email address is too long.'
  if (!EMAIL.test(email)) return 'Enter a complete email address, for example person@example.com.'
  return null
}

export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return 'Unknown'
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString()
}

/** "Expires in 6 days" / "Expired" / null when the API did not say. */
export function expiryText(expiresAt: string | null | undefined, now: number = Date.now()): string | null {
  if (!expiresAt) return null
  const at = new Date(expiresAt).getTime()
  if (Number.isNaN(at)) return null
  const ms = at - now
  if (ms <= 0) return 'Expired'
  const hours = Math.floor(ms / 3_600_000)
  if (hours < 1) return 'Expires within the hour'
  if (hours < 24) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `Expires in ${days} day${days === 1 ? '' : 's'}`
}

export interface InviteLink {
  token: string | null
  /** Non-secret hint, when the invitation link carries one, of the address invited. */
  email: string | null
}

/**
 * The token and optional address hint from an invitation link. The fragment is read first,
 * because that is where this app already puts single-use tokens (it is never sent to a server or
 * logged in a Referer header); the query string is accepted as well, so the page still works if
 * the invitation email is built the other way.
 */
export function parseInviteLink(search: string, hash: string): InviteLink {
  const fromHash = new URLSearchParams(hash.replace(/^#/, ''))
  const fromQuery = new URLSearchParams(search.replace(/^\?/, ''))
  const token = fromHash.get('token') ?? fromHash.get('invite') ?? fromQuery.get('token') ?? fromQuery.get('invite')
  const email = fromHash.get('email') ?? fromHash.get('for') ?? fromQuery.get('email') ?? fromQuery.get('for')
  return {
    token: token && token.trim() !== '' ? token : null,
    email: email && email.includes('@') ? email : null,
  }
}

export type InviteStep = 'loading' | 'no-token' | 'signed-out' | 'unverified' | 'ready'

/**
 * Which of the three arrival states the accept-invite page is in. Someone following an emailed
 * link may be signed out, signed in as the right account, or signed in as the wrong one — the
 * wrong account cannot be told apart here (only the API knows the invited address), so it is
 * handled by the refusal, not by a guess.
 */
export function inviteStep(input: {
  ready: boolean
  hasToken: boolean
  isAuthenticated: boolean
  emailVerified: boolean | undefined
}): InviteStep {
  if (!input.ready) return 'loading'
  if (!input.hasToken) return 'no-token'
  if (!input.isAuthenticated) return 'signed-out'
  if (input.emailVerified === false) return 'unverified'
  return 'ready'
}
