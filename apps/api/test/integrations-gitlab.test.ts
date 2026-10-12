import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GITLAB_API_BASE, GITLAB_LIST_MAX_PAGES, gitlabProvider as provider, parseRetryAfter } from '../src/integrations/providers/gitlab'
import type { SyncOp } from '../src/integrations/sync-types'

// Not a real token and deliberately not in GitLab's `glpat-...` shape, so push-protection secret scanners
// don't flag this fixture. The provider only echoes it into the PRIVATE-TOKEN header.
const TOKEN = 'gl-provider-test-credential-CANARY-77aa'
const VALUE = 'secret-value-CANARY-ccd1'
const RESOURCE = { projectId: '12345', environmentScope: 'production', masked: false, protected: false }

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined }
let calls: Call[]
let responder: (call: Call, n: number) => Response | Promise<Response>
let logged: string[]

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
/** A 204 No Content: a Response with a 204 status must have a null body. */
const noContent = () => new Response(null, { status: 204 })
const signal = () => new AbortController().signal

beforeEach(() => {
  calls = []
  logged = []
  responder = () => json(200, {})
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

const input = (ops: SyncOp[]) => ({ credential: TOKEN, config: {}, resource: RESOURCE, ops, signal: signal() })

describe('parseConfig / parseResource / validateName', () => {
  it('config is the token only: an empty object is valid, anything else is rejected (no base URL)', () => {
    expect(provider.parseConfig({})).toEqual({})
    expect(provider.parseConfig({ baseUrl: 'https://evil.test' })).toBeNull()
    expect(provider.parseConfig({ projectId: '1' })).toBeNull()
    expect(provider.parseConfig(null)).toBeNull()
    expect(provider.parseConfig('x')).toBeNull()
  })

  it('accepts a numeric project id with optional scope and flags, applying defaults', () => {
    expect(provider.parseResource({ projectId: '42' })).toEqual({ projectId: '42', environmentScope: '*', masked: false, protected: false })
    expect(provider.parseResource({ projectId: '42', environmentScope: 'review/*', masked: true, protected: true }))
      .toEqual({ projectId: '42', environmentScope: 'review/*', masked: true, protected: true })
  })

  it('rejects non-numeric ids, SSRF-ish scopes, unknown keys and non-boolean flags', () => {
    for (const projectId of ['', 'abc', 'group/project', '12a', '0', '-1', '1'.repeat(20), 'https://evil.test']) {
      expect(provider.parseResource({ projectId }), projectId).toBeNull()
    }
    for (const environmentScope of ['', 'a\n', 'https://evil.test', 'x'.repeat(256), 'a;b', 'a,b']) {
      expect(provider.parseResource({ projectId: '1', environmentScope }), environmentScope).toBeNull()
    }
    expect(provider.parseResource({ projectId: '1', masked: 'yes' })).toBeNull()
    expect(provider.parseResource({ projectId: '1', host: 'evil.test' })).toBeNull()
    expect(provider.parseResource({ projectId: '1', baseUrl: 'https://evil.test' })).toBeNull()
    expect(provider.parseResource(null)).toBeNull()
  })

  it('validateName matches GitLab key rules: A-Z a-z 0-9 _ , up to 255; leading digit allowed; dashes/dots/spaces rejected', () => {
    for (const ok of ['API_KEY', '_x', '9LIVES', 'a'.repeat(255)]) expect(provider.validateName!(ok), ok).toBe(true)
    for (const bad of ['', 'db-url', 'has.dot', 'has space', 'a'.repeat(256), 'é']) expect(provider.validateName!(bad), bad).toBe(false)
  })

  it('an unvalidated resource never reaches fetch', async () => {
    const res = await provider.listNames({ credential: TOKEN, config: {}, resource: { projectId: 'group/project' }, signal: signal() })
    expect(res).toEqual({ ok: false, code: 'PROVIDER_VALIDATION' })
    expect(calls).toHaveLength(0)
  })
})

describe('verify (token liveness; PRIVATE-TOKEN header; fixed host)', () => {
  it('ok on 200 and sends the token in the PRIVATE-TOKEN header to gitlab.com', async () => {
    responder = () => json(200, [])
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: true })
    expect(calls[0]!.url.startsWith(`${GITLAB_API_BASE}/projects?`)).toBe(true)
    expect(calls[0]!.headers['PRIVATE-TOKEN']).toBe(TOKEN)
  })

  it('maps 401/403 to PROVIDER_AUTH, 429 to PROVIDER_RATE_LIMIT, 5xx/network to PROVIDER_ERROR', async () => {
    responder = () => json(401, { message: '401 Unauthorized' })
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
    responder = () => json(403, { message: '403 Forbidden' })
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
    responder = () => json(429, {})
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_RATE_LIMIT' })
    responder = () => json(500, {})
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
  })
})

describe('listNames (scoped to the target environment_scope; paginated; fail closed)', () => {
  it('returns only the keys in the target scope and follows x-next-page', async () => {
    responder = (call) => {
      if (call.url.includes('&page=1')) {
        return json(200, [
          { key: 'A', environment_scope: 'production' },
          { key: 'OTHER', environment_scope: 'staging' },
        ], { 'x-next-page': '2' })
      }
      return json(200, [{ key: 'B', environment_scope: 'production' }], { 'x-next-page': '' })
    }
    const res = await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })
    expect(res).toEqual({ ok: true, names: ['A', 'B'] })
    expect(calls.map((c) => c.method)).toEqual(['GET', 'GET'])
  })

  it('fails closed when the scope spans more pages than it will read', async () => {
    responder = () => json(200, [{ key: 'A', environment_scope: 'production' }], { 'x-next-page': '99' })
    const res = await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })
    expect(res).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(calls.length).toBe(GITLAB_LIST_MAX_PAGES)
  })

  it('maps a 403 list to PROVIDER_AUTH (the token lacks the Maintainer role on the project)', async () => {
    responder = () => json(403, { message: '403 Forbidden' })
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
  })
})

describe('push (create/update/delete, raw=true, idempotent delete)', () => {
  it('updates with PUT; sends raw=true, masked/protected and the scope; value only in the body', async () => {
    responder = () => json(200, { key: 'A' })
    const res = { projectId: '12345', environmentScope: 'production', masked: true, protected: true }
    const out = await provider.push({ credential: TOKEN, config: {}, resource: res, ops: [{ type: 'set', name: 'A', value: VALUE }], signal: signal() })
    expect(out).toEqual({ ok: true, results: [{ name: 'A', ok: true }] })
    const put = calls[0]!
    expect(put.method).toBe('PUT')
    expect(put.url).toBe(`${GITLAB_API_BASE}/projects/12345/variables/A?filter%5Benvironment_scope%5D=production`)
    const body = JSON.parse(put.body!)
    expect(body).toMatchObject({ value: VALUE, environment_scope: 'production', masked: true, protected: true, raw: true })
  })

  it('creates with POST when the variable does not exist in the scope (PUT 404 -> POST)', async () => {
    responder = (call) => (call.method === 'PUT'
      ? json(404, { message: '404 Variable Not Found' })
      : json(201, { key: 'NEW' }))
    const out = await provider.push(input([{ type: 'set', name: 'NEW', value: VALUE }]))
    expect(out).toEqual({ ok: true, results: [{ name: 'NEW', ok: true }] })
    expect(calls.map((c) => c.method)).toEqual(['PUT', 'POST'])
    expect(calls[1]!.url).toBe(`${GITLAB_API_BASE}/projects/12345/variables`)
    expect(JSON.parse(calls[1]!.body!)).toMatchObject({ key: 'NEW', value: VALUE, raw: true })
  })

  it('a project-level 404 (not a variable 404) is TARGET_NOT_FOUND and does not fall back to POST', async () => {
    responder = () => json(404, { message: '404 Project Not Found' })
    const out = await provider.push(input([{ type: 'set', name: 'A', value: VALUE }]))
    expect(out).toEqual({ ok: true, results: [{ name: 'A', ok: false, code: 'TARGET_NOT_FOUND' }] })
    expect(calls.map((c) => c.method)).toEqual(['PUT'])
  })

  it('delete is idempotent: 204 and 404 both succeed', async () => {
    responder = (_c, n) => (n === 1 ? noContent() : json(404, { message: '404 Variable Not Found' }))
    const out = await provider.push(input([{ type: 'delete', name: 'GONE' }, { type: 'delete', name: 'ALSOGONE' }]))
    expect(out).toEqual({ ok: true, results: [{ name: 'GONE', ok: true }, { name: 'ALSOGONE', ok: true }] })
    expect(calls.every((c) => c.method === 'DELETE')).toBe(true)
  })

  it('stops the rest of the batch on an auth failure but reports every item', async () => {
    responder = () => json(401, { message: '401 Unauthorized' })
    const out = await provider.push(input([{ type: 'set', name: 'A', value: VALUE }, { type: 'set', name: 'B', value: VALUE }]))
    expect(out.ok).toBe(true)
    if (!out.ok) throw new Error('unreachable')
    expect(out.results).toEqual([{ name: 'A', ok: false, code: 'PROVIDER_AUTH' }, { name: 'B', ok: false, code: 'PROVIDER_AUTH' }])
    expect(calls).toHaveLength(1) // B was never sent
  })

  it('a network error is maybeApplied (the change may have landed)', async () => {
    responder = () => { throw new Error('socket hang up') }
    const out = await provider.push(input([{ type: 'set', name: 'A', value: VALUE }]))
    if (!out.ok) throw new Error('unreachable')
    expect(out.results[0]).toMatchObject({ name: 'A', ok: false, maybeApplied: true })
  })

  it('never logs the credential or the secret value', async () => {
    responder = () => json(500, { message: 'boom', value: VALUE })
    await provider.push(input([{ type: 'set', name: 'A', value: VALUE }]))
    const all = logged.join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(VALUE)
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds and clamps', () => {
    expect(parseRetryAfter(new Response(null, { headers: { 'retry-after': '30' } }))).toBe(30)
    expect(parseRetryAfter(new Response(null, {}))).toBeUndefined()
  })
})
