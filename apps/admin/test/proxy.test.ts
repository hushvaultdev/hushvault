import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forward } from '../src/lib/proxy'

const ORIGINAL_ENV = process.env['API_INTERNAL_URL']

beforeEach(() => {
  process.env['API_INTERNAL_URL'] = 'https://api.internal.test'
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (ORIGINAL_ENV === undefined) delete process.env['API_INTERNAL_URL']
  else process.env['API_INTERNAL_URL'] = ORIGINAL_ENV
})

function mockFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }))
  return calls
}

describe('forward', () => {
  it('forwards method, body and only the allowlisted headers to the right API path', async () => {
    const calls = mockFetch(() => new Response(JSON.stringify({ data: { ok: true } }), { status: 200, headers: { 'content-type': 'application/json' } }))
    const request = new Request('https://admin.hushvault.dev/api/admin/orgs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer abc', 'x-evil-header': 'drop-me', cookie: '__Host-hv_refresh=xyz' },
      body: JSON.stringify({ plan: 'pro' }),
    })
    const res = await forward(request, '/api/admin/orgs')
    expect(res.status).toBe(200)
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) throw new Error('expected one fetch call')
    const { url, init } = call
    expect(url).toBe('https://api.internal.test/api/admin/orgs')
    const headers = init.headers as Headers
    expect(headers.get('authorization')).toBe('Bearer abc')
    expect(headers.get('cookie')).toBe('__Host-hv_refresh=xyz')
    expect(headers.get('x-evil-header')).toBeNull()
    expect(init.body).toBe(JSON.stringify({ plan: 'pro' }))
  })

  it('sends no body for a GET request', async () => {
    const calls = mockFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }))
    const request = new Request('https://admin.hushvault.dev/api/admin/orgs', { method: 'GET' })
    await forward(request, '/api/admin/orgs')
    expect(calls[0]?.init.body).toBeUndefined()
  })

  it('passes the API\'s Set-Cookie header through unchanged, scoping it to this origin\'s response', async () => {
    mockFetch(() => new Response(JSON.stringify({ data: { token: 't', userId: 'u' } }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': '__Host-hv_refresh=xyz; Path=/; HttpOnly; Secure; SameSite=Strict' },
    }))
    const request = new Request('https://admin.hushvault.dev/api/auth/refresh', { method: 'POST' })
    const res = await forward(request, '/api/auth/refresh')
    expect(res.headers.get('set-cookie')).toBe('__Host-hv_refresh=xyz; Path=/; HttpOnly; Secure; SameSite=Strict')
  })

  it('propagates the API\'s status and body unchanged, including an error shape', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: 'FORBIDDEN', message: 'nope' }), { status: 403, headers: { 'content-type': 'application/json' } }))
    const request = new Request('https://admin.hushvault.dev/api/admin/orgs/org_1/plan', { method: 'PUT' })
    const res = await forward(request, '/api/admin/orgs/org_1/plan')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', message: 'nope' })
  })

  it('returns 503 without calling fetch when API_INTERNAL_URL is unset', async () => {
    delete process.env['API_INTERNAL_URL']
    const calls = mockFetch(() => new Response('should not be called', { status: 200 }))
    const request = new Request('https://admin.hushvault.dev/api/admin/orgs', { method: 'GET' })
    const res = await forward(request, '/api/admin/orgs')
    expect(res.status).toBe(503)
    expect(calls).toHaveLength(0)
  })

  it('returns 502 rather than throwing when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const request = new Request('https://admin.hushvault.dev/api/admin/orgs', { method: 'GET' })
    const res = await forward(request, '/api/admin/orgs')
    expect(res.status).toBe(502)
  })
})

describe('the /api/admin/[...path] catch-all cannot escape the allowlisted prefix', () => {
  it('ATTACK: a ".." path segment would resolve outside /api/admin/ via URL parsing, and forward() must reject it', async () => {
    // Mirrors Next.js handing the [...path] handler the matched segments for a request to
    // /api/admin/../../secrets (['..', '..', 'secrets']) — these are this request's own already-
    // matched segments, not an arbitrary caller string, but naively rejoining them under a fixed
    // '/api/admin/' prefix is still unsafe: the URL constructor resolves '..' as a directory
    // traversal, so the forwarded request would actually land on the API's /secrets, not under
    // /api/admin/ at all. Confirmed here directly against the URL constructor forward() builds on:
    expect(new URL('/api/admin/../../secrets', 'https://api.internal.test').pathname).toBe('/secrets')

    // forward() must refuse this rather than let fetch() resolve it.
    mockFetch(() => new Response('should not be called', { status: 200 }))
    const request = new Request('https://admin.hushvault.dev/api/admin/..%2F..%2Fsecrets', { method: 'GET' })
    const res = await forward(request, '/api/admin/../../secrets')
    expect(res.status).toBe(403)
  })

  it('ATTACK: a single ".." or "." segment anywhere in the path is also rejected', async () => {
    const calls = mockFetch(() => new Response('should not be called', { status: 200 }))
    const request = new Request('https://admin.hushvault.dev/api/admin/orgs', { method: 'GET' })
    expect((await forward(request, '/api/admin/orgs/../../secrets')).status).toBe(403)
    expect((await forward(request, '/api/admin/./orgs')).status).toBe(403)
    expect(calls).toHaveLength(0)
  })
})
