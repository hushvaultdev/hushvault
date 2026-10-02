import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BULK_MAX_OPERATIONS, CLOUDFLARE_API_BASE, cloudflareWorkersProvider as provider, deniedScripts, isDeniedScript } from '../src/integrations/providers/cloudflare-workers'
import type { SyncOp } from '../src/integrations/sync-types'

const TOKEN = 'cf-token-PROVIDER-CANARY-77aa'
const VALUE = 'secret-value-CANARY-ccd1'
const ACCOUNT = 'a'.repeat(32)
const RESOURCE = { accountId: ACCOUNT, scriptName: 'my-worker' }

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined }
let calls: Call[]
let responder: (call: Call, n: number) => Response | Promise<Response>
let logged: string[]

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal

beforeEach(() => {
  calls = []
  logged = []
  responder = () => json(200, { success: true, errors: [], messages: [], result: [] })
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call: Call = { url: String(url), method: String(init.method), headers: init.headers as Record<string, string>, body: init.body as string | undefined }
    calls.push(call)
    return responder(call, calls.length)
  })
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

const sets = (n: number): SyncOp[] => Array.from({ length: n }, (_, i) => ({ type: 'set' as const, name: `K_${i}`, value: VALUE }))
const input = (ops: SyncOp[]) => ({ credential: TOKEN, config: { accountId: ACCOUNT }, resource: RESOURCE, ops, signal: signal() })

describe('parseConfig / parseResource', () => {
  it('accepts identifiers only', () => {
    expect(provider.parseConfig({ accountId: ACCOUNT.toUpperCase() })).toEqual({ accountId: ACCOUNT })
    expect(provider.parseResource(RESOURCE)).toEqual(RESOURCE)
    expect(provider.parseResource({ accountId: ACCOUNT, scriptName: 'A_b-9' })).not.toBeNull()
  })

  it('rejects SSRF-ish and malformed inputs', () => {
    const bad = ['../x', 'a/b', 'a b', 'a%2Fb', 'a.b', '', '-lead', 'https://evil.test', 'a?x=1', 'a#f', 'x'.repeat(64), 'a\n', 'ünï']
    for (const scriptName of bad) expect(provider.parseResource({ accountId: ACCOUNT, scriptName }), scriptName).toBeNull()
    for (const accountId of ['', 'abc', `${ACCOUNT}/..`, 'g'.repeat(32), 'evil.test', `${ACCOUNT}0`]) {
      expect(provider.parseResource({ accountId, scriptName: 'w' }), accountId).toBeNull()
      expect(provider.parseConfig({ accountId }), accountId).toBeNull()
    }
    expect(provider.parseResource({ accountId: ACCOUNT, scriptName: 'w', host: 'evil.test' })).toBeNull()
    expect(provider.parseResource({ accountId: ACCOUNT })).toBeNull()
    expect(provider.parseResource(null)).toBeNull()
    expect(provider.parseResource('x')).toBeNull()
    expect(provider.parseConfig({ accountId: ACCOUNT, baseUrl: 'https://evil.test' })).toBeNull()
    expect(provider.parseConfig({})).toBeNull()
  })

  it('direct calls with an unvalidated resource never reach fetch', async () => {
    const bad = { accountId: ACCOUNT, scriptName: '../../x' }
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: bad, signal: signal() })).toEqual({ ok: false, code: 'PROVIDER_VALIDATION' })
    expect(await provider.push({ ...input(sets(1)), resource: bad })).toEqual({ ok: false, code: 'PROVIDER_VALIDATION' })
    expect(calls).toHaveLength(0)
  })
})

describe('own-worker denylist', () => {
  it('always denies HushVault workers, case-insensitively, and the var only adds', () => {
    for (const name of ['hushvault-api', 'hushvault-api-dev', 'hushvault-web', 'hushvault-web-dev', 'HushVault-API']) {
      expect(isDeniedScript(undefined, name), name).toBe(true)
    }
    expect(isDeniedScript({ HUSHVAULT_SYNC_DENY_SCRIPTS: 'other-one, Another' }, 'another')).toBe(true)
    expect(isDeniedScript({ HUSHVAULT_SYNC_DENY_SCRIPTS: 'other-one' }, 'hushvault-api')).toBe(true)
    expect(isDeniedScript({ HUSHVAULT_SYNC_DENY_SCRIPTS: '' }, 'customer-app')).toBe(false)
    expect(deniedScripts({ HUSHVAULT_SYNC_DENY_SCRIPTS: ' , ,' }).size).toBe(4)
  })
})

describe('verify', () => {
  it('uses only the fixed host, sends the token as a bearer header and succeeds on an active token', async () => {
    responder = () => json(200, { success: true, result: { id: 'x', status: 'active' } })
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: true })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/tokens/verify`)
    expect(calls[0]?.method).toBe('GET')
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]?.url).not.toContain(TOKEN)
  })

  it('falls back to the user verify endpoint for user tokens', async () => {
    responder = (call) => (call.url.includes('/accounts/') ? json(401, { success: false, errors: [{ code: 1000, message: 'nope' }] }) : json(200, { success: true, result: { status: 'active' } }))
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: true })
    expect(calls.map((c) => c.url)).toEqual([`${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/tokens/verify`, `${CLOUDFLARE_API_BASE}/user/tokens/verify`])
  })

  it('maps rejection, rate limit, server errors and thrown fetches without leaking the token', async () => {
    responder = () => json(401, { success: false, errors: [{ code: 9109, message: `bad ${TOKEN}` }] })
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
    responder = () => json(429, {})
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: false, code: 'PROVIDER_RATE_LIMIT' })
    responder = () => json(500, {})
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    responder = () => { throw new Error(`boom ${TOKEN}`) }
    const result = await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())
    expect(result).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    responder = () => json(200, { success: true, result: { status: 'expired' } })
    expect((await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).ok).toBe(false)
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(logged.join('\n')).not.toContain('CANARY')
  })
})

describe('listNames', () => {
  it('returns names only from the secrets endpoint', async () => {
    responder = () => json(200, { success: true, result: [{ name: 'A', type: 'secret_text' }, { name: 'B', type: 'secret_text', text: 'ignored' }, { nope: 1 }] })
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })).toEqual({ ok: true, names: ['A', 'B'] })
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/workers/scripts/my-worker/secrets`)
    expect(calls[0]?.method).toBe('GET')
  })

  it('maps statuses and Cloudflare error codes', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, {}, 'PROVIDER_AUTH'], [403, {}, 'PROVIDER_AUTH'], [404, {}, 'TARGET_NOT_FOUND'],
      [400, { errors: [{ code: 10007 }] }, 'TARGET_NOT_FOUND'], [429, {}, 'PROVIDER_RATE_LIMIT'], [500, {}, 'PROVIDER_ERROR'], [503, 'html', 'PROVIDER_ERROR'],
    ]
    for (const [status, body, code] of cases) {
      responder = () => json(status, body)
      expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() }), `${status}`).toEqual({ ok: false, code })
    }
    responder = () => json(200, { success: true, result: 'weird' })
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })

  it('reports TIMEOUT when the signal aborted', async () => {
    const controller = new AbortController()
    responder = () => { controller.abort(); throw new DOMException('aborted', 'AbortError') }
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: controller.signal })).toEqual({ ok: false, code: 'TIMEOUT' })
  })
})

describe('push', () => {
  it('sends one bulk body: set as secret_text, delete as null', async () => {
    const ops: SyncOp[] = [{ type: 'set', name: 'API_KEY', value: VALUE }, { type: 'delete', name: 'OLD' }]
    const result = await provider.push(input(ops))
    expect(result).toEqual({ ok: true, results: [{ name: 'API_KEY', ok: true }, { name: 'OLD', ok: true }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/workers/scripts/my-worker/secrets`)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ secrets: { API_KEY: { type: 'secret_text', name: 'API_KEY', text: VALUE }, OLD: null } })
    expect(JSON.stringify(result)).not.toContain('CANARY')
  })

  it('chunks to the documented 100 operations per request', async () => {
    expect(BULK_MAX_OPERATIONS).toBe(100)
    const result = await provider.push(input(sets(250)))
    expect(calls.map((c) => Object.keys((JSON.parse(c.body ?? '{}') as { secrets: object }).secrets).length)).toEqual([100, 100, 50])
    expect(result.ok && result.results.every((r) => r.ok)).toBe(true)
  })

  it('falls back to PUT when the verb is rejected with 405', async () => {
    responder = (call) => (call.method === 'PATCH' ? json(405, {}) : json(200, { success: true }))
    const result = await provider.push(input(sets(1)))
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'PUT'])
    expect(result).toEqual({ ok: true, results: [{ name: 'K_0', ok: true }] })
  })

  it('maps failures per item and stops on auth/rate-limit/not-found; never echoes the provider body', async () => {
    const cases: Array<[number, unknown, string, number]> = [
      [401, { errors: [{ code: 10000, message: `Authentication error ${TOKEN} ${VALUE}` }] }, 'PROVIDER_AUTH', 1],
      [429, {}, 'PROVIDER_RATE_LIMIT', 1],
      [404, { errors: [{ code: 10007 }] }, 'TARGET_NOT_FOUND', 1],
      [400, { errors: [{ code: 10055, message: 'too many' }] }, 'PROVIDER_VALIDATION', 3],
      [500, {}, 'PROVIDER_ERROR', 3],
    ]
    for (const [status, body, code, expectedCalls] of cases) {
      calls = []
      responder = () => json(status, body)
      const result = await provider.push(input(sets(250)))
      expect(result.ok, code).toBe(true)
      if (!result.ok) continue
      expect(result.results).toHaveLength(250)
      expect(result.results.every((r) => !r.ok && r.code === code), code).toBe(true)
      expect(calls, code).toHaveLength(expectedCalls)
      const text = JSON.stringify(result)
      expect(text).not.toContain('CANARY')
      expect(text).not.toContain('Authentication error')
    }
    expect(logged.join('\n')).not.toContain('CANARY')
  })

  it('a 2xx with success:false is a failure; an empty 2xx body is success', async () => {
    responder = () => json(200, { success: false, errors: [] })
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_ERROR' }] })
    responder = () => new Response(null, { status: 200 })
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: true }] })
  })

  it('does not follow redirects and thrown fetch errors are opaque', async () => {
    responder = () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_ERROR' }] })
    responder = () => { throw new Error(`socket ${TOKEN} ${VALUE}`) }
    const result = await provider.push(input(sets(1)))
    expect(JSON.stringify(result)).not.toContain('CANARY')
  })

  it('URL-encodes path segments (they are already restricted to safe characters)', async () => {
    await provider.push({ ...input(sets(1)), resource: { accountId: ACCOUNT, scriptName: 'My_Worker-1' } })
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/workers/scripts/My_Worker-1/secrets`)
    expect(new URL(calls[0]?.url ?? '').host).toBe('api.cloudflare.com')
  })
})

describe('limits', () => {
  it('are conservative and within the documented caps', () => {
    expect(provider.limits.maxItems).toBeLessThanOrEqual(BULK_MAX_OPERATIONS)
    expect(provider.limits.maxItems).toBeLessThanOrEqual(64)
    expect(provider.limits.maxValueBytes).toBeLessThanOrEqual(5 * 1024)
  })
})
