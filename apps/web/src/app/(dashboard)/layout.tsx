'use client'

import { useRouter } from 'next/navigation'
import { Fragment, useEffect } from 'react'

import { DashboardShell } from '@/components/shell/dashboard-shell'
import { useAuth } from '@/lib/auth-context'
import { OrgProvider } from '@/lib/org-context'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated, ready, session } = useAuth()

  useEffect(() => {
    if (ready && !isAuthenticated) {
      router.replace('/sign-in')
    }
  }, [ready, isAuthenticated, router])

  // Every cold load waits here for the refresh round trip. Returning null showed a completely
  // empty page for its duration — indefinitely if the API is slow or down — with nothing for a
  // screen reader to announce. Say what is happening instead.
  if (!ready) {
    return (
      <main
        role="status"
        aria-live="polite"
        style={{
          minHeight: '60vh',
          display: 'grid',
          placeItems: 'center',
          padding: '24px 16px',
          color: 'var(--muted, #6b7280)',
        }}
      >
        Restoring your session…
      </main>
    )
  }

  // Ready but unauthenticated: the redirect above is already in flight.
  if (!isAuthenticated) {
    return null
  }

  // Every page below this layout fetches org-scoped data into its own state on mount, and there
  // is no query cache to invalidate. Keying the subtree on the organisation the token acts in
  // makes that an advantage: when the org changes — from the switcher, or because this tab's
  // token was refreshed into a family another tab switched — React unmounts every page and its
  // state, and the new page mounts and fetches from scratch. A project list from the previous
  // organisation cannot survive under the new organisation's name.
  return (
    <OrgProvider>
      <DashboardShell>
        <Fragment key={session?.orgId ?? 'no-org'}>{children}</Fragment>
      </DashboardShell>
    </OrgProvider>
  )
}
