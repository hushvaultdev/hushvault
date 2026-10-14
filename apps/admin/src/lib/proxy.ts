// Admin-origin proxy to the HushVault API (issue #108 finding 2). The browser never calls the API
// origin directly; every allowlisted route handler under src/app/api/** calls forward() with a
// fixed API path. This is deliberately an allowlist of four paths, not a wildcard passthrough —
// a wildcard would re-open the exact cross-origin exposure finding 2 closes, since any caller of
// this Worker could then reach any API route through the admin host's own cookie.
//
// Why this fixes finding 2: apps/api's __Host-hv_refresh cookie (lib/sessions.ts) has no Domain
// attribute, so it is host-only but scopes to whichever origin's RESPONSE sets it. Today the
// browser calls the API origin directly, so the cookie is scoped to api.hushvault.dev and (because
// the dashboard and the admin app would otherwise share that same API origin) a sign-out in one
// app can affect the other. Once every admin request instead goes browser → admin origin → (this
// proxy, Worker-to-Worker fetch) → API origin → back through the admin origin's own response, the
// Set-Cookie the API issues is returned unchanged but from the ADMIN origin's response — so the
// browser scopes it to admin.hushvault.dev instead. Same cookie-setting code; different response
// origin is the entire fix.
//
// API_INTERNAL_URL is deliberately separate from NEXT_PUBLIC_API_URL: this file runs only on the
// Worker (a Next.js Route Handler), never in the browser, so it must not be the public-facing var
// the old direct-to-API browser client used (see api.ts, now itself routed through this proxy).

const ALLOWED_REQUEST_HEADERS = ['content-type', 'authorization', 'x-hushvault-client', 'cf-access-jwt-assertion', 'cookie']

function apiBase(): string {
  const url = process.env['API_INTERNAL_URL']
  if (!url) throw new Error('API_INTERNAL_URL is not configured')
  return url.replace(/\/$/, '')
}

export class ProxyConfigError extends Error {}

/**
 * Forward `request` to `${API_INTERNAL_URL}${apiPath}`, passing through only the headers the API
 * already expects, and returning its status/body/Set-Cookie unchanged. `apiPath` is always a
 * literal or a path built from the caller's own already-matched route segments (see the
 * [...path] catch-all), never an arbitrary string taken from outside the four allowlisted routes.
 */
export async function forward(request: Request, apiPath: string): Promise<Response> {
  let base: string
  try {
    base = apiBase()
  } catch {
    return Response.json({ error: 'PROXY_NOT_CONFIGURED', message: 'Service temporarily unavailable. Please try again shortly.' }, { status: 503 })
  }

  const headers = new Headers()
  for (const name of ALLOWED_REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value !== null) headers.set(name, value)
  }

  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()

  // apiPath is built by the caller from path segments Next.js already matched in this request's
  // own URL (see the [...path] catch-all) — but the URL constructor below WOULD resolve a literal
  // ".." segment as a directory traversal (e.g. '/api/admin/../../secrets' resolves to '/secrets'
  // on the API origin), silently escaping the /api/admin/ prefix this proxy exists to enforce.
  // Reject any such path outright rather than attempt to sanitise it.
  if (apiPath.split('/').some((segment) => segment === '..' || segment === '.')) {
    return Response.json({ error: 'FORBIDDEN', message: 'Invalid path.' }, { status: 403 })
  }

  let upstream: Response
  try {
    upstream = await fetch(`${base}${apiPath}`, { method: request.method, headers, body, redirect: 'manual' })
  } catch {
    return Response.json({ error: 'PROXY_UPSTREAM_UNAVAILABLE', message: 'Could not reach the API.' }, { status: 502 })
  }

  // Forward Set-Cookie (there may be more than one) and the body/status exactly as the API sent
  // them — the proxy adds no translation layer of its own, so the API's own error shapes and the
  // __Host-hv_refresh cookie reach the browser unchanged, just from this origin instead.
  const outHeaders = new Headers()
  const contentType = upstream.headers.get('content-type')
  if (contentType) outHeaders.set('content-type', contentType)
  for (const cookie of upstream.headers.getSetCookie?.() ?? (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie') as string] : [])) {
    outHeaders.append('set-cookie', cookie)
  }
  const responseBody = await upstream.arrayBuffer()
  return new Response(responseBody, { status: upstream.status, headers: outHeaders })
}
