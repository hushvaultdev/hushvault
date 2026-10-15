import { Badge } from '@hushvault/web-kit/ui'
import { Button } from '@hushvault/web-kit/ui'

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
          Start with the current installation notes, then review the encryption and deployment details. HushVault is pre-release and the setup material is still being made portable.
        </p>
        <div className={styles['notice']}>
          <Badge tone="warning">Pre-release</Badge>
          <p>HushVault is not production-ready and has not had an independent security audit. The current deployment guide references project-specific settings; review it before use.</p>
        </div>
      </section>

      <section className={styles['cards']}>
        <article className={styles['card']}>
          <h2>Quick start</h2>
          <p>Review the current README for prerequisites, local development, and the HushVault CLI workflow.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault#local-development" rel="noreferrer">Read the project README</a>
        </article>

        <article className={styles['card']}>
          <h2>Encryption & key rotation</h2>
          <p>Read how HushVault uses envelope encryption, and how master-key rotation works as a versioned key ring with a scheduled re-wrap.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault/blob/main/docs/ENCRYPTION.md" rel="noreferrer">Encryption design</a>
        </article>

        <article className={styles['card']}>
          <h2>Self-hosting</h2>
          <p>HushVault uses Cloudflare Workers, D1, and KV. Current deployment notes contain project-specific hostnames and resource IDs, so they are reference material rather than a portable recipe. Costs depend on your Cloudflare account and usage.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault#self-host-on-cloudflare-free" rel="noreferrer">Review current self-hosting notes</a>
        </article>
      </section>

      <section id="self-hosting" className={styles['selfHosting']}>
        <div>
          <span className="eyebrow">Self-hosting status</span>
          <h2>A portable setup guide is still being verified.</h2>
          <p>
            The published deployment notes were written for HushVault’s own Cloudflare account. They include pre-created resource identifiers and hostnames; do not copy them as a third-party deployment recipe. A portable guide and clean-account verification are tracked in the project roadmap.
          </p>
          <p>
            A self-hosted deployment requires an operator-managed master encryption key. The server uses that key to decrypt stored secrets. Review key backup, recovery, Cloudflare service limits, and your expected costs before experimenting.
          </p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault/blob/main/docs/DEPLOYMENT.md" rel="noreferrer">Read deployment reference</a>
        </div>
        <Button href="/security" variant="secondary">Review the security model</Button>
      </section>
    </main>
  )
}
