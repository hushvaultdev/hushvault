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

  if (!ready || !isAuthenticated) {
    return null
  }

  return <DashboardShell>{children}</DashboardShell>
}
