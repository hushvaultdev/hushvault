import { ApiError } from '@hushvault/web-kit/client'

export { ApiError }

// Cloudflare Access is the sole credential for the admin app (issue #108 redesign). The browser
// sends `CF_Authorization` (HttpOnly cookie set by Access at the edge) automatically via
// credentials: 'include'. No Bearer token, no refresh, no session store. The proxy
// (src/lib/proxy.ts) forwards `cf-access-jwt-assertion` to the API, which verifies it via
// requireAccessJwt → requireAuthFromAccess → requirePlatformAdmin.

interface AdminFetchOptions {
  method?: string
  body?: unknown
}

export async function adminFetch<T>(path: string, opts: AdminFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-hushvault-client': 'admin' }
  let bodyStr: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    bodyStr = JSON.stringify(opts.body)
  }
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: bodyStr,
  })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = res.statusText
    try {
      const json = (await res.json()) as Record<string, unknown>
      if (typeof json['error'] === 'string') code = json['error']
      if (typeof json['message'] === 'string') message = json['message']
    } catch { /* response had no JSON body */ }
    throw new ApiError(res.status, code, message)
  }
  const json = (await res.json()) as Record<string, unknown>
  return json['data'] as T
}

export async function adminFetchEnvelope<T>(path: string, opts: AdminFetchOptions = {}): Promise<T> {
  const headers: Record<string, string> = { 'x-hushvault-client': 'admin' }
  let bodyStr: string | undefined
  if (opts.body !== undefined) {
    headers['content-type'] = 'application/json'
    bodyStr = JSON.stringify(opts.body)
  }
  const res = await fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: bodyStr,
  })
  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = res.statusText
    try {
      const json = (await res.json()) as Record<string, unknown>
      if (typeof json['error'] === 'string') code = json['error']
      if (typeof json['message'] === 'string') message = json['message']
    } catch { /* response had no JSON body */ }
    throw new ApiError(res.status, code, message)
  }
  return (await res.json()) as T
}
