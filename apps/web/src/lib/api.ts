import { ApiError, createApiClient } from '@hushvault/web-kit/client'

import { sessionStore } from './auth-storage'
import type { Session } from './types'

// Base URL of the HushVault API. Defaults to the local wrangler dev server;
// override with NEXT_PUBLIC_API_URL for staging/production builds.
export const API_BASE = (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:8787').replace(/\/$/, '')

export { ApiError }

// The refresh, retry and error handling are the shared client's (packages/web-kit); this binds it to the
// dashboard: its API origin, its Session shape and the one dashboard-only reaction to an API error.
const client = createApiClient<Session>({
  apiBase: API_BASE,
  clientName: 'web',
  store: sessionStore,
  sessionFromRefresh: (data) => {
    if (typeof data['token'] !== 'string' || typeof data['userId'] !== 'string' || typeof data['orgId'] !== 'string') return null
    return {
      token: data['token'],
      userId: data['userId'],
      orgId: data['orgId'],
      role: data['role'] as Session['role'],
      emailVerified: data['emailVerified'] as boolean | undefined,
    }
  },
  // Non-secret diagnostics: the API names why a refresh failed (no_cookie, expired, unknown, ...).
  onRefreshFailure: (status, reason) => console.warn('[hushvault] session refresh failed', status, reason ?? ''),
  // The org this token acts in is no longer one the caller is a member of. Every org-scoped
  // list on the page would be empty or belong to nobody, so go to organisation selection
  // rather than render a signed-in dashboard for an org the user cannot see. This is not a
  // sign-out: the session is still valid for the user's other organisations.
  onApiError: ({ code, authenticated }) => {
    if (
      authenticated &&
      (code === 'NOT_A_MEMBER' || code === 'MEMBERSHIP_REVOKED') &&
      typeof window !== 'undefined' &&
      !window.location.pathname.startsWith('/organisations')
    ) {
      window.location.assign(`/organisations?reason=${code}`)
    }
  },
})

export const { apiFetch, refreshSession, endSession } = client
