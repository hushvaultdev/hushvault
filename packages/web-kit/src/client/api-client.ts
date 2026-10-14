import type { SessionLike, SessionStore } from './session-store'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /**
   * The rest of the API's error object, when it sent one. Only ever read for named, non-secret
   * fields (e.g. the address an invitation was sent to); never logged and never rendered whole,
   * so an error body cannot become a channel for leaking internals into the UI.
   */
  readonly details: Record<string, unknown> | null

  constructor(status: number, code: string, message: string, details: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  // When false, the request is sent without an Authorization header (login/register).
  auth?: boolean
}

export interface ApiClientConfig<S extends SessionLike> {
  /** Origin + base path of the API, no trailing slash. Empty string = same-origin (the admin proxy). */
  apiBase: string
  /** Value of the X-HushVault-Client header. Anything but `cli` selects cookie-based refresh. */
  clientName: string
  store: SessionStore<S>
  /** Build the app's session from a refresh response body (`data`), or null if it is unusable. */
  sessionFromRefresh: (data: Record<string, unknown>) => S | null
  /** Where an unrecoverable 401 sends the user. */
  signInPath?: string
  /** Non-secret diagnostics when a refresh fails for a reason other than a lost rotation race. */
  onRefreshFailure?: (status: number, reason: string | undefined) => void
  /** Called for every failed authenticated-or-not response before it is thrown. Must not throw. */
  onApiError?: (info: { status: number; code: string; authenticated: boolean }) => void
}

export interface ApiClient<S extends SessionLike> {
  readonly apiBase: string
  /** Typed fetch. Unwraps the `{ data }` envelope; throws ApiError on failure. */
  apiFetch<T>(path: string, options?: RequestOptions): Promise<T>
  /**
   * Same request handling, but returns the whole envelope. For endpoints that carry more than
   * `data` next to it, e.g. a pagination cursor.
   */
  apiFetchEnvelope<E extends { data: unknown }>(path: string, options?: RequestOptions): Promise<E>
  /** Exchange the HttpOnly refresh cookie for a new access token. Concurrent callers share one request. */
  refreshSession(): Promise<S | null>
  /** End the session server-side (revokes the refresh token family), then forget it locally. */
  endSession(): Promise<void>
}

export function createApiClient<S extends SessionLike>(config: ApiClientConfig<S>): ApiClient<S> {
  const apiBase = config.apiBase.replace(/\/$/, '')
  const { store, clientName, signInPath = '/sign-in' } = config
  const clientHeader = { 'X-HushVault-Client': clientName }

  let inflightRefresh: Promise<S | null> | null = null

  function refreshSession(): Promise<S | null> {
    if (!inflightRefresh) {
      inflightRefresh = doRefresh().finally(() => {
        inflightRefresh = null
      })
    }
    return inflightRefresh
  }

  // A 409 means another tab won the rotation, so retry with the cookie it just set.
  async function doRefresh(): Promise<S | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let res: Response
      try {
        res = await fetch(`${apiBase}/api/auth/refresh`, { method: 'POST', headers: clientHeader, credentials: 'include' })
      } catch {
        return null
      }
      if (!res.ok && res.status !== 409 && config.onRefreshFailure) {
        const info = (await res.clone().json().catch(() => null)) as { reason?: string } | null
        config.onRefreshFailure(res.status, info?.reason)
      }
      if (res.status === 409) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
        continue
      }
      if (res.status === 401) {
        // The refresh token is genuinely gone (expired, revoked, reused): this is a sign-out.
        store.clear()
        store.markHint(false)
        return null
      }
      if (!res.ok) return null // 429/5xx: transient, keep the cookie and the hint so a retry can work
      const payload = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null
      const data = payload?.data
      if (!data || typeof data['token'] !== 'string') return null
      const next = config.sessionFromRefresh(data)
      if (!next) return null
      store.write(next)
      store.markHint(true)
      return next
    }
    return null
  }

  async function endSession(): Promise<void> {
    try {
      await fetch(`${apiBase}/api/auth/logout`, { method: 'POST', headers: clientHeader, credentials: 'include', keepalive: true })
    } catch {
      // offline: the local session is still cleared below
    }
    store.clear()
    store.markHint(false)
  }

  async function send(path: string, method: string, body: unknown, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { ...clientHeader }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (token) headers['Authorization'] = `Bearer ${token}`
    try {
      return await fetch(`${apiBase}${path}`, {
        method,
        headers,
        credentials: 'include', // the refresh cookie is set/rotated by login and refresh responses
        // Responses can carry plaintext secret values. The API sends Cache-Control: no-store, and
        // this says the same thing from the client side so nothing is served from the HTTP cache.
        cache: 'no-store',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', `Could not reach the API${apiBase ? ` at ${apiBase}` : ''}.`)
    }
  }

  // One request path for both flavours: refresh-once-on-401, parse, map failures to ApiError.
  async function request(path: string, options: RequestOptions): Promise<{ status: number; payload: Record<string, unknown> }> {
    const { method = 'GET', body, auth = true } = options
    let sentToken = auth ? (store.read()?.token ?? null) : null
    let res = await send(path, method, body, sentToken)

    if (res.status === 401 && auth && sentToken && typeof window !== 'undefined') {
      // Another request may already have refreshed; only refresh if the token we used is still current.
      const current = store.read()
      const refreshed = current && current.token !== sentToken ? current : await refreshSession()
      if (refreshed) {
        sentToken = refreshed.token
        res = await send(path, method, body, sentToken)
      } else {
        store.clear()
        window.location.assign(`${signInPath}?expired=1`)
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
      const err = payload as (Record<string, unknown> & { error?: string; message?: string }) | null
      const code = err?.error ?? 'ERROR'
      config.onApiError?.({ status: res.status, code, authenticated: auth })
      throw new ApiError(res.status, code, err?.message ?? `Request failed (${res.status}).`, err ?? null)
    }

    if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
      throw new ApiError(res.status, 'INVALID_RESPONSE', 'The API returned an unexpected response shape.')
    }
    return { status: res.status, payload: payload as Record<string, unknown> }
  }

  return {
    apiBase,
    refreshSession,
    endSession,
    async apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
      return (await request(path, options)).payload['data'] as T
    },
    async apiFetchEnvelope<E extends { data: unknown }>(path: string, options: RequestOptions = {}): Promise<E> {
      return (await request(path, options)).payload as unknown as E
    },
  }
}
