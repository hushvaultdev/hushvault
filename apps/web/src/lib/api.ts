import { readSession } from './auth-storage'

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

// Typed fetch wrapper. Unwraps the `{ data }` envelope on success and throws
// an ApiError carrying the API's `{ error, message }` on failure.
export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true } = options
  const headers: Record<string, string> = {}

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  if (auth) {
    const session = readSession()
    if (session) {
      headers['Authorization'] = `Bearer ${session.token}`
    }
  }

  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', `Could not reach the API at ${API_BASE}.`)
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

  return (payload as { data: T }).data
}
