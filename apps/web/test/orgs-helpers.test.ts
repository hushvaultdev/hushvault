import { describe, expect, it } from 'vitest'

import { ApiError } from '../src/lib/api'
import type { OrgSummary } from '../src/lib/orgs-api'
import {
  MEMBERSHIP_CODES,
  ROLE_LABEL,
  assignableRoles,
  canManageMembers,
  currentOrgName,
  describeOrgError,
  expiryText,
  inviteStep,
  invitedEmailFromError,
  isEndpointMissing,
  isMembershipError,
  isOrgsUnavailable,
  membershipReason,
  orgNameOrId,
  parseInviteLink,
  shortId,
  validateInviteEmail,
  validateOrgName,
} from '../src/lib/orgs-helpers'

const orgs: OrgSummary[] = [
  { id: 'org_aaa', name: 'Acme', role: 'owner', plan: 'free' },
  { id: 'org_bbb', name: 'Beta Industries', role: 'member', plan: null },
]

describe('currentOrgName', () => {
  it('names the org the token acts in', () => {
    expect(currentOrgName(orgs, 'org_bbb')).toBe('Beta Industries')
  })

  // The whole point of issue #82: org A's name over org B's data is the bug. An id with no entry
  // in the list has no name, and must never borrow one.
  it('returns no name at all for an org that is not in the list', () => {
    expect(currentOrgName(orgs, 'org_zzz')).toBeNull()
    expect(currentOrgName(orgs, null)).toBeNull()
    expect(currentOrgName([], 'org_aaa')).toBeNull()
  })

  it('falls back to the id, never to another org', () => {
    expect(orgNameOrId(orgs, 'org_zzz')).toBe('org_zzz')
    expect(orgNameOrId(orgs, 'org_aaa')).toBe('Acme')
    expect(orgNameOrId(orgs, null)).toBe('Unknown')
  })

  it('shortens a long id for display without inventing text', () => {
    expect(shortId('org_0123456789abcdefghij')).toBe('org_0123456789…')
    expect(shortId('org_short')).toBe('org_short')
  })
})

describe('endpoint availability', () => {
  // The API answers an unmounted route with { error: 'Not found' } (apps/api/src/index.ts), and a
  // route that ran and found nothing with the code NOT_FOUND. The web app can deploy first, so
  // the difference decides between "degrade to one organisation" and "that invite is gone".
  it('treats a missing route as missing, and a missing row as an answer', () => {
    expect(isEndpointMissing(new ApiError(404, 'Not found', 'Not found'))).toBe(true)
    expect(isEndpointMissing(new ApiError(404, 'ERROR', 'Request failed (404).'))).toBe(true)
    expect(isEndpointMissing(new ApiError(404, 'NOT_FOUND', 'Invite not found'))).toBe(false)
    expect(isEndpointMissing(new ApiError(403, 'Not found', 'x'))).toBe(false)
    expect(isEndpointMissing(new Error('boom'))).toBe(false)
  })

  it('degrades on a missing or refusing deployment, without signing anyone out', () => {
    expect(isOrgsUnavailable(new ApiError(404, 'Not found', 'Not found'))).toBe(true)
    expect(isOrgsUnavailable(new ApiError(401, 'UNAUTHORIZED', 'Invalid token'))).toBe(true)
    expect(isOrgsUnavailable(new ApiError(405, 'ERROR', 'Method not allowed'))).toBe(true)
    expect(isOrgsUnavailable(new ApiError(501, 'ERROR', 'Not implemented'))).toBe(true)
  })

  it('does not treat a real refusal as an unavailable endpoint', () => {
    expect(isOrgsUnavailable(new ApiError(403, 'NOT_A_MEMBER', 'x'))).toBe(false)
    expect(isOrgsUnavailable(new ApiError(403, 'LAST_OWNER', 'x'))).toBe(false)
    expect(isOrgsUnavailable(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false)
    expect(isOrgsUnavailable(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(false)
  })
})

describe('membership failures', () => {
  it('recognises both codes', () => {
    for (const code of MEMBERSHIP_CODES) {
      expect(isMembershipError(new ApiError(403, code, 'x'))).toBe(true)
    }
    expect(isMembershipError(new ApiError(403, 'FORBIDDEN', 'x'))).toBe(false)
  })

  it('explains each one without showing the code', () => {
    for (const code of [...MEMBERSHIP_CODES, null]) {
      const text = membershipReason(code)
      expect(text).not.toMatch(/_/)
      expect(text).toMatch(/organisation/)
    }
    expect(membershipReason('MEMBERSHIP_REVOKED')).toMatch(/has ended/)
    expect(membershipReason('NOT_A_MEMBER')).toMatch(/not a member/)
  })
})

describe('describeOrgError', () => {
  it('explains the refusals the dashboard has to act on, in words', () => {
    for (const code of ['LAST_OWNER', 'INVITE_EMAIL_MISMATCH', 'MEMBERSHIP_REVOKED', 'NOT_A_MEMBER', 'INVITE_EXPIRED', 'EMAIL_NOT_VERIFIED']) {
      const message = describeOrgError(new ApiError(403, code, 'raw api text'), 'fallback')
      expect(message, code).not.toBe('raw api text')
      expect(message, code).not.toBe('fallback')
      expect(message, code).not.toMatch(/[A-Z]{3,}_[A-Z]/) // no raw SCREAMING_SNAKE code leaked
    }
  })

  it('says what to do about the last owner', () => {
    const message = describeOrgError(new ApiError(409, 'LAST_OWNER', 'last owner'), 'f')
    expect(message).toMatch(/must keep an owner/)
    expect(message).toMatch(/someone else an owner first/)
  })

  it('says an invitation belongs to an address', () => {
    expect(describeOrgError(new ApiError(403, 'INVITE_EMAIL_MISMATCH', 'x'), 'f')).toMatch(/different email address/)
  })

  it('uses the API wording where only the API knows the detail', () => {
    expect(describeOrgError(new ApiError(409, 'CONFLICT', 'That address already has an open invitation'), 'f')).toBe(
      'That address already has an open invitation',
    )
    expect(describeOrgError(new ApiError(400, 'VALIDATION_ERROR', 'Role is not valid'), 'f')).toBe('Role is not valid')
  })

  it('does not pretend a missing endpoint is a user error', () => {
    expect(describeOrgError(new ApiError(404, 'Not found', 'Not found'), 'f')).toMatch(/not available on this deployment/)
  })

  it('falls back for anything that is not an API error', () => {
    expect(describeOrgError(new Error('boom'), 'fallback')).toBe('fallback')
    expect(describeOrgError(new ApiError(500, 'INTERNAL_ERROR', 'x'), 'f')).toMatch(/server/)
  })
})

describe('invitedEmailFromError', () => {
  it('prefers what the API said over the link hint', () => {
    const err = new ApiError(403, 'INVITE_EMAIL_MISMATCH', 'x', { error: 'INVITE_EMAIL_MISMATCH', invitedEmail: 'real@example.com' })
    expect(invitedEmailFromError(err, 'hint@example.com')).toBe('real@example.com')
  })

  it('accepts the snake_case spelling and a plain email field', () => {
    expect(invitedEmailFromError(new ApiError(403, 'X', 'x', { invited_email: 'a@b.co' }), null)).toBe('a@b.co')
    expect(invitedEmailFromError(new ApiError(403, 'X', 'x', { email: 'a@b.co' }), null)).toBe('a@b.co')
  })

  it('uses the link hint when the API said nothing, and nothing when neither did', () => {
    expect(invitedEmailFromError(new ApiError(403, 'X', 'x'), 'hint@example.com')).toBe('hint@example.com')
    expect(invitedEmailFromError(new ApiError(403, 'X', 'x', { message: 'no' }), null)).toBeNull()
    expect(invitedEmailFromError(new Error('boom'), null)).toBeNull()
  })
})

describe('roles', () => {
  it('only lets an owner create another owner', () => {
    expect(assignableRoles('owner')).toContain('owner')
    expect(assignableRoles('admin')).not.toContain('owner')
    expect(assignableRoles('member')).toEqual([])
    expect(assignableRoles(undefined)).toEqual([])
  })

  it('knows who can manage members', () => {
    expect(canManageMembers('owner')).toBe(true)
    expect(canManageMembers('admin')).toBe(true)
    expect(canManageMembers('member')).toBe(false)
    expect(canManageMembers('viewer')).toBe(false)
    expect(canManageMembers(undefined)).toBe(false)
  })

  it('has a label for every role', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      expect(ROLE_LABEL[role]).toBeTruthy()
    }
  })
})

describe('validation', () => {
  it('checks org names', () => {
    expect(validateOrgName('Acme')).toBeNull()
    expect(validateOrgName(' A ')).toMatch(/2 characters/)
    expect(validateOrgName('x'.repeat(121))).toMatch(/too long/)
  })

  it('checks invite addresses without second-guessing the API', () => {
    expect(validateInviteEmail('person@example.com')).toBeNull()
    expect(validateInviteEmail('  person@example.com  ')).toBeNull()
    expect(validateInviteEmail('')).toMatch(/Enter the email/)
    expect(validateInviteEmail('person@example')).toMatch(/complete email address/)
    expect(validateInviteEmail(`${'a'.repeat(250)}@example.com`)).toMatch(/too long/)
  })
})

describe('expiryText', () => {
  const now = Date.parse('2026-10-05T12:00:00Z')

  it('counts down in units people read', () => {
    expect(expiryText('2026-10-12T12:00:00Z', now)).toBe('Expires in 7 days')
    expect(expiryText('2026-10-06T10:00:00Z', now)).toBe('Expires in 22 hours')
    expect(expiryText('2026-10-05T12:30:00Z', now)).toBe('Expires within the hour')
    expect(expiryText('2026-10-06T12:00:00Z', now)).toBe('Expires in 1 day')
  })

  it('says expired rather than a negative countdown', () => {
    expect(expiryText('2026-10-04T12:00:00Z', now)).toBe('Expired')
  })

  it('says nothing when the API sent nothing usable', () => {
    expect(expiryText(null, now)).toBeNull()
    expect(expiryText('not a date', now)).toBeNull()
  })
})

describe('parseInviteLink', () => {
  it('prefers the fragment, which never reaches a server', () => {
    expect(parseInviteLink('?token=fromquery', '#token=fromhash')).toEqual({ token: 'fromhash', email: null })
  })

  it('accepts the query form, so the email can be built either way', () => {
    expect(parseInviteLink('?token=abc&email=a@b.co', '')).toEqual({ token: 'abc', email: 'a@b.co' })
  })

  it('picks up a non-secret address hint from the fragment', () => {
    expect(parseInviteLink('', '#token=abc&for=a@b.co')).toEqual({ token: 'abc', email: 'a@b.co' })
  })

  it('reports no token rather than an empty one', () => {
    expect(parseInviteLink('', '').token).toBeNull()
    expect(parseInviteLink('?token=', '#token=').token).toBeNull()
  })

  it('ignores an address hint that is not an address', () => {
    expect(parseInviteLink('?token=abc&email=nope', '').email).toBeNull()
  })
})

describe('inviteStep', () => {
  const base = { ready: true, hasToken: true, isAuthenticated: true, emailVerified: true }

  it('waits for the session before deciding anything', () => {
    expect(inviteStep({ ...base, ready: false })).toBe('loading')
    // Crucially not 'signed-out': a session being restored must never be reported as signed out.
    expect(inviteStep({ ...base, ready: false, isAuthenticated: false })).toBe('loading')
  })

  it('covers the three ways someone arrives from the email', () => {
    expect(inviteStep({ ...base, isAuthenticated: false })).toBe('signed-out')
    expect(inviteStep(base)).toBe('ready')
    expect(inviteStep({ ...base, emailVerified: false })).toBe('unverified')
  })

  it('treats an unknown verified flag as verified, and lets the API refuse', () => {
    expect(inviteStep({ ...base, emailVerified: undefined })).toBe('ready')
  })

  it('says so when the link carries no token', () => {
    expect(inviteStep({ ...base, hasToken: false })).toBe('no-token')
  })
})
