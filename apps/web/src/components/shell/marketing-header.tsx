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

        <nav className={s('nav')} aria-label="Primary navigation">
          <a href="#workflows">Product</a>
          <a href="#pricing">Pricing</a>
          <a href="/faq">FAQ</a>
          <a href="/docs">Docs</a>
          <a href="#trust">Security</a>
        </nav>

        <div className={s('actions')}>
          <Button href="/sign-in" variant="ghost">Sign In</Button>
          <Button href="#pricing" variant="primary">Start Free</Button>
        </div>
      </div>
    </header>
  )
}