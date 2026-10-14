import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUDFLARE_API_BASE } from '../src/integrations/providers/cloudflare-api'
import { PAGES_MAX_OPERATIONS, cloudflarePagesProvider as provider } from '../src/integrations/providers/cloudflare-pages'
import type { SyncOp } from '../src/integrations/sync-types'

const TOKEN = 'cf-token-PROVIDER-CANARY-77aa'
const VALUE = 'secret-value-CANARY-ccd1'
const PLAIN = 'plain-text-value-CANARY-91b2'
const ACCOUNT = 'a'.repeat(32)
const RESOURCE = { accountId: ACCOUNT, projectName: 'my-site', environment: 'production' }
const PROJECT_URL = `${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/pages/projects/my-site`

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined }
let calls: Call[]
let responder: (call: Call, n: number) => Response | Promise<Response>
let logged: string[]

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const signal = () => new AbortController().signal

beforeEach(() => {
  calls = []
  logged = []
  responder = () => json(200, { success: true, errors: [], messages: [], result: {} })
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
const input = (ops: SyncOp[], resource: Record<string, string> = RESOURCE) => ({ credential: TOKEN, config: { accountId: ACCOUNT }, resource, ops, signal: signal() })
const list = (resource: Record<string, string> = RESOURCE) => provider.listNames({ credential: TOKEN, config: {}, resource, signal: signal() })
const project = (deploymentConfigs: unknown) => ({ success: true, result: { name: 'my-site', deployment_configs: deploymentConfigs } })

describe('parseConfig / parseResource', () => {
  it('accepts identifiers only', () => {
    expect(provider.parseConfig({ accountId: ACCOUNT.toUpperCase() })).toEqual({ accountId: ACCOUNT })
    expect(provider.parseResource(RESOURCE)).toEqual(RESOURCE)
    expect(provider.parseResource({ ...RESOURCE, environment: 'preview' })).toEqual({ ...RESOURCE, environment: 'preview' })
    expect(provider.parseResource({ ...RESOURCE, accountId: ACCOUNT.toUpperCase() })).toEqual(RESOURCE)
  })

  it('rejects SSRF-ish and malformed inputs', () => {
    const bad = ['../x', 'a/b', 'a b', 'a%2Fb', 'a.b', '', '-lead', 'UPPER', 'https://evil.test', 'a?x=1', 'a#f', 'x'.repeat(59), 'a\n', 'ünï']
    for (const projectName of bad) expect(provider.parseResource({ ...RESOURCE, projectName }), projectName).toBeNull()
    for (const environment of ['', 'prod', 'Production', 'staging', '../production', 'production\n']) {
      expect(provider.parseResource({ ...RESOURCE, environment }), environment).toBeNull()
    }
    for (const accountId of ['', 'abc', `${ACCOUNT}/..`, 'g'.repeat(32), 'evil.test', `${ACCOUNT}0`]) {
      expect(provider.parseResource({ ...RESOURCE, accountId }), accountId).toBeNull()
      expect(provider.parseConfig({ accountId }), accountId).toBeNull()
    }
    expect(provider.parseResource({ ...RESOURCE, host: 'evil.test' })).toBeNull()
    expect(provider.parseResource({ accountId: ACCOUNT, projectName: 'my-site' })).toBeNull()
    expect(provider.parseResource({ accountId: ACCOUNT, scriptName: 'my-site', environment: 'production' })).toBeNull()
    expect(provider.parseResource(null)).toBeNull()
    expect(provider.parseResource('x')).toBeNull()
    expect(provider.parseConfig({ accountId: ACCOUNT, baseUrl: 'https://evil.test' })).toBeNull()
    expect(provider.parseConfig({})).toBeNull()
  })

  it('direct calls with an unvalidated resource never reach fetch', async () => {
    const bad = { accountId: ACCOUNT, projectName: '../../x', environment: 'production' }
    expect(await list(bad)).toEqual({ ok: false, code: 'PROVIDER_VALIDATION' })
    expect(await provider.push(input(sets(1), bad))).toEqual({ ok: false, code: 'PROVIDER_VALIDATION' })
    expect(await list({ ...RESOURCE, environment: 'nope' })).toEqual({ ok: false, code: 'PROVIDER_VALIDATION' })
    expect(calls).toHaveLength(0)
  })
})

describe('verify', () => {
  it('uses only the fixed host and sends the token as a bearer header', async () => {
    responder = () => json(200, { success: true, result: { id: 'x', status: 'active' } })
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: true })
    expect(calls[0]?.url).toBe(`${CLOUDFLARE_API_BASE}/accounts/${ACCOUNT}/tokens/verify`)
    expect(calls[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    expect(calls[0]?.url).not.toContain(TOKEN)
  })

  it('maps rejection without leaking the token', async () => {
    responder = () => json(401, { success: false, errors: [{ code: 9109, message: `bad ${TOKEN}` }] })
    expect(await provider.verify(TOKEN, { accountId: ACCOUNT }, signal())).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(logged.join('\n')).not.toContain('CANARY')
  })
})

describe('listNames', () => {
  it('returns the names of the selected environment only, never a value', async () => {
    responder = () => json(200, project({
      production: { env_vars: { A: { type: 'secret_text', value: VALUE }, B: { type: 'plain_text', value: PLAIN } } },
      preview: { env_vars: { ONLY_PREVIEW: { type: 'plain_text', value: PLAIN } } },
    }))
    const result = await list()
    expect(result).toEqual({ ok: true, names: ['A', 'B'] })
    expect(JSON.stringify(result)).not.toContain('CANARY')
    expect(calls[0]?.url).toBe(PROJECT_URL)
    expect(calls[0]?.method).toBe('GET')
    expect(await list({ ...RESOURCE, environment: 'preview' })).toEqual({ ok: true, names: ['ONLY_PREVIEW'] })
    expect(logged.join('\n')).not.toContain('CANARY')
  })

  it('treats an environment with no variables as an empty list', async () => {
    responder = () => json(200, project({ production: { env_vars: null }, preview: {} }))
    expect(await list()).toEqual({ ok: true, names: [] })
    expect(await list({ ...RESOURCE, environment: 'preview' })).toEqual({ ok: true, names: [] })
  })

  it('fails closed on a shape it does not understand', async () => {
    for (const body of [
      { success: true, result: 'weird' },
      { success: true, result: {} },
      { success: true, result: { deployment_configs: null } },
      project({ preview: { env_vars: {} } }),
      project({ production: { env_vars: ['A'] } }),
      { success: false, result: project({}).result },
    ]) {
      responder = () => json(200, body)
      expect(await list(), JSON.stringify(body)).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    }
  })

  it('maps statuses and Cloudflare error codes', async () => {
    const cases: Array<[number, unknown, string]> = [
      [401, {}, 'PROVIDER_AUTH'], [403, {}, 'PROVIDER_AUTH'], [404, {}, 'TARGET_NOT_FOUND'],
      [400, { errors: [{ code: 8000007 }] }, 'TARGET_NOT_FOUND'], [429, {}, 'PROVIDER_RATE_LIMIT'], [500, {}, 'PROVIDER_ERROR'], [503, 'html', 'PROVIDER_ERROR'],
    ]
    for (const [status, body, code] of cases) {
      responder = () => json(status, body)
      expect(await list(), `${status}`).toEqual({ ok: false, code })
    }
  })

  it('reports TIMEOUT when the signal aborted', async () => {
    const controller = new AbortController()
    responder = () => { controller.abort(); throw new DOMException('aborted', 'AbortError') }
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: controller.signal })).toEqual({ ok: false, code: 'TIMEOUT' })
  })
})

describe('push', () => {
  it('sends one PATCH scoped to the chosen environment: set as secret_text, delete as null', async () => {
    const ops: SyncOp[] = [{ type: 'set', name: 'API_KEY', value: VALUE }, { type: 'delete', name: 'OLD' }]
    const result = await provider.push(input(ops))
    expect(result).toEqual({ ok: true, results: [{ name: 'API_KEY', ok: true }, { name: 'OLD', ok: true }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.method).toBe('PATCH')
    expect(calls[0]?.url).toBe(PROJECT_URL)
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      deployment_configs: { production: { env_vars: { API_KEY: { type: 'secret_text', value: VALUE }, OLD: null } } },
    })
    expect(JSON.stringify(result)).not.toContain('CANARY')

    calls = []
    await provider.push(input([{ type: 'set', name: 'X', value: VALUE }], { ...RESOURCE, environment: 'preview' }))
    const body = JSON.parse(calls[0]?.body ?? '{}') as { deployment_configs: Record<string, unknown> }
    expect(Object.keys(body.deployment_configs)).toEqual(['preview'])
  })

  it('touches nothing but env_vars of the one environment (no other deployment setting is sent)', async () => {
    await provider.push(input(sets(3)))
    const body = JSON.parse(calls[0]?.body ?? '{}') as { deployment_configs: { production: Record<string, unknown> } }
    expect(Object.keys(body)).toEqual(['deployment_configs'])
    expect(Object.keys(body.deployment_configs.production)).toEqual(['env_vars'])
  })

  it('chunks to the per-request cap', async () => {
    expect(PAGES_MAX_OPERATIONS).toBe(64)
    const result = await provider.push(input(sets(150)))
    const sizes = calls.map((c) => Object.keys((JSON.parse(c.body ?? '{}') as { deployment_configs: { production: { env_vars: object } } }).deployment_configs.production.env_vars).length)
    expect(sizes).toEqual([64, 64, 22])
    expect(result.ok && result.results.every((r) => r.ok)).toBe(true)
  })

  it('only ever sends PATCH: a failure is never retried with another verb', async () => {
    for (const status of [400, 404, 405, 429, 500, 503]) {
      calls = []
      responder = () => json(status, {})
      await provider.push(input(sets(5)))
      expect(calls.map((c) => c.method).filter((m) => m !== 'PATCH'), `${status}`).toEqual([])
    }
  })

  it('a name such as __proto__ is never dropped from the body (own property, not the prototype setter)', async () => {
    const ops: SyncOp[] = [
      { type: 'set', name: '__proto__', value: VALUE },
      { type: 'set', name: 'constructor', value: VALUE },
      { type: 'delete', name: 'prototype' },
      { type: 'set', name: 'NORMAL', value: VALUE },
    ]
    await provider.push(input(ops))
    const raw = calls[0]?.body ?? ''
    const parsed = JSON.parse(raw) as { deployment_configs: { production: { env_vars: Record<string, unknown> } } }
    const vars = parsed.deployment_configs.production.env_vars
    expect(Object.keys(vars).sort()).toEqual(['NORMAL', '__proto__', 'constructor', 'prototype'])
    expect(Object.getOwnPropertyDescriptor(vars, '__proto__')?.value).toEqual({ type: 'secret_text', value: VALUE })
  })

  it('reports a network failure or 5xx as maybe-applied, but a 4xx or 429 as definite', async () => {
    responder = () => { throw new Error('socket hang up') }
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_ERROR', maybeApplied: true }] })
    responder = () => json(502, {})
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_ERROR', maybeApplied: true }] })
    responder = () => json(400, { errors: [{ code: 10054 }] })
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_VALIDATION' }] })
    const controller = new AbortController()
    responder = () => { controller.abort(); throw new DOMException('aborted', 'AbortError') }
    const timedOut = await provider.push({ ...input(sets(1)), signal: controller.signal })
    expect(timedOut).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'TIMEOUT', maybeApplied: true }] })
  })

  it('carries Retry-After on a 429', async () => {
    responder = () => new Response('{}', { status: 429, headers: { 'retry-after': '420' } })
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 420 }] })
    expect(await list()).toEqual({ ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 420 })
  })

  it('maps failures per item and stops on auth/rate-limit/not-found; never echoes the provider body', async () => {
    const cases: Array<[number, unknown, string, number]> = [
      [401, { errors: [{ code: 10000, message: `Authentication error ${TOKEN} ${VALUE}` }] }, 'PROVIDER_AUTH', 1],
      [429, {}, 'PROVIDER_RATE_LIMIT', 1],
      [404, { errors: [{ code: 8000007 }] }, 'TARGET_NOT_FOUND', 1],
      [400, { errors: [{ code: 10055, message: 'too many' }] }, 'PROVIDER_VALIDATION', 3],
      [500, {}, 'PROVIDER_ERROR', 3],
    ]
    for (const [status, body, code, expectedCalls] of cases) {
      calls = []
      responder = () => json(status, body)
      const result = await provider.push(input(sets(150)))
      expect(result.ok, code).toBe(true)
      if (!result.ok) continue
      expect(result.results).toHaveLength(150)
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

  it('does not follow redirects, only calls api.cloudflare.com, and thrown fetch errors are opaque', async () => {
    responder = () => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } })
    expect(await provider.push(input(sets(1)))).toEqual({ ok: true, results: [{ name: 'K_0', ok: false, code: 'PROVIDER_ERROR' }] })
    expect(new URL(calls[0]?.url ?? '').host).toBe('api.cloudflare.com')
    responder = () => { throw new Error(`socket ${TOKEN} ${VALUE}`) }
    expect(JSON.stringify(await provider.push(input(sets(1))))).not.toContain('CANARY')
  })
})

describe('limits', () => {
  it('batch size equals the per-request cap and values stay within 5 KiB', () => {
    expect(provider.limits.maxItems).toBe(PAGES_MAX_OPERATIONS)
    expect(provider.limits.maxValueBytes).toBeLessThanOrEqual(5 * 1024)
  })
})
