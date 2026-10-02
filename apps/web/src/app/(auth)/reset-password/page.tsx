'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Section } from '@/components/ui/section'
import { ApiError, apiFetch } from '@/lib/api'

import styles from '../auth.module.css'

const s = (name: string) => styles[name]

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)

  useEffect(() => {
    // The token lives in the URL fragment (never sent to servers or Referer); keep it in memory only.
    const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token')
    setToken(value)
    window.history.replaceState(null, '', window.location.pathname)
  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!token) return
    setError(null)
    setSubmitting(true)
    try {
      await apiFetch('/api/auth/reset-password', { method: 'POST', auth: false, body: { token, password } })
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
          <span className="eyebrow">Account recovery</span>
          <h1>Choose a new password</h1>
          {done ? (
            <p className={s('authText')} role="status">
              Your password was changed and all other sessions were signed out. <a href="/sign-in">Sign in</a>.
            </p>
          ) : token === null ? (
            <p className={s('authError')} role="alert">
              This reset link is missing or incomplete. <a href="/forgot-password">Request a new one</a>.
            </p>
          ) : (
            <form className={s('authForm')} onSubmit={onSubmit}>
              <Field label="New password" name="password" type="password" value={password} onChange={setPassword}
                placeholder="At least 12 characters" autoComplete="new-password" hint="Use at least 12 characters." required />
              {error ? (
                <p className={s('authError')} role="alert">
                  {error} <a href="/forgot-password">Request a new link</a>.
                </p>
              ) : null}
              <Button type="submit" variant="primary" loading={submitting}>Change password</Button>
            </form>
          )}
        </Card>
      </Section>
    </main>
  )
}
