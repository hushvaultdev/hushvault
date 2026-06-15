'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Field } from '@/components/ui/field'
import { Section } from '@/components/ui/section'
import { ApiError, API_BASE } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'

import styles from '../auth.module.css'

const s = (name: string) => styles[name]

export default function SignUpPage() {
  const router = useRouter()
  const { register } = useAuth()
  const [email, setEmail] = useState('')
  const [organisationName, setOrganisationName] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await register(email, password, organisationName)
      router.push('/dashboard')
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
          <span className="eyebrow">Get started</span>
          <h1>Create your HushVault account</h1>
          <p className={s('authText')}>
            Start free and keep your secrets secure as your project grows. Sign up with GitHub, Google, or email.
          </p>
          <div className={s('authActions')}>
            <Button href={`${API_BASE}/api/auth/github`} variant="secondary">Continue with GitHub</Button>
            <Button href={`${API_BASE}/api/auth/google`} variant="secondary">Continue with Google</Button>
          </div>
          <div className={s('divider')}>
            <span>or</span>
          </div>
          <form className={s('authForm')} onSubmit={onSubmit}>
            <Field
              label="Email"
              name="email"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
            <Field
              label="Organisation name"
              name="organisationName"
              type="text"
              value={organisationName}
              onChange={setOrganisationName}
              placeholder="Acme Inc"
              required
            />
            <Field
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="At least 12 characters"
              autoComplete="new-password"
              hint="Use at least 12 characters."
              required
            />
            {error ? <p className={s('authError')} role="alert">{error}</p> : null}
            <Button type="submit" variant="primary" loading={submitting}>Create account</Button>
          </form>
          <p className={s('authFooter')}>
            Already have an account? <a href="/sign-in">Sign in</a>.
          </p>
        </Card>
      </Section>
    </main>
  )
}
