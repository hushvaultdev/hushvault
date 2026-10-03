import Link from 'next/link'

import { Button } from '@/components/ui/button'

import styles from './marketing-shell.module.css'

const s = (name: string) => styles[name]

export function MarketingHeader() {
  return (
    <header className={s('headerWrap')}>
      <div className={`${s('header')} page-container`}>
        <Link href="/" className={s('brand')}>
          <span className={s('brandMark')}>H</span>
          <div>
            <strong>HushVault</strong>
            <span>Edge-native secrets</span>
          </div>
        </Link>

        {/*
          Root-relative, not bare fragments. `#workflows` and `#trust` only exist on the home
          page, so on /faq, /docs and /pricing these links — and the primary call to action —
          did nothing at all. Pricing now points at the real /pricing route, which the nav
          never linked to.
        */}
        <nav className={s('nav')} aria-label="Primary navigation">
          <Link href="/#workflows">Product</Link>
          <Link href="/pricing">Pricing</Link>
          <Link href="/faq">FAQ</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/#trust">Security</Link>
        </nav>

        <div className={s('actions')}>
          <Button href="/sign-in" variant="ghost">Sign In</Button>
          <Button href="/sign-up" variant="primary">Start Free</Button>
        </div>
      </div>
    </header>
  )
}