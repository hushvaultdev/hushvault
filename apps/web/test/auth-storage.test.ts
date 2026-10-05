import { describe, expect, it, vi } from 'vitest'

import { clearSession, pathRequiresSession, readSession, subscribeSession, writeSession } from '../src/lib/auth-storage'
import type { Session } from '../src/lib/types'

// A missing localStorage hint used to send the user to /sign-in even with a valid refresh cookie,
// which is what "it logs me out on every reload" looks like. On these paths the hint is not
// evidence of anything, so the refresh is attempted regardless.
describe('pathRequiresSession', () => {
  it('covers every route behind the dashboard layout', () => {
    for (const path of [
      '/dashboard',
      '/projects/prj_abc',
      '/audit',
      '/integrations',
      '/billing',
      '/onboarding',
      '/members',
      '/organisations',
    ]) {
      expect(pathRequiresSession(path)).toBe(true)
    }
  })

  it('leaves public routes to the hint, so they make no pointless refresh call', () => {
    for (const path of ['/', '/pricing', '/faq', '/docs', '/sign-in', '/sign-up', '/share/tok_abc', '/auth/callback']) {
      expect(pathRequiresSession(path)).toBe(false)
    }
  })

  // Reachable while signed out, but it still has to know who the visitor is: telling a signed-in
  // user to sign in is the same failure in a worse place, because the invitation is in their hand.
  it('finds out for real on the accept-invite page', () => {
    expect(pathRequiresSession('/invites/accept')).toBe(true)
  })

  it('does not match on a prefix that is merely similar', () => {
    expect(pathRequiresSession('/dashboards-public')).toBe(false)
    expect(pathRequiresSession('/billing-faq')).toBe(false)
    expect(pathRequiresSession('/organisations-pricing')).toBe(false)
  })
})

// The access token is refreshed from inside apiFetch, and after a switch in another tab the
// refresh comes back naming a different organisation. Anything rendering the organisation has to
// hear about that, or it shows one org's name over another org's data.
describe('subscribeSession', () => {
  const session = (orgId: string): Session => ({ token: `t-${orgId}`, userId: 'usr_1', orgId, role: 'owner' })

  it('tells subscribers when the session is written or cleared', () => {
    const seen: (string | null)[] = []
    const unsubscribe = subscribeSession(() => seen.push(readSession()?.orgId ?? null))
    writeSession(session('org_a'))
    writeSession(session('org_b'))
    clearSession()
    unsubscribe()
    writeSession(session('org_c'))
    expect(seen).toEqual(['org_a', 'org_b', null])
    clearSession()
  })

  it('does not announce a clear that changed nothing', () => {
    clearSession()
    const listener = vi.fn()
    const unsubscribe = subscribeSession(listener)
    clearSession()
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
