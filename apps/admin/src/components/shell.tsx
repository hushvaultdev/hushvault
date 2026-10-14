'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

import { Button } from '@hushvault/web-kit/ui'

import { useAuth } from '@/lib/auth-context'

import styles from '../app/admin.module.css'

const s = (name: string) => styles[name]

// Wraps every authenticated page. Unauthenticated visitors are sent to /sign-in. The platform-admin
// check itself lives in the auth provider (and, authoritatively, in the API's requirePlatformAdmin);
// this is only the redirect and the page frame.
export function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const { isAuthenticated, ready, logout } = useAuth()

  useEffect(() => {
    if (ready && !isAuthenticated) router.replace('/sign-in')
  }, [ready, isAuthenticated, router])

  if (!ready) {
    return (
      <main className={s('status')} role="status" aria-live="polite">
        Restoring your session…
      </main>
    )
  }
  if (!isAuthenticated) return null

  return (
    <div className={s('shell')}>
      <header className={s('topbar')}>
        <div className={s('brand')}>HushVault Admin</div>
        <Button variant="secondary" size="sm" onClick={() => { logout(); router.replace('/sign-in') }}>Sign out</Button>
      </header>
      <main>{children}</main>
    </div>
  )
}
