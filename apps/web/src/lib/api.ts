import { clearSession, markSessionHint, readSession, writeSession } from './auth-storage'
import type { Session } from './types'

// Base URL of the HushVault API. Defaults to the local wrangler dev server;
// override with NEXT_PUBLIC_API_URL for staging/production builds.
export const API_BASE = (process.env['NEXT_PUBLIC_API_URL'] ?? 'http://127.0.0.1:8787').replace(/\/$/, '')

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  // When false, the request is sent without an Authorization header (login/register).
  auth?: boolean
}

const CLIENT_HEADER = { 'X-HushVault-Client': 'web' }

// Exchange the HttpOnly refresh cookie for a new access token. Concurrent callers share one request;
// a 409 means another tab won the rotation, so retry with the cookie it just set.
let inflightRefresh: Promise<Session | null> | null = null

export function refreshSession(): Promise<Session | null> {
  if (!inflightRefresh) {
    inflightRefresh = doRefresh().finally(() => {
      inflightRefresh = null
    })
  }
  return inflightRefresh
}

async function doRefresh(): Promise<Session | null> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let res: Response
    try {
      res = await fetch(`${API_BASE}/api/auth/refresh`, { method: 'POST', headers: CLIENT_HEADER, credentials: 'include' })
    } catch {
      return null
    }
    if (res.status === 409) {
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
      continue
    }
    if (res.status === 401) {
      // The refresh token is genuinely gone (expired, revoked, reused): this is a sign-out.
      clearSession()
      markSessionHint(false)
      return null
    }
    if (!res.ok) return null // 429/5xx: transient, keep the cookie and the hint so a retry can work
    const payload = (await res.json().catch(() => null)) as { data?: Session & { expiresIn?: number } } | null
    const data = payload?.data
    if (!data?.token) return null
    const next: Session = { token: data.token, userId: data.userId, orgId: data.orgId, role: data.role, emailVerified: data.emailVerified }
    writeSession(next)
    markSessionHint(true)
    return next
  }
  return null
}

/** End the session server-side (revokes the refresh token family), then forget it locally. */
export async function endSession(): Promise<void> {
  try {
    await fetch(`${API_BASE}/api/auth/logout`, { method: 'POST', headers: CLIENT_HEADER, credentials: 'include', keepalive: true })
  } catch {
    // offline: the local session is still cleared below
  }
  clearSession()
  markSessionHint(false)
}

async function send(path: string, method: string, body: unknown, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { ...CLIENT_HEADER }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`
  try {
    return await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: 'include', // the refresh cookie is set/rotated by login and refresh responses
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', `Could not reach the API at ${API_BASE}.`)
  }
}

// Typed fetch wrapper. Unwraps the `{ data }` envelope on success and throws
// an ApiError carrying the API's `{ error, message }` on failure. An expired access
// token is refreshed once transparently; if that fails the user is sent to sign in.
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options
  let sentToken = auth ? (readSession()?.token ?? null) : null
  let res = await send(path, method, body, sentToken)

  if (res.status === 401 && auth && sentToken && typeof window !== 'undefined') {
    // Another request may already have refreshed; only refresh if the token we used is still current.
    const current = readSession()
    const refreshed = current && current.token !== sentToken ? current : await refreshSession()
    if (refreshed) {
      sentToken = refreshed.token
      res = await send(path, method, body, sentToken)
    } else {
      clearSession()
      window.location.assign('/sign-in?expired=1')
    }
  }

  let payload: unknown = null
  const text = await res.text()
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const err = payload as { error?: string; message?: string } | null
    throw new ApiError(res.status, err?.error ?? 'ERROR', err?.message ?? `Request failed (${res.status}).`)
  }

  if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError(res.status, 'INVALID_RESPONSE', 'The API returned an unexpected response shape.')
  }

  return (payload as { data: T }).data
}
