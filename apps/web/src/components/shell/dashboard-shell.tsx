'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@hushvault/web-kit/ui'
import { useAuth } from '@/lib/auth-context'

import { OrgSwitcher } from './org-switcher'
import { VerifyBanner } from './verify-banner'

import styles from './dashboard-shell.module.css'

const s = (name: string) => styles[name]

const navItems: ReadonlyArray<{ href: string; label: string; alsoActiveFor?: readonly string[] }> = [
  { href: '/dashboard', label: 'Projects', alsoActiveFor: ['/projects'] },
  { href: '/onboarding', label: 'Get started' },
  { href: '/integrations', label: 'Integrations' },
  { href: '/members', label: 'Members' },
  { href: '/audit', label: 'Audit log' },
  { href: '/billing', label: 'Billing' },
]

function isActive(pathname: string, href: string, alsoActiveFor?: readonly string[]): boolean {
  const prefixes = [href, ...(alsoActiveFor ?? [])]
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { logout } = useAuth()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (mobileNavOpen) sidebarRef.current?.querySelector<HTMLAnchorElement>('nav a')?.focus()
  }, [mobileNavOpen])

  return (
    <div className={s('shell')}>
      <button
        type="button"
        className={`${s('navOverlay')} ${mobileNavOpen ? s('navOverlayOpen') : ''}`.trim()}
        aria-label="Close navigation menu"
        tabIndex={mobileNavOpen ? 0 : -1}
        onClick={() => setMobileNavOpen(false)}
      />
      <aside
        ref={sidebarRef}
        className={`${s('sidebar')} ${mobileNavOpen ? s('sidebarOpen') : ''}`.trim()}
        role={mobileNavOpen ? 'dialog' : undefined}
        aria-label={mobileNavOpen ? 'Dashboard navigation menu' : undefined}
        aria-modal={mobileNavOpen || undefined}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && mobileNavOpen) {
            setMobileNavOpen(false)
            menuButtonRef.current?.focus()
            return
          }
          if (event.key === 'Tab' && mobileNavOpen && sidebarRef.current) {
            const links = sidebarRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
            const first = links.item(0)
            const last = links.item(links.length - 1)
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault()
              last?.focus()
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault()
              first?.focus()
            }
          }
        }}
      >
        <Link href="/dashboard" className={s('brand')} onClick={() => setMobileNavOpen(false)}>
          <span className={s('brandMark')}>H</span>
          <span className={s('brandName')}>HushVault</span>
        </Link>
        <nav id="dashboard-navigation" className={s('nav')} aria-label="Dashboard navigation">
          {navItems.map((item) => {
            const active = isActive(pathname, item.href, item.alsoActiveFor)
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`${s('navItem')} ${active ? s('navItemActive') : ''}`.trim()}
                aria-current={active ? 'page' : undefined}
                onClick={() => setMobileNavOpen(false)}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
      </aside>
      <div className={s('main')}>
        <header className={s('topbar')}>
          {/* The organisation in play is never implied: it is named here on every dashboard page,
              and the name comes from the org the access token acts in. */}
          <button
            type="button"
            ref={menuButtonRef}
            className={s('mobileMenuToggle')}
            aria-controls="dashboard-navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen((open) => !open)}
          >
            <span aria-hidden="true">{mobileNavOpen ? '×' : '☰'}</span>
            <span>{mobileNavOpen ? 'Close' : 'Menu'}</span>
          </button>
          <OrgSwitcher />
          <div className={s('topbarActions')}>
            <Button variant="ghost" onClick={logout}>Sign out</Button>
          </div>
        </header>
        <main className={s('content')}>
          <VerifyBanner />
          {children}
        </main>
      </div>
    </div>
  )
}
