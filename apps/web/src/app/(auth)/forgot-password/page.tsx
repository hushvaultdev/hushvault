'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Section } from '@/components/ui/section'
import { ApiError, apiFetch } from '@/lib/api'

import styles from '../auth.module.css'

const s = (name: string) => styles[name]

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [sent, setSent] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await apiFetch('/api/auth/forgot-password', { method: 'POST', auth: false, body: { email } })
      setSent(true)
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
          <h1>Reset your password</h1>
          {sent ? (
            <p className={s('authText')} role="status">
              If an account exists for that address, a reset link is on its way. It expires in 60 minutes.
            </p>
          ) : (
            <>
              <p className={s('authText')}>Enter your email and we will send you a link to choose a new password.</p>
              <form className={s('authForm')} onSubmit={onSubmit}>
                <Field label="Email" name="email" type="email" value={email} onChange={setEmail}
                  placeholder="you@example.com" autoComplete="email" required />
                {error ? <p className={s('authError')} role="alert">{error}</p> : null}
                <Button type="submit" variant="primary" loading={submitting}>Send reset link</Button>
              </form>
            </>
          )}
          <p className={s('authFooter')}>
            <a href="/sign-in">Back to sign in</a>
          </p>
        </Card>
      </Section>
    </main>
  )
}
