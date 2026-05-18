import Link from 'next/link'
import styles from './page.module.css'

export const metadata = {
  title: 'FAQ | HushVault',
  description: 'Frequently asked questions about HushVault, self-hosting, and key rotation.',
}

export default function FAQPage() {
  return (
    <main className={styles['container']}>
      <section className={styles['hero']}>
        <p className={styles['breadcrumb']}>FAQ</p>
        <h1 className={styles['heading']}>Frequently asked questions</h1>
        <p className={styles['description']}>
          Answers for teams self-hosting HushVault, rotating encryption keys, and getting started.
        </p>
      </section>

      <section className={styles['grid']}>
        <article className={styles['card']}>
          <h2>How did HushVault start?</h2>
          <p>
            HushVault began as a response to high-cost secrets managers and incomplete open-source tools. It was built to deliver business-safe features like computed secrets,
            branch inheritance, and encrypted share links without forcing teams onto expensive hosted plans.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>How do I use it?</h2>
          <p>
            Install the CLI, login, initialize a project, then add secrets with `hushvault set`.
            Use `hushvault run` or GitHub Actions to inject secrets into your workflows.
          </p>
          <Link className={styles['link']} href="/docs">Read the docs for setup examples.</Link>
        </article>

        <article className={styles['card']}>
          <h2>Can I self-host it for free?</h2>
          <p>
            Yes. HushVault is designed to run on Cloudflare Workers, D1, KV, and Pages, which can all fit inside the Cloudflare free tier for a small team or MVP.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>What happens when I rotate the master key?</h2>
          <p>
            Only the data encryption keys (DEKs) are re-wrapped with the new master key. Secret ciphertext in KV remains untouched, so rotation is fast and safe.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>How do API tokens rotate?</h2>
          <p>
            For CLI tokens or automation secrets, generate a new token, replace the value in the consuming environment, and revoke the old value.
            HushVault itself stores encrypted secret material separately from API authentication tokens.
          </p>
        </article>

        <article className={styles['card']}>
          <h2>What makes HushVault secure?</h2>
          <p>
            Secrets are never stored in plaintext. Metadata lives in D1, while encrypted blobs live in KV. The app uses envelope encryption and WebCrypto to keep secrets protected.
          </p>
        </article>
      </section>
    </main>
  )
}
