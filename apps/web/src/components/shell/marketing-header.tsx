'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@hushvault/web-kit/ui'

import styles from './marketing-shell.module.css'

const s = (name: string) => styles[name]

export function MarketingHeader() {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuButtonRef = useRef<HTMLButtonElement>(null)
  const navigationRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (menuOpen) navigationRef.current?.querySelector<HTMLAnchorElement>('a')?.focus()
  }, [menuOpen])

  function closeMenu() {
    setMenuOpen(false)
  }

  return (
    <header className={s('headerWrap')}>
      <div className={`${s('header')} page-container`}>
        <Link href="/" className={s('brand')} onClick={closeMenu}>
          <span className={s('brandMark')}>H</span>
          <span className={s('brandCopy')}>
            <strong>HushVault</strong>
            <span>Secrets, under control</span>
          </span>
        </Link>

        <nav
          ref={navigationRef}
          id="marketing-navigation"
          className={`${s('nav')} ${menuOpen ? s('navOpen') : ''}`}
          aria-label="Primary navigation"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setMenuOpen(false)
              menuButtonRef.current?.focus()
            }
          }}
        >
          <Link href="/#workflows" onClick={closeMenu}>Product</Link>
          <Link href="/security" onClick={closeMenu}>Security</Link>
          <Link href="/pricing" onClick={closeMenu}>Pricing</Link>
          <Link href="/docs" onClick={closeMenu}>Docs</Link>
          <Link className={s('mobileSignIn')} href="/sign-in" onClick={closeMenu}>Sign in</Link>
        </nav>

        <div className={s('actions')}>
          <Button href="/sign-in" variant="ghost">Sign in</Button>
          <Button href="/docs" variant="primary">Read the self-host guide</Button>
        </div>

        <button
          type="button"
          ref={menuButtonRef}
          className={s('menuToggle')}
          aria-controls="marketing-navigation"
          aria-expanded={menuOpen}
          aria-label={menuOpen ? 'Close navigation menu' : 'Open navigation menu'}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span aria-hidden="true">{menuOpen ? '×' : '☰'}</span>
          <span>{menuOpen ? 'Close' : 'Menu'}</span>
        </button>
      </div>
    </header>
  )
}
