'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { useAuth } from '@/lib/auth-context'
import type { Role } from '@/lib/types'

const ERROR_MESSAGES: Record<string, string> = {
  github_denied: 'GitHub sign-in was cancelled.',
  google_denied: 'Google sign-in was cancelled.',
  invalid_state: 'The sign-in request expired or was invalid. Please try again.',
  exchange_failed: 'Could not complete sign-in. Please try again.',
  no_verified_email: 'No verified email was available from your account.',
  membership_missing: 'Your account has no workspace. Please contact support.',
}

const VALID_ROLES: readonly Role[] = ['owner', 'admin', 'member', 'viewer']

export default function AuthCallbackPage() {
  const router = useRouter()
  const { applySession } = useAuth()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // The API delivers the session in the URL fragment so it never hits a server
    // log or the Referer header. Fragment: #token=…&userId=…&orgId=…&role=…
    const hash = window.location.hash.replace(/^#/, '')
    const params = new URLSearchParams(hash)

    const oauthError = params.get('error')
    if (oauthError) {
      setError(ERROR_MESSAGES[oauthError] ?? 'Sign-in failed. Please try again.')
      return
    }

    const token = params.get('token')
    const userId = params.get('userId')
    const orgId = params.get('orgId')
    const role = params.get('role')

    if (token && userId && orgId && role && (VALID_ROLES as readonly string[]).includes(role)) {
      applySession({ token, userId, orgId, role: role as Role })
      // Clear the fragment so the token isn't left in the address bar/history.
      window.history.replaceState(null, '', window.location.pathname)
      router.replace('/dashboard')
    } else {
      setError('Sign-in failed. Please try again.')
    }
  }, [applySession, router])

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, textAlign: 'center' }}>
      <div>
        {error ? (
          <>
            <h1 style={{ fontSize: '1.4rem', margin: '0 0 12px' }}>Sign-in failed</h1>
            <p style={{ color: 'var(--text-muted)', margin: '0 0 16px' }} role="alert">{error}</p>
            <a href="/sign-in" style={{ color: 'var(--accent-strong)', fontWeight: 600 }}>Back to sign in</a>
          </>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>Signing you in…</p>
        )}
      </div>
    </main>
  )
}
