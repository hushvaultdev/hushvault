'use client'

import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'
import { API_BASE } from '@/lib/api'
import { decryptShare } from '@/lib/share-crypto'

import styles from './share.module.css'

const s = (name: string) => styles[name]

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'missing-key' }
  | { status: 'unavailable' }
  | { status: 'failed' }
  | { status: 'ready'; secret: string }

export function ShareView({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: 'idle' })
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  // The key never leaves the browser: read from the fragment, then stripped from history.
  const keyRef = useRef<string | null>(null)
  // One fetch per page load, whatever happens — a second GET would burn another view.
  const started = useRef(false)

  useEffect(() => {
    const key = window.location.hash.replace(/^#/, '')
    if (key) window.history.replaceState(null, '', window.location.pathname + window.location.search)
    keyRef.current = key || null
    if (!key) setState({ status: 'missing-key' })
  }, [])

  /**
   * Deliberately not on mount.
   *
   * The GET is what consumes the view (the API increments view_count atomically on it), so
   * fetching on mount meant anything that merely *opened* the URL used the link up: a link
   * scanner or mail-security gateway that executes JavaScript, a chat client's preview bot, an
   * accidental reload. The real recipient then saw "unavailable". This is the same reason the
   * email-verification page requires a click before spending its token.
   */
  async function reveal() {
    const key = keyRef.current
    if (!key || started.current) return
    started.current = true
    setState({ status: 'loading' })

    let payload: string
    try {
      const res = await fetch(`${API_BASE}/api/share/${encodeURIComponent(token)}`, {
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      })
      if (!res.ok) {
        setState({ status: 'unavailable' })
        return
      }
      const json: unknown = await res.json()
      const value = (json as { data?: { encryptedPayload?: unknown } } | null)?.data?.encryptedPayload
      if (typeof value !== 'string') {
        setState({ status: 'unavailable' })
        return
      }
      payload = value
    } catch {
      setState({ status: 'unavailable' })
      return
    }

    try {
      setState({ status: 'ready', secret: await decryptShare(payload, key) })
    } catch {
      setState({ status: 'failed' })
    }
  }

  async function copy(secret: string) {
    setCopyError(false)
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      // Blocked on an insecure origin, or clipboard permission denied. Say so: the link may
      // already be used up, so silently doing nothing can cost the recipient the secret.
      setCopied(false)
      setCopyError(true)
      setRevealed(true)
    }
  }

  return (
    <main className={s('page')}>
      <Section className={s('section')}>
        <Card className={s('card')} tone="light">
          <span className="eyebrow">Shared with you</span>
          <h1>Shared secret</h1>

          {state.status === 'idle' && (
            <>
              <p className={s('text')}>
                This link can usually be opened only once. Nothing is fetched until you choose to open it, so a
                preview or a scanner cannot use it up.
              </p>
              <div className={s('actions')}>
                <Button onClick={() => void reveal()}>Open shared secret</Button>
              </div>
            </>
          )}

          {state.status === 'loading' && <p className={s('text')} role="status">Fetching and decrypting in your browser…</p>}

          {state.status === 'missing-key' && (
            <p className={s('error')} role="alert">
              This link is missing its decryption key. Make sure you copied the whole URL, including everything after the #.
            </p>
          )}
          {state.status === 'unavailable' && (
            <p className={s('error')} role="alert">
              This link is unavailable. It may have expired, been revoked, or already been used the maximum number of times.
            </p>
          )}
          {state.status === 'failed' && (
            <p className={s('error')} role="alert">
              Could not decrypt this secret. The key in the link may be wrong or incomplete. Ask the sender for a new link.
            </p>
          )}

          {state.status === 'ready' && (
            <>
              <p className={s('text')}>
                This link may now be used up. Copy the value somewhere safe before leaving this page; reloading may not work.
              </p>
              <pre className={s('secret')} aria-live="polite">
                {revealed ? state.secret : '•'.repeat(Math.min(Math.max(state.secret.length, 8), 40))}
              </pre>
              <div className={s('actions')}>
                <Button variant="secondary" onClick={() => setRevealed((v) => !v)}>
                  {revealed ? 'Hide' : 'Reveal'}
                </Button>
                <Button onClick={() => void copy(state.secret)}>{copied ? 'Copied' : 'Copy'}</Button>
              </div>
              {copyError && (
                <p className={s('error')} role="alert">
                  Could not copy to the clipboard — your browser blocked it. The value is shown above; select and copy it manually.
                </p>
              )}
            </>
          )}
        </Card>
      </Section>
    </main>
  )
}
