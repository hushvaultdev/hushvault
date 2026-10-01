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
  | { status: 'loading' }
  | { status: 'missing-key' }
  | { status: 'unavailable' }
  | { status: 'failed' }
  | { status: 'ready'; secret: string }

export function ShareView({ token }: { token: string }) {
  const [state, setState] = useState<State>({ status: 'loading' })
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState(false)
  // Guards against double-invocation (React strict mode): a second GET would burn another view.
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    // The decryption key lives only in the URL fragment. Read it, then strip it from the address bar/history.
    const key = window.location.hash.replace(/^#/, '')
    if (key) window.history.replaceState(null, '', window.location.pathname + window.location.search)
    if (!key) {
      setState({ status: 'missing-key' })
      return
    }

    void (async () => {
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
    })()
  }, [token])

  async function copy(secret: string) {
    try {
      await navigator.clipboard.writeText(secret)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  return (
    <main className={s('page')}>
      <Section className={s('section')}>
        <Card className={s('card')} tone="light">
          <span className="eyebrow">Shared with you</span>
          <h1>Shared secret</h1>
          {state.status === 'loading' && <p className={s('text')} role="status">Fetching and decrypting in your browser…</p>}
          {state.status === 'missing-key' && (
            <p className={s('error')} role="alert">
              This link is missing its decryption key. Make sure you copied the whole URL, including everything after the #.
            </p>
          )}
          {state.status === 'unavailable' && (
            <p className={s('error')} role="alert">
              This link is unavailable. It may have expired or already been used the maximum number of times.
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
            </>
          )}
        </Card>
      </Section>
    </main>
  )
}
