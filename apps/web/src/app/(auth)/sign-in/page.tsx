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

export default function SignInPage() {
  const router = useRouter()
  const { login } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
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
          <span className="eyebrow">Welcome back</span>
          <h1>Sign in to HushVault</h1>
          <p className={s('authText')}>
            Use GitHub or Google to sign in quickly, or continue with email and password if preferred.
          </p>
          <div className={s('authActions')}>
            <Button href={`${API_BASE}/api/auth/github`} variant="secondary">Continue with GitHub</Button>
            <Button href="#" variant="secondary">Continue with Google</Button>
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
              label="Password"
              name="password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••"
              autoComplete="current-password"
              required
            />
            {error ? <p className={s('authError')} role="alert">{error}</p> : null}
            <Button type="submit" variant="primary" loading={submitting}>Sign In</Button>
          </form>
          <p className={s('authFooter')}>
            New to HushVault? <a href="/sign-up">Create an account</a>.
          </p>
        </Card>
      </Section>
    </main>
  )
}
