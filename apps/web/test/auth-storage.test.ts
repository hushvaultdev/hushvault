import { describe, expect, it } from 'vitest'

import { pathRequiresSession } from '../src/lib/auth-storage'

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
    ]) {
      expect(pathRequiresSession(path)).toBe(true)
    }
  })

  it('leaves public routes to the hint, so they make no pointless refresh call', () => {
    for (const path of ['/', '/pricing', '/faq', '/docs', '/sign-in', '/sign-up', '/share/tok_abc', '/auth/callback']) {
      expect(pathRequiresSession(path)).toBe(false)
    }
  })

  it('does not match on a prefix that is merely similar', () => {
    expect(pathRequiresSession('/dashboards-public')).toBe(false)
    expect(pathRequiresSession('/billing-faq')).toBe(false)
  })
})
