import Link from 'next/link'
import styles from './page.module.css'

export const metadata = {
  title: 'Docs | HushVault',
  description: 'Documentation links and quick start guides for HushVault.',
}

export default function DocsPage() {
  return (
    <main className={styles['container']}>
      <section className={styles['hero']}>
        <p className={styles['breadcrumb']}>Documentation</p>
        <h1 className={styles['heading']}>HushVault Docs</h1>
        <p className={styles['description']}>
          Find the most important guides for installing, self-hosting, and securing HushVault.
        </p>
      </section>

      <section className={styles['cards']}>
        <article className={styles['card']}>
          <h2>Quick start</h2>
          <p>Install the CLI, log in, initialize your project, and start setting secrets immediately.</p>
          <Link className={styles['link']} href="/">Getting started</Link>
        </article>

        <article className={styles['card']}>
          <h2>Encryption & key rotation</h2>
          <p>Read how HushVault uses envelope encryption and how to rotate your master key safely.</p>
          <Link className={styles['link']} href="/faq">Encryption FAQ</Link>
        </article>

        <article className={styles['card']}>
          <h2>Self-hosting</h2>
          <p>Deploy HushVault to Cloudflare Workers, D1, and KV with zero cost for small teams.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault#self-host-on-cloudflare-free" rel="noreferrer">Deployment docs</a>
        </article>
      </section>
    </main>
  )
}
