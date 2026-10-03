'use client'

import { useEffect } from 'react'

/**
 * App-level recovery. Without this, any uncaught client error drops the user to Next's bare
 * "Application error: a client-side exception has occurred" with no way back.
 *
 * The error message is deliberately not rendered: on a secrets dashboard an exception string can
 * carry request detail, and there is nothing a reader could do with it anyway. The digest is
 * enough to correlate with the Worker's logs.
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('dashboard error', error.digest ?? 'no-digest')
  }, [error])

  return (
    <main style={{ minHeight: '60vh', display: 'grid', placeItems: 'center', padding: '24px 16px' }}>
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.25rem', marginBottom: 8 }}>Something went wrong</h1>
        <p style={{ color: 'var(--muted, #6b7280)', marginBottom: 16 }}>
          This page failed to load. Your secrets are unaffected.
          {error.digest ? <> Reference: <code>{error.digest}</code></> : null}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{ padding: '10px 16px', borderRadius: 8, border: '1px solid var(--border, #e5e7eb)', cursor: 'pointer' }}
        >
          Try again
        </button>
      </div>
    </main>
  )
}
