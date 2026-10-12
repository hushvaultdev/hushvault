import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sodium from 'libsodium-wrappers'
import { GITHUB_API_BASE, githubActionsProvider as provider, parseRetryAfter } from '../src/integrations/providers/github-actions'
import type { SyncOp } from '../src/integrations/sync-types'

const TOKEN = 'github-pat-PROVIDER-CANARY-77aa'
const VALUE = 'secret-value-CANARY-ccd1'
const RESOURCE = { owner: 'acme', repo: 'web' }

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined }
let calls: Call[]
let responder: (call: Call, n: number) => Response | Promise<Response>
let logged: string[]
let publicKey: Uint8Array
let privateKey: Uint8Array
let base64PublicKey: string

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const noContent = () => new Response(null, { status: 204 })
const signal = () => new AbortController().signal

beforeAll(async () => {
  await sodium.ready
  const kp = sodium.crypto_box_keypair()
  publicKey = kp.publicKey
  privateKey = kp.privateKey
  base64PublicKey = sodium.to_base64(publicKey, sodium.base64_variants.ORIGINAL)
})

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

const session = () => ({ keyId: 'KID-1', key: base64PublicKey })
const input = (ops: SyncOp[]) => ({ credential: TOKEN, config: {}, resource: RESOURCE, ops, session: session(), signal: signal() })

describe('parseConfig / parseResource / validateName / suggestName', () => {
  it('config is the token only; resource is owner+repo', () => {
    expect(provider.parseConfig({})).toEqual({})
    expect(provider.parseConfig({ baseUrl: 'https://evil.test' })).toBeNull()
    expect(provider.parseResource({ owner: 'acme', repo: 'web' })).toEqual({ owner: 'acme', repo: 'web' })
  })

  it('rejects bad owners/repos and extra keys (SSRF-safe)', () => {
    for (const r of [
      { owner: '-bad', repo: 'x' }, { owner: 'a/b', repo: 'x' }, { owner: 'acme', repo: '../x' },
      { owner: 'acme', repo: 'a b' }, { owner: 'acme' }, { owner: 'acme', repo: 'x', host: 'evil' },
      { owner: 'a'.repeat(40), repo: 'x' },
    ]) expect(provider.parseResource(r), JSON.stringify(r)).toBeNull()
  })

  it('validateName enforces GitHub rules; suggestName repairs toward them', () => {
    for (const ok of ['API_KEY', '_x', 'Mixed_Case']) expect(provider.validateName!(ok), ok).toBe(true)
    for (const bad of ['', '9LIVES', 'db-url', 'GITHUB_TOKEN', 'has space', 'a'.repeat(101)]) expect(provider.validateName!(bad), bad).toBe(false)
    expect(provider.suggestName!('db-url')).toBe('DB_URL')
    expect(provider.suggestName!('9lives')).toBe('_9LIVES')
    expect(provider.suggestName!('GITHUB_TOKEN')).toBe('TOKEN')
    expect(provider.suggestName!('API_KEY')).toBeNull()
  })
})

describe('verify / prepare', () => {
  it('verify checks token liveness via /rate_limit', async () => {
    responder = () => json(200, { rate: {} })
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: true })
    expect(calls[0]!.url).toBe(`${GITHUB_API_BASE}/rate_limit`)
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${TOKEN}`)
    responder = () => json(401, {})
    expect(await provider.verify(TOKEN, {}, signal())).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
  })

  it('prepare fetches the repo public key once and returns it as the session', async () => {
    responder = () => json(200, { key_id: 'KID-9', key: base64PublicKey })
    const prepared = await provider.prepare!({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error('unreachable')
    expect(prepared.session).toEqual({ keyId: 'KID-9', key: base64PublicKey })
    expect(calls[0]!.url).toBe(`${GITHUB_API_BASE}/repos/acme/web/actions/secrets/public-key`)
  })

  it('prepare maps a 404 repo to TARGET_NOT_FOUND', async () => {
    responder = () => json(404, { message: 'Not Found' })
    const prepared = await provider.prepare!({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })
    expect(prepared).toEqual({ ok: false, code: 'TARGET_NOT_FOUND' })
  })
})

describe('listNames', () => {
  it('returns secret names and stops once total_count is reached', async () => {
    responder = () => json(200, { total_count: 2, secrets: [{ name: 'A' }, { name: 'B' }] })
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })).toEqual({ ok: true, names: ['A', 'B'] })
    expect(calls).toHaveLength(1)
  })

  it('maps 403 with no rate-limit signal to PROVIDER_AUTH', async () => {
    responder = () => json(403, { message: 'Forbidden' })
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })).toEqual({ ok: false, code: 'PROVIDER_AUTH' })
  })

  it('maps 403 with x-ratelimit-remaining:0 to PROVIDER_RATE_LIMIT', async () => {
    responder = () => json(403, { message: 'rate limited' }, { 'x-ratelimit-remaining': '0', 'retry-after': '60' })
    expect(await provider.listNames({ credential: TOKEN, config: {}, resource: RESOURCE, signal: signal() })).toEqual({ ok: false, code: 'PROVIDER_RATE_LIMIT', retryAfterSeconds: 60 })
  })
})

describe('push (seal + upsert, delete, error mapping)', () => {
  it('seals each value with the session public key and PUTs encrypted_value + key_id', async () => {
    responder = () => json(201, {})
    const out = await provider.push(input([{ type: 'set', name: 'API_KEY', value: VALUE }]))
    expect(out).toEqual({ ok: true, results: [{ name: 'API_KEY', ok: true }] })
    const put = calls[0]!
    expect(put.method).toBe('PUT')
    expect(put.url).toBe(`${GITHUB_API_BASE}/repos/acme/web/actions/secrets/API_KEY`)
    const body = JSON.parse(put.body!)
    expect(body.key_id).toBe('KID-1')
    expect(typeof body.encrypted_value).toBe('string')
    // The value is really sealed: the repo secret key decrypts it back, and the plaintext never appears on the wire.
    const opened = sodium.crypto_box_seal_open(sodium.from_base64(body.encrypted_value, sodium.base64_variants.ORIGINAL), publicKey, privateKey)
    expect(sodium.to_string(opened)).toBe(VALUE)
    expect(put.body!).not.toContain(VALUE)
  })

  it('delete is idempotent: 204 and 404 both succeed', async () => {
    responder = (_c, n) => (n === 1 ? noContent() : json(404, { message: 'Not Found' }))
    const out = await provider.push(input([{ type: 'delete', name: 'GONE' }, { type: 'delete', name: 'ALSO' }]))
    expect(out).toEqual({ ok: true, results: [{ name: 'GONE', ok: true }, { name: 'ALSO', ok: true }] })
  })

  it('a bad public key fails that item as PROVIDER_VALIDATION without leaking the value', async () => {
    responder = () => json(201, {})
    const badSession = { keyId: 'KID', key: sodium.to_base64(new Uint8Array(16), sodium.base64_variants.ORIGINAL) }
    const out = await provider.push({ credential: TOKEN, config: {}, resource: RESOURCE, ops: [{ type: 'set', name: 'A', value: VALUE }], session: badSession, signal: signal() })
    if (!out.ok) throw new Error('unreachable')
    expect(out.results[0]).toEqual({ name: 'A', ok: false, code: 'PROVIDER_VALIDATION' })
    expect(logged.join('\n')).not.toContain(VALUE)
  })

  it('stops the batch on an auth failure but reports every item', async () => {
    responder = () => json(401, { message: 'Bad credentials' })
    const out = await provider.push(input([{ type: 'set', name: 'A', value: VALUE }, { type: 'set', name: 'B', value: VALUE }]))
    if (!out.ok) throw new Error('unreachable')
    expect(out.results).toEqual([{ name: 'A', ok: false, code: 'PROVIDER_AUTH' }, { name: 'B', ok: false, code: 'PROVIDER_AUTH' }])
    expect(calls).toHaveLength(1)
  })

  it('a set with no session (prepare missing) is an internal PROVIDER_ERROR, not a push', async () => {
    const out = await provider.push({ credential: TOKEN, config: {}, resource: RESOURCE, ops: [{ type: 'set', name: 'A', value: VALUE }], signal: signal() })
    expect(out).toEqual({ ok: false, code: 'PROVIDER_ERROR' })
    expect(calls).toHaveLength(0)
  })

  it('never logs the credential or the value', async () => {
    responder = () => json(500, { message: 'boom' })
    await provider.push(input([{ type: 'set', name: 'A', value: VALUE }]))
    const all = logged.join('\n')
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain(VALUE)
  })
})

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter(new Response(null, { headers: { 'retry-after': '45' } }))).toBe(45)
  })
})
