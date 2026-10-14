'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button, Card, Field } from '@hushvault/web-kit/ui'

import { ApiError } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'

import styles from '../admin.module.css'

const s = (name: string) => styles[name]

export default function SignInPage() {
  const router = useRouter()
  const { login, isAuthenticated, ready, notAdmin } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (ready && isAuthenticated) router.replace('/')
  }, [ready, isAuthenticated, router])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      await login(email, password)
      router.push('/')
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className={s('authPage')}>
      <Card className={s('authCard')} tone="light">
        <span className="eyebrow">Platform administration</span>
        <h1>Sign in</h1>
        <p className={s('muted')}>Use the account that has been granted platform admin access.</p>
        <form className={s('authForm')} onSubmit={onSubmit}>
          <Field label="Email" name="email" type="email" value={email} onChange={setEmail} autoComplete="email" required />
          <Field label="Password" name="password" type="password" value={password} onChange={setPassword} autoComplete="current-password" required />
          {error ? <p className={s('error')} role="alert">{error}</p> : null}
          {notAdmin && !error ? <p className={s('error')} role="alert">This account is not a platform administrator.</p> : null}
          <Button type="submit" variant="primary" loading={submitting}>Sign in</Button>
        </form>
      </Card>
    </main>
  )
}
