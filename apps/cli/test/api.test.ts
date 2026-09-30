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
