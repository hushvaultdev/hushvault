'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth-context'

import styles from './dashboard-shell.module.css'

const s = (name: string) => styles[name]

const navItems: ReadonlyArray<{ href: string; label: string; alsoActiveFor?: readonly string[] }> = [
  { href: '/dashboard', label: 'Projects', alsoActiveFor: ['/projects'] },
  { href: '/onboarding', label: 'Get started' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/audit', label: 'Audit log' },
  { href: '/billing', label: 'Billing' },
]

function isActive(pathname: string, href: string, alsoActiveFor?: readonly string[]): boolean {
  const prefixes = [href, ...(alsoActiveFor ?? [])]
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { session, logout } = useAuth()

  return (
    <div className={s('shell')}>
      <aside className={s('sidebar')}>
        <Link href="/dashboard" className={s('brand')}>
          <span className={s('brandMark')}>H</span>
          <strong>HushVault</strong>
        </Link>
        <nav className={s('nav')} aria-label="Dashboard navigation">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href, item.alsoActiveFor)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${s('navItem')} ${active ? s('navItemActive') : ''}`.trim()}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <div className={s('main')}>
        <header className={s('topbar')}>
          <span className={s('orgBadge')}>{session?.orgId ?? 'Workspace'}</span>
          <div className={s('topbarActions')}>
            <span className={s('role')}>{session?.role}</span>
            <Button variant="ghost" onClick={logout}>Sign out</Button>
          </div>
        </header>
        <main className={s('content')}>{children}</main>
      </div>
    </div>
  )
}
