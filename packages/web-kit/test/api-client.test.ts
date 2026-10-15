import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, createApiClient } from '../src/client/api-client'
import { createSessionStore } from '../src/client/session-store'

type S = { token: string; userId: string }

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined; credentials: string | undefined; cache: string | undefined }
let calls: Call[]
let responder: (call: Call, n: number) => Response | Promise<Response>
let assigned: string[]

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

function setup(overrides: Partial<Parameters<typeof createApiClient<S>>[0]> = {}) {
  const store = createSessionStore<S>({ hintKey: 'hint' })
  const client = createApiClient<S>({
    apiBase: 'https://api.test/',
    clientName: 'unit',
    store,
    sessionFromRefresh: (d) => (typeof d['userId'] === 'string' ? { token: String(d['token']), userId: d['userId'] } : null),
    ...overrides,
  })
  return { store, client }
}

beforeEach(() => {
  calls = []
  assigned = []
  responder = () => json(200, { data: null })
  vi.stubGlobal('window', { location: { assign: (u: string) => assigned.push(u) }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
      credentials: init.credentials,
      cache: init.cache,
    })
    return responder(calls[calls.length - 1] as Call, calls.length)
  })
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('request shape', () => {
  it('normalises the base, unwraps { data }, sends the client header, credentials and no-store', async () => {
    const { client, store } = setup()
    store.write({ token: 'tok', userId: 'u' })
    responder = () => json(200, { data: { hello: 'world' } })
    expect(await client.apiFetch<{ hello: string }>('/api/x')).toEqual({ hello: 'world' })
    expect(client.apiBase).toBe('https://api.test')
    expect(calls[0]).toMatchObject({ url: 'https://api.test/api/x', method: 'GET', credentials: 'include', cache: 'no-store' })
    expect(calls[0]?.headers['X-HushVault-Client']).toBe('unit')
    expect(calls[0]?.headers['Authorization']).toBe('Bearer tok')
  })

  it('an empty base is same-origin, which is how the admin app reaches the API through its own proxy', async () => {
    const { client } = setup({ apiBase: '' })
    await client.apiFetch('/api/admin/orgs', { auth: false })
    expect(calls[0]?.url).toBe('/api/admin/orgs')
  })

  it('auth:false sends no Authorization header even when a session exists', async () => {
    const { client, store } = setup()
    store.write({ token: 'tok', userId: 'u' })
    await client.apiFetch('/api/auth/login', { method: 'POST', auth: false, body: { email: 'a@b.test' } })
    expect(calls[0]?.headers['Authorization']).toBeUndefined()
    expect(calls[0]?.headers['Content-Type']).toBe('application/json')
    expect(calls[0]?.body).toBe(JSON.stringify({ email: 'a@b.test' }))
  })

  it('a request with no body sends no Content-Type', async () => {
    const { client } = setup()
    await client.apiFetch('/api/x')
    expect(calls[0]?.headers['Content-Type']).toBeUndefined()
    expect(calls[0]?.body).toBeUndefined()
  })
})

describe('envelope', () => {
  it('apiFetchEnvelope returns everything next to data, e.g. a pagination cursor', async () => {
    const { client } = setup()
    responder = () => json(200, { data: [1, 2], nextCursor: 'org_9' })
    expect(await client.apiFetchEnvelope<{ data: number[]; nextCursor: string | null }>('/api/admin/orgs')).toEqual({ data: [1, 2], nextCursor: 'org_9' })
  })

  it('both flavours reject a body without data', async () => {
    const { client } = setup()
    for (const body of [{}, [], 'x', null]) {
      responder = () => json(200, body)
      await expect(client.apiFetch('/api/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
      await expect(client.apiFetchEnvelope('/api/x')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
  })
})

describe('errors', () => {
  it('maps the API error object to ApiError and keeps the rest as details', async () => {
    const { client } = setup()
    responder = () => json(403, { error: 'FORBIDDEN', message: 'No.', extra: 1 })
    const err = await client.apiFetch('/api/x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'No.', details: { extra: 1 } })
  })

  it('falls back to a generic code and message for a non-JSON failure', async () => {
    const { client } = setup()
    responder = () => new Response('<html>bad gateway</html>', { status: 502 })
    expect(await client.apiFetch('/api/x').catch((e: unknown) => e)).toMatchObject({ status: 502, code: 'ERROR', message: 'Request failed (502).' })
  })

  it('reports a network failure without leaking the cause', async () => {
    const { client } = setup()
    responder = () => { throw new Error('connect ECONNREFUSED 10.0.0.1:443 secret-token') }
    const err = (await client.apiFetch('/api/x').catch((e: unknown) => e)) as ApiError
    expect(err).toMatchObject({ status: 0, code: 'NETWORK_ERROR' })
    expect(err.message).not.toContain('secret-token')
    expect(err.message).toContain('https://api.test')
  })

  it('calls onApiError with whether the request was authenticated, before throwing', async () => {
    const onApiError = vi.fn()
    const { client } = setup({ onApiError })
    responder = () => json(403, { error: 'MEMBERSHIP_REVOKED', message: 'x' })
    await client.apiFetch('/api/x').catch(() => null)
    await client.apiFetch('/api/y', { auth: false }).catch(() => null)
    expect(onApiError.mock.calls).toEqual([
      [{ status: 403, code: 'MEMBERSHIP_REVOKED', authenticated: true }],
      [{ status: 403, code: 'MEMBERSHIP_REVOKED', authenticated: false }],
    ])
  })
})

describe('refresh on 401', () => {
  const refreshOk = (token: string) => json(200, { data: { token, userId: 'u2' } })

  it('refreshes once, retries the request with the new token and keeps the new session', async () => {
    const { client, store } = setup()
    store.write({ token: 'old', userId: 'u' })
    responder = (call) => {
      if (call.url.endsWith('/api/auth/refresh')) return refreshOk('new')
      return call.headers['Authorization'] === 'Bearer new' ? json(200, { data: 'ok' }) : json(401, { error: 'UNAUTHORIZED', message: 'expired' })
    }
    expect(await client.apiFetch('/api/x')).toBe('ok')
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.test', '')}`)).toEqual(['GET /api/x', 'POST /api/auth/refresh', 'GET /api/x'])
    expect(store.read()).toEqual({ token: 'new', userId: 'u2' })
    expect(calls[1]?.headers['X-HushVault-Client']).toBe('unit')
    expect(calls[1]?.credentials).toBe('include')
  })

  it('concurrent 401s share a single refresh request', async () => {
    const { client, store } = setup()
    store.write({ token: 'old', userId: 'u' })
    responder = (call) => {
      if (call.url.endsWith('/api/auth/refresh')) return refreshOk('new')
      return call.headers['Authorization'] === 'Bearer new' ? json(200, { data: 'ok' }) : json(401, { error: 'UNAUTHORIZED', message: 'x' })
    }
    await Promise.all([client.apiFetch('/api/a'), client.apiFetch('/api/b'), client.apiFetch('/api/c')])
    expect(calls.filter((c) => c.url.endsWith('/api/auth/refresh'))).toHaveLength(1)
  })

  it('a request that lost the race to another refresh reuses the newer token instead of refreshing again', async () => {
    const { client, store } = setup()
    store.write({ token: 'old', userId: 'u' })
    responder = (call) => {
      if (call.headers['Authorization'] === 'Bearer old') {
        store.write({ token: 'newer', userId: 'u' }) // another tab's refresh lands while this request is in flight
        return json(401, { error: 'UNAUTHORIZED', message: 'x' })
      }
      return json(200, { data: 'ok' })
    }
    expect(await client.apiFetch('/api/x')).toBe('ok')
    expect(calls.some((c) => c.url.endsWith('/api/auth/refresh'))).toBe(false)
    expect(calls[1]?.headers['Authorization']).toBe('Bearer newer')
  })

  it('when the refresh is refused it clears the session, sends the user to sign in and still throws', async () => {
    const { client, store } = setup({ signInPath: '/login' })
    store.write({ token: 'old', userId: 'u' })
    responder = (call) => (call.url.endsWith('/api/auth/refresh') ? json(401, { error: 'UNAUTHORIZED', message: 'gone' }) : json(401, { error: 'UNAUTHORIZED', message: 'expired' }))
    await expect(client.apiFetch('/api/x')).rejects.toMatchObject({ status: 401 })
    expect(store.read()).toBeNull()
    expect(assigned).toEqual(['/login?expired=1'])
  })

  it('does not try to refresh an unauthenticated request or one sent without a token', async () => {
    const { client } = setup()
    responder = () => json(401, { error: 'UNAUTHORIZED', message: 'bad credentials' })
    await client.apiFetch('/api/auth/login', { method: 'POST', auth: false }).catch(() => null)
    await client.apiFetch('/api/x').catch(() => null) // no session
    expect(calls.some((c) => c.url.endsWith('/api/auth/refresh'))).toBe(false)
    expect(assigned).toEqual([])
  })
})

describe('refreshSession', () => {
  it('retries a lost rotation race (409) with backoff and then succeeds', async () => {
    vi.useFakeTimers()
    const { client } = setup()
    responder = (_c, n) => (n < 3 ? json(409, { error: 'CONFLICT', message: 'race' }) : json(200, { data: { token: 'won', userId: 'u' } }))
    const pending = client.refreshSession()
    await vi.advanceTimersByTimeAsync(250 + 500)
    expect(await pending).toEqual({ token: 'won', userId: 'u' })
    expect(calls).toHaveLength(3)
  })

  it('gives up after five lost races without clearing anything', async () => {
    vi.useFakeTimers()
    const { client, store } = setup()
    store.write({ token: 'keep', userId: 'u' })
    responder = () => json(409, { error: 'CONFLICT', message: 'race' })
    const pending = client.refreshSession()
    await vi.advanceTimersByTimeAsync(250 * (1 + 2 + 3 + 4 + 5))
    expect(await pending).toBeNull()
    expect(calls).toHaveLength(5)
    expect(store.read()?.token).toBe('keep')
  })

  it('a 401 is a sign-out; a 5xx or a thrown fetch is transient and keeps the session', async () => {
    const { client, store } = setup()
    store.write({ token: 'keep', userId: 'u' })
    responder = () => json(503, { error: 'X', message: 'x' })
    expect(await client.refreshSession()).toBeNull()
    responder = () => { throw new Error('offline') }
    expect(await client.refreshSession()).toBeNull()
    expect(store.read()?.token).toBe('keep')
    responder = () => json(401, { error: 'UNAUTHORIZED', message: 'x' })
    expect(await client.refreshSession()).toBeNull()
    expect(store.read()).toBeNull()
  })

  it('rejects a response the app cannot turn into a session', async () => {
    const { client, store } = setup()
    for (const body of [{ data: { token: 'x' } }, { data: {} }, {}, { data: { userId: 'u' } }]) {
      responder = () => json(200, body)
      expect(await client.refreshSession()).toBeNull()
    }
    expect(store.read()).toBeNull()
  })

  it('reports a failure reason for everything except a lost race, and nothing the caller sent', async () => {
    const onRefreshFailure = vi.fn()
    const { client } = setup({ onRefreshFailure })
    responder = () => json(401, { reason: 'expired' })
    await client.refreshSession()
    responder = () => json(500, {})
    await client.refreshSession()
    expect(onRefreshFailure.mock.calls).toEqual([[401, 'expired'], [500, undefined]])
  })
})

describe('endSession', () => {
  it('asks the API to revoke the family, then clears the session and the hint', async () => {
    const { client, store } = setup()
    store.write({ token: 'tok', userId: 'u' })
    await client.endSession()
    expect(calls[0]).toMatchObject({ url: 'https://api.test/api/auth/logout', method: 'POST', credentials: 'include' })
    expect(store.read()).toBeNull()
  })

  it('still clears the local session when the API cannot be reached', async () => {
    const { client, store } = setup()
    store.write({ token: 'tok', userId: 'u' })
    responder = () => { throw new Error('offline') }
    await client.endSession()
    expect(store.read()).toBeNull()
  })
})
