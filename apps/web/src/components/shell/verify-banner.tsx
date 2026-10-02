'use client'

import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { ApiError, apiFetch } from '@/lib/api'
import { useAuth } from '@/lib/auth-context'

import styles from './dashboard-shell.module.css'

const s = (name: string) => styles[name]

// Shown while the signed-in user's email is known to be unverified.
export function VerifyBanner() {
  const { session } = useAuth()
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState<string | null>(null)

  if (session?.emailVerified !== false) return null

  async function resend() {
    setStatus('sending')
    setError(null)
    try {
      await apiFetch('/api/auth/verify-email/send', { method: 'POST' })
      setStatus('sent')
    } catch (err) {
      setStatus('idle')
      setError(err instanceof ApiError ? err.message : 'Could not send the email. Please try again.')
    }
  }

  return (
    <div className={s('verifyBanner')} role="status">
      <span>
        {status === 'sent'
          ? 'Verification email sent. Check your inbox (and spam folder).'
          : 'Please verify your email address. We sent you a link when you signed up.'}
      </span>
      {error ? <span role="alert">{error}</span> : null}
      {status !== 'sent' ? (
        <Button variant="secondary" size="sm" onClick={resend} loading={status === 'sending'}>Resend email</Button>
      ) : null}
    </div>
  )
}
