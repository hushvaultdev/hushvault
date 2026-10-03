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
          Find the most important guides for installing, self-hosting, and securing HushVault. The project is pre-release and these docs are still evolving.
        </p>
      </section>

      <section className={styles['cards']}>
        <article className={styles['card']}>
          <h2>Quick start</h2>
          <p>Install the CLI, log in, initialize your project, and start setting secrets immediately.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault#local-development" rel="noreferrer">Getting started</a>
        </article>

        <article className={styles['card']}>
          <h2>Encryption & key rotation</h2>
          <p>Read how HushVault uses envelope encryption, and how master-key rotation works as a versioned key ring with a scheduled re-wrap.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault/blob/main/docs/ENCRYPTION.md" rel="noreferrer">Encryption design</a>
        </article>

        <article className={styles['card']}>
          <h2>Self-hosting</h2>
          <p>Deploy HushVault to Cloudflare Workers, D1, and KV on the Cloudflare free tier. See the README for the current status.</p>
          <a className={styles['link']} href="https://github.com/hushvaultdev/hushvault#self-host-on-cloudflare-free" rel="noreferrer">Deployment docs</a>
        </article>
      </section>
    </main>
  )
}
