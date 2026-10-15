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
  const { isAuthenticated, ready, checkFailed, logout, retryCheck } = useAuth()

  useEffect(() => {
    if (ready && !isAuthenticated && !checkFailed) router.replace('/sign-in')
  }, [ready, isAuthenticated, checkFailed, router])

  if (!ready) {
    return (
      <main className={s('status')} role="status" aria-live="polite">
        Restoring your session…
      </main>
    )
  }
  // The cold-load admin check could not reach a verdict (transient 5xx / network blip). The
  // session is still intact; offer a retry rather than silently signing the user out (issue #111).
  if (checkFailed) {
    return (
      <main className={s('status')} role="alert">
        <p>Could not confirm your access. The service may be briefly unavailable.</p>
        <div className={s('actions')}>
          <Button variant="primary" size="sm" onClick={retryCheck}>Try again</Button>
          <Button variant="secondary" size="sm" onClick={() => { logout(); router.replace('/sign-in') }}>Sign out</Button>
        </div>
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
