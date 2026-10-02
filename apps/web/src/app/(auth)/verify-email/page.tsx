'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Section } from '@/components/ui/section'
import { ApiError, apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'

import styles from '../auth.module.css'

const s = (name: string) => styles[name]

export default function VerifyEmailPage() {
  const { markEmailVerified } = useAuth()
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')
    setToken(value)
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  // Explicit click: mail scanners that prefetch the link must not consume the token.
  async function onConfirm() {
    if (!token) return
    setError(null)
    setSubmitting(true)
    try {
      await apiFetch('/api/auth/verify-email', { method: 'POST', auth: false, body: { token } })
      markEmailVerified()
      setDone(true)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className={s('authPage')}>
      <Section className={s('authSection')}>
        <Card className={s('authCard')} tone="light">
          <span className="eyebrow">Email verification</span>
          <h1>Confirm your email</h1>
          {done ? (
            <p className={s('authText')} role="status">
              Your email is verified. <a href="/dashboard">Continue to the dashboard</a>.
            </p>
          ) : token === null ? (
            <p className={s('authError')} role="alert">
              This verification link is missing or incomplete. Sign in and use “Resend” in the dashboard banner.
            </p>
          ) : (
            <>
              <p className={s('authText')}>Confirm that this address belongs to you.</p>
              {error ? <p className={s('authError')} role="alert">{error} Sign in and resend the email.</p> : null}
              <Button variant="primary" onClick={onConfirm} loading={submitting}>Confirm email</Button>
            </>
          )}
        </Card>
      </Section>
    </main>
  )
}
