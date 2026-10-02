import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOCK_SKEW_SECONDS, JWKS_REFETCH_BUDGET_GLOBAL, JWKS_REFETCH_BUDGET_PER_CALLER, verifyOidcToken } from '../src/lib/oidc-verify'
import { createTestEnv, type TestEnv } from './helpers/env'

const ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS_URL = `${ISSUER}/.well-known/jwks`
const AUDIENCE = 'https://api.hushvault.dev'

const b64url = (input: string | Uint8Array) =>
  Buffer.from(typeof input === 'string' ? input : input).toString('base64url')

async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  )
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
  return { pair, jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: jwk['n'], e: jwk['e'] } }
}

async function makeToken(
  key: Awaited<ReturnType<typeof makeKey>>,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.jwk.kid, ...header }))
  const p = b64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, iat: now, nbf: now, exp: now + 300, ...claims }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.pair.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}

let env: TestEnv
let fetchCalls: string[]

function serveJwks(keys: unknown[], opts: { status?: number; body?: string } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    fetchCalls.push(String(url))
    if (opts.body !== undefined) return new Response(opts.body, { status: opts.status ?? 200 })
    return new Response(JSON.stringify({ keys }), { status: opts.status ?? 200, headers: { 'content-type': 'application/json' } })
  }))
}

const expectation = { issuer: ISSUER, jwksUrl: JWKS_URL, audience: AUDIENCE }
const verify = (token: string, now?: Date) => verifyOidcToken(env as never, token, expectation, now)

beforeEach(() => {
  env = createTestEnv()
  fetchCalls = []
})
afterEach(() => vi.unstubAllGlobals())

describe('verifyOidcToken', () => {
  it('accepts a correctly signed token, caches the key set, and fetches only the configured URL', async () => {
    const key = await makeKey('k1')
    serveJwks([key.jwk])
    const token = await makeToken(key, { repository: 'acme/app' })
    const first = await verify(token)
    expect(first).toMatchObject({ ok: true })
    expect(first.ok && first.claims).toMatchObject({ repository: 'acme/app', iss: ISSUER })
    expect(fetchCalls).toEqual([JWKS_URL])
    // Second verification is served from cache: no further outbound request.
    expect((await verify(await makeToken(key))).ok).toBe(true)
    expect(fetchCalls).toHaveLength(1)
  })

  it('rejects a token signed by a different key, and one whose payload was swapped', async () => {
    const good = await makeKey('k1')
    const evil = await makeKey('k1') // same kid, attacker's key
    serveJwks([good.jwk])
    expect(await verify(await makeToken(evil))).toEqual({ ok: false, code: 'BAD_SIGNATURE' })

    const token = await makeToken(good, { repository: 'acme/app' })
    const [h, , s] = token.split('.') as [string, string, string]
    const swapped = b64url(JSON.stringify({ iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, repository: 'attacker/app' }))
    expect(await verify(`${h}.${swapped}.${s}`)).toEqual({ ok: false, code: 'BAD_SIGNATURE' })
  })

  it('refuses alg none, HS256, a missing kid and malformed input before touching the key set', async () => {
    const key = await makeKey('k1')
    serveJwks([key.jwk])
    const token = await makeToken(key)
    const [, p, s] = token.split('.') as [string, string, string]
    for (const header of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'RS256', kid: undefined }]) {
      const h = b64url(JSON.stringify({ typ: 'JWT', ...header }))
      expect(await verify(`${h}.${p}.${s}`)).toEqual({ ok: false, code: 'UNSUPPORTED_ALG' })
    }
    expect(await verify('a.b')).toEqual({ ok: false, code: 'MALFORMED' })
    expect(await verify('!!.!!.!!')).toEqual({ ok: false, code: 'MALFORMED' })
    expect(fetchCalls).toHaveLength(0)
  })

  it('rejects a wrong issuer or audience even when the signature is valid', async () => {
    const key = await makeKey('k1')
    serveJwks([key.jwk])
    expect(await verify(await makeToken(key, { iss: 'https://evil.example' }))).toEqual({ ok: false, code: 'WRONG_ISSUER' })
    expect(await verify(await makeToken(key, { aud: 'https://someone-else.example' }))).toEqual({ ok: false, code: 'WRONG_AUDIENCE' })
    expect(await verify(await makeToken(key, { aud: ['a', 'b'] }))).toEqual({ ok: false, code: 'WRONG_AUDIENCE' })
    expect((await verify(await makeToken(key, { aud: ['x', AUDIENCE] }))).ok).toBe(true)
  })

  it('enforces the time window with a bounded clock skew', async () => {
    const key = await makeKey('k1')
    serveJwks([key.jwk])
    const now = Math.floor(Date.now() / 1000)
    const token = await makeToken(key, { iat: now, nbf: now, exp: now + 60 })
    expect((await verify(token, new Date((now + 60 + CLOCK_SKEW_SECONDS - 5) * 1000))).ok).toBe(true)
    expect(await verify(token, new Date((now + 60 + CLOCK_SKEW_SECONDS + 5) * 1000))).toEqual({ ok: false, code: 'EXPIRED' })
    expect(await verify(await makeToken(key, { exp: undefined }))).toEqual({ ok: false, code: 'EXPIRED' })
    const future = await makeToken(key, { iat: now + 600, nbf: now + 600, exp: now + 900 })
    expect(await verify(future)).toEqual({ ok: false, code: 'EXPIRED' })
  })

  it('handles key rotation, and a junk-kid flood can never block a genuine rotation', async () => {
    const old = await makeKey('old')
    serveJwks([old.jwk])
    expect((await verify(await makeToken(old))).ok).toBe(true) // caches {old}
    const fresh = await makeKey('new')
    serveJwks([old.jwk, fresh.jwk])
    fetchCalls = []
    expect((await verify(await makeToken(fresh))).ok).toBe(true) // refetched and found
    expect(fetchCalls).toHaveLength(1)

    // Repeating ONE junk kid costs a single fetch: the miss is remembered.
    const junk = await makeKey('junk')
    for (let i = 0; i < 5; i += 1) expect(await verify(await makeToken(junk))).toEqual({ ok: false, code: 'UNKNOWN_KEY' })
    expect(fetchCalls).toHaveLength(2)
  })

  it('a flood of DISTINCT junk kids exhausts only that caller\'s budget, and reads as an outage not a bad token', async () => {
    const first = await makeKey('k0')
    serveJwks([first.jwk])
    const attacker = { ...expectation, callerKey: '203.0.113.9' }
    expect((await verifyOidcToken(env as never, await makeToken(first), attacker)).ok).toBe(true)

    let throttled = 0
    for (let i = 0; i < JWKS_REFETCH_BUDGET_PER_CALLER + 3; i += 1) {
      const junk = await makeKey(`junk-${i}`)
      const res = await verifyOidcToken(env as never, await makeToken(junk), attacker)
      expect(res.ok).toBe(false)
      if (!res.ok && res.code === 'KEY_LOOKUP_THROTTLED') throttled += 1
    }
    expect(throttled).toBeGreaterThan(0)
    expect(fetchCalls.length).toBeLessThanOrEqual(JWKS_REFETCH_BUDGET_PER_CALLER + 1)

    // A cached key still verifies for the attacker...
    expect((await verifyOidcToken(env as never, await makeToken(first), attacker)).ok).toBe(true)
    // ...and THE POINT: another caller's genuine key rotation is unaffected by that flood.
    const rotated = await makeKey('rotated')
    serveJwks([first.jwk, rotated.jwk])
    const victim = { ...expectation, callerKey: '198.51.100.4' }
    expect((await verifyOidcToken(env as never, await makeToken(rotated), victim)).ok).toBe(true)
    expect(JWKS_REFETCH_BUDGET_GLOBAL).toBeGreaterThan(JWKS_REFETCH_BUDGET_PER_CALLER)
  })

  it('reports an unavailable key set rather than accepting the token', async () => {
    const key = await makeKey('k1')
    serveJwks([], { status: 500 })
    expect(await verify(await makeToken(key))).toEqual({ ok: false, code: 'JWKS_UNAVAILABLE' })
    env = createTestEnv()
    serveJwks([], { body: 'not json' })
    expect(await verify(await makeToken(key))).toEqual({ ok: false, code: 'JWKS_UNAVAILABLE' })
    env = createTestEnv()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network') }))
    expect(await verify(await makeToken(key))).toEqual({ ok: false, code: 'JWKS_UNAVAILABLE' })
  })

  it('ignores key-set entries that are not RSA signing keys', async () => {
    const key = await makeKey('k1')
    serveJwks([{ kty: 'oct', kid: 'k1', k: 'secret' }, { kty: 'RSA', kid: 'k1', alg: 'RS512', n: key.jwk.n, e: key.jwk.e }])
    expect(await verify(await makeToken(key))).toEqual({ ok: false, code: 'UNKNOWN_KEY' })
  })
})
