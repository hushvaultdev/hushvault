'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

import { DashboardShell } from '@/components/shell/dashboard-shell'
import { useAuth } from '@/lib/auth-context'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated, ready } = useAuth()

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

  return <DashboardShell>{children}</DashboardShell>
}
