import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, friendlyError } from '../src/api.js'
import { FakeServer } from './fake-server.js'

afterEach(() => vi.unstubAllGlobals())

describe('ApiClient', () => {
  it('unwraps {data} and sends bearer token', async () => {
    const s = new FakeServer()
    s.install()
    const c = new ApiClient({ apiUrl: 'https://api.test/', token: 'hv_live_abc' })
    const projects = await c.listProjects()
    expect(projects[0]?.id).toBe('prj_1')
    expect(s.calls[0]?.auth).toBe('Bearer hv_live_abc')
    expect(s.calls[0]?.path).toBe('/api/projects')
  })

  it('throws ApiError with status, code and API message', async () => {
    new FakeServer().install()
    const err = await new ApiClient({ apiUrl: 'https://api.test' }).login('a@b.co', 'bad').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(401)
    expect((err as ApiError).code).toBe('UNAUTHORIZED')
    expect((err as ApiError).message).toBe('Invalid credentials')
  })

  it('does not leak raw non-API bodies into errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>secret-value-123</html>', { status: 502, statusText: 'Bad Gateway' })))
    const err = (await new ApiClient({ apiUrl: 'https://api.test', token: 't' }).listProjects().catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(502)
    expect(err.message).not.toContain('secret-value-123')
  })

  it('encodes path and query components', async () => {
    const s = new FakeServer()
    s.install()
    const c = new ApiClient({ apiUrl: 'https://api.test', token: 't' })
    await c.getResolved('a/b?c').catch(() => undefined)
    await c.listSecrets('p&x=1', 'e 1')
    expect(s.calls[0]?.path).toBe('/api/environments/a%2Fb%3Fc/resolved')
    expect(s.calls[1]?.query).toEqual({ projectId: 'p&x=1', envId: 'e 1' })
  })

  it('maps network failure and rejects insecure URLs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const err = (await new ApiClient({ apiUrl: 'https://api.test', token: 't' }).listProjects().catch((e: unknown) => e)) as ApiError
    expect(err.code).toBe('NETWORK_ERROR')
    expect(() => new ApiClient({ apiUrl: 'http://evil.example' })).toThrow(/https/)
    expect(() => new ApiClient({ apiUrl: 'http://localhost:8787' })).not.toThrow()
  })

  it('friendlyError maps 403/409/400', () => {
    expect(friendlyError(new ApiError(403, 'FORBIDDEN', 'x'), 'Writing secrets')).toMatch(/Permission denied/)
    expect(friendlyError(new ApiError(409, 'CONFLICT', 'Secret already exists'))).toMatch(/Conflict: Secret already exists/)
    expect(friendlyError(new ApiError(400, 'VALIDATION_ERROR', 'Bad name'))).toMatch(/Invalid input: Bad name/)
  })
})

describe('ApiClient refresh on 401', () => {
  it('refreshes once with the hook and retries; gives up if the hook returns null', async () => {
    const seen: Array<string | null> = []
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const auth = ((init?.headers ?? {}) as Record<string, string>)['Authorization'] ?? null
      seen.push(auth)
      if (auth === 'Bearer fresh') return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
      return new Response(JSON.stringify({ error: 'UNAUTHORIZED', message: 'Session expired' }), { status: 401 })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const refresh = vi.fn(async () => 'fresh')
      const ok = await new ApiClient({ apiUrl: 'https://api.test', token: 'old', refresh }).listProjects()
      expect(ok).toEqual([])
      expect(refresh).toHaveBeenCalledTimes(1)
      expect(seen).toEqual(['Bearer old', 'Bearer fresh'])

      const none = vi.fn(async () => null)
      const err = (await new ApiClient({ apiUrl: 'https://api.test', token: 'old', refresh: none }).listProjects().catch((e: unknown) => e)) as ApiError
      expect(err.status).toBe(401)
      expect(none).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('identifies itself as the CLI so the API returns the refresh token in the body', async () => {
    let header: string | undefined
    vi.stubGlobal('fetch', vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      header = ((init?.headers ?? {}) as Record<string, string>)['X-HushVault-Client']
      return new Response(JSON.stringify({ data: { token: 't', userId: 'u', orgId: 'o', role: 'admin', refreshToken: 'hvr_x' } }), { status: 200 })
    }))
    try {
      const r = await new ApiClient({ apiUrl: 'https://api.test' }).login('a@b.co', 'pw')
      expect(header).toBe('cli')
      expect(r.refreshToken).toBe('hvr_x')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
