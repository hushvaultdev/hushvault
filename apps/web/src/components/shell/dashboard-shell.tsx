'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth-context'

import styles from './dashboard-shell.module.css'

const s = (name: string) => styles[name]

const navItems = [
  { href: '/dashboard', label: 'Projects' },
]

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
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
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
