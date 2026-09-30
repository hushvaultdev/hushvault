import Link from 'next/link'
import styles from './page.module.css'

export const metadata = {
  title: 'FAQ | HushVault',
  description: 'Frequently asked questions about HushVault, self-hosting, and encryption.',
}

export default function FAQPage() {
  return (
    <main className={styles['container']}>
      <section className={styles['hero']}>
        <p className={styles['breadcrumb']}>FAQ</p>
        <h1 className={styles['heading']}>Frequently asked questions</h1>
        <p className={styles['description']}>
          Answers for teams self-hosting HushVault, understanding its encryption design, and getting started.
        </p>
      </section>

      <section className={styles['grid']}>
        <article className={styles['card']}>
          <h2>How did HushVault start?</h2>
          <p>
            HushVault began as a response to high-cost secrets managers and incomplete open-source tools. It aims to deliver workflow features like computed secrets,
            branch inheritance, and one-time share links without forcing teams onto expensive hosted plans.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>How do I use it?</h2>
          <p>
            Install the CLI, login, initialize a project, then add secrets with `hushvault set`.
            Use `hushvault run` to inject secrets into any command. A GitHub Actions integration is planned but not available yet.
          </p>
          <Link className={styles['link']} href="/docs">Read the docs for setup examples.</Link>
        </article>

        <article className={styles['card']}>
          <h2>Can I self-host it for free?</h2>
          <p>
            Yes. HushVault is designed to run on Cloudflare Workers, D1, KV, and Pages, which can fit inside the Cloudflare free tier for a small team or MVP. HushVault is pre-release software, so review the code and your threat model before relying on it in production.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>How does master key rotation work?</h2>
          <p>
            Envelope encryption is designed so that rotating the master key only requires re-wrapping the data encryption keys (DEKs); secret ciphertext in KV does not need to be re-encrypted. Automated rotation tooling is planned and is not available yet.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>How do API tokens rotate?</h2>
          <p>
            Create a new API key, replace the value in the consuming environment, and revoke the old key. Keys can be created and revoked through the API.
            HushVault stores encrypted secret material separately from API authentication keys.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>What makes HushVault secure?</h2>
          <p>
            Secret values are never stored in plaintext. Metadata lives in D1, while encrypted blobs live in KV. The app uses AES-256-GCM envelope encryption via WebCrypto. HushVault has not had an independent security audit or compliance certification.
          </p>
        </article>
      </section>
    </main>
  )
}
