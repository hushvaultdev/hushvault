import Link from 'next/link'

import { Badge } from '@hushvault/web-kit/ui'

import styles from './page.module.css'

export const metadata = {
  title: 'Security | HushVault',
  description: 'Understand HushVault encryption, key custody, and pre-release limitations.',
}

const s = (name: string) => styles[name]

export default function SecurityPage() {
  return (
    <main className={s('page')}>
      <div className="page-container">
        <header className={s('hero')}>
          <Badge tone="warning">Pre-release · unaudited</Badge>
          <h1>Security starts with a clear trust boundary.</h1>
          <p>Read what HushVault encrypts, where the keys live, and what has not been independently verified.</p>
          <p className={s('notice')}>
            HushVault is not production-ready and has not had an independent security audit. Review the implementation and your threat model before storing sensitive values.
          </p>
        </header>

        <section className={s('sections')} aria-label="Security model">
          <article className={s('section')}>
            <span className={s('index')}>01 / ENCRYPTION</span>
            <h2>Stored values are encrypted at rest.</h2>
            <p>HushVault uses AES-256-GCM envelope encryption. A data encryption key encrypts each secret value; a deployment master key wraps those data keys.</p>
            <Link href="https://github.com/hushvaultdev/hushvault/blob/main/docs/ENCRYPTION.md" className={s('link')}>Read the encryption design <span aria-hidden="true">→</span></Link>
          </article>
          <article className={s('section')}>
            <span className={s('index')}>02 / KEY CUSTODY</span>
            <h2>The server holds the master key.</h2>
            <p>The server decrypts stored secrets when it needs to serve them. HushVault is therefore not zero-knowledge for stored secrets. This supports CLI retrieval and sync, and places the deployment in the trust boundary.</p>
            <Link href="https://github.com/hushvaultdev/hushvault/blob/main/docs/ARCHITECTURE.md" className={s('link')}>Read the architecture <span aria-hidden="true">→</span></Link>
          </article>
          <article className={s('section')}>
            <span className={s('index')}>03 / SHARE LINKS</span>
            <h2>Share links use a different model.</h2>
            <p>The link secret is encrypted in the creator’s browser and decrypted in the recipient’s browser. The server does not receive the share key.</p>
            <Link href="https://github.com/hushvaultdev/hushvault/blob/main/docs/ARCHITECTURE.md" className={s('link')}>Review the share-link flow <span aria-hidden="true">→</span></Link>
          </article>
          <article className={s('section')}>
            <span className={s('index')}>04 / DEPLOYMENT</span>
            <h2>Self-hosting still needs operator review.</h2>
            <p>The current deployment notes include project-specific hostnames and resource identifiers. They are reference material, not yet a verified, portable recipe. Cloudflare costs depend on your account and usage.</p>
            <Link href="/docs#self-hosting" className={s('link')}>Read current self-hosting status <span aria-hidden="true">→</span></Link>
          </article>
        </section>

        <section className={s('references')}>
          <h2>Security references</h2>
          <ul>
            <li><Link href="https://github.com/hushvaultdev/hushvault/blob/main/README.md#status">Current product status and limitations</Link></li>
            <li><Link href="https://github.com/hushvaultdev/hushvault/blob/main/docs/ENCRYPTION.md">Encryption and key rotation</Link></li>
            <li><Link href="https://github.com/hushvaultdev/hushvault/blob/main/docs/OPERATIONS.md">Operational guidance</Link></li>
          </ul>
        </section>
      </div>
    </main>
  )
}
