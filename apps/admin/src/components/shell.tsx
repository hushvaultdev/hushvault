'use client'

import { Button } from '@hushvault/web-kit/ui'

import { useAuth } from '@/lib/auth-context'

import styles from '../app/admin.module.css'

const s = (name: string) => styles[name]

export function Shell({ children }: { children: React.ReactNode }) {
  const { isAdmin, ready, checkFailed, notAdmin, retryCheck, signOut } = useAuth()

  if (!ready) {
    return (
      <main className={s('status')} role="status" aria-live="polite">
        Checking your access…
      </main>
    )
  }

  if (checkFailed) {
    return (
      <main className={s('status')} role="alert">
        <p>Could not confirm your access. The service may be briefly unavailable.</p>
        <div className={s('actions')}>
          <Button variant="primary" size="sm" onClick={retryCheck}>Try again</Button>
          <Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </main>
    )
  }

  if (notAdmin) {
    return (
      <main className={s('status')} role="alert">
        <p>This account is not a platform administrator.</p>
        <div className={s('actions')}>
          <Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button>
        </div>
      </main>
    )
  }

  if (!isAdmin) return null

  return (
    <div className={s('shell')}>
      <header className={s('topbar')}>
        <div className={s('brand')}>HushVault Admin</div>
        <Button variant="secondary" size="sm" onClick={signOut}>Sign out</Button>
      </header>
      <main>{children}</main>
    </div>
  )
}
