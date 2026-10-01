import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { consumeRateLimit, type WindowState } from '../src/lib/rate-limiter-do'
import { createRateLimitMiddleware } from '../src/middleware/rate-limit'
import { createTestEnv } from './helpers/env'

function fakeStore() {
  let state: WindowState | null = null
  return { read: () => state, write: (s: WindowState) => { state = s }, peek: () => state }
}

describe('consumeRateLimit (pure)', () => {
  it('allows up to the limit then denies, with remaining/reset math', () => {
    const s = fakeStore()
    const t = 120_000 + 5_000 // window [120000, 180000)
    const r1 = consumeRateLimit(s, t, 3, 60_000)
    expect(r1).toEqual({ allowed: true, remaining: 2, resetMs: 180_000 })
    expect(consumeRateLimit(s, t + 1, 3, 60_000).remaining).toBe(1)
    expect(consumeRateLimit(s, t + 2, 3, 60_000)).toEqual({ allowed: true, remaining: 0, resetMs: 180_000 })
    expect(consumeRateLimit(s, t + 3, 3, 60_000)).toEqual({ allowed: false, remaining: 0, resetMs: 180_000 })
  })

  it('does not increment on denied requests', () => {
    const s = fakeStore()
    consumeRateLimit(s, 1000, 1, 60_000)
    consumeRateLimit(s, 1001, 1, 60_000)
    consumeRateLimit(s, 1002, 1, 60_000)
    expect(s.peek()?.count).toBe(1)
  })

  it('rolls over into a fresh window', () => {
    const s = fakeStore()
    consumeRateLimit(s, 10_000, 1, 60_000)
    expect(consumeRateLimit(s, 59_999, 1, 60_000).allowed).toBe(false)
    expect(consumeRateLimit(s, 60_000, 1, 60_000)).toEqual({ allowed: true, remaining: 0, resetMs: 120_000 })
    expect(s.peek()).toEqual({ windowStart: 60_000, count: 1 })
  })

  it('treats corrupted state as empty', () => {
    const s = fakeStore()
    s.write({ windowStart: 0, count: Number.NaN })
    expect(consumeRateLimit(s, 1, 2, 60_000).allowed).toBe(true)
  })
})

function fakeNamespace(impl?: (key: string, limit: number, windowMs: number) => Promise<unknown>) {
  const stores = new Map<string, ReturnType<typeof fakeStore>>()
  const names: string[] = []
  return {
    names,
    idFromName: (n: string) => n,
    get: (id: string) => ({
      hit: async (limit: number, windowMs: number) => {
        names.push(id)
        if (impl) return impl(id, limit, windowMs)
        let s = stores.get(id)
        if (!s) { s = fakeStore(); stores.set(id, s) }
        return consumeRateLimit(s, Date.now(), limit, windowMs)
      },
    }),
  }
}

function buildApp(opts: Parameters<typeof createRateLimitMiddleware>[0]) {
  const app = new Hono<{ Bindings: any }>()
  app.use('*', createRateLimitMiddleware(opts))
  app.get('/', (c) => c.json({ ok: true }))
  return app
}

describe('rate-limit middleware', () => {
  it('allows, then 429s with headers/body, using one DO call per request and no KV writes', async () => {
    const ns = fakeNamespace()
    const env = createTestEnv({ RATE_LIMITER: ns })
    const put = vi.spyOn(env.SECRETS_KV, 'put')
    const app = buildApp({ scope: 's', limit: 2, windowMs: 60_000 })
    const h = { 'cf-connecting-ip': '1.2.3.4' }
    const r1 = await app.request('/', { headers: h }, env)
    expect(r1.status).toBe(200)
    expect(r1.headers.get('X-RateLimit-Limit')).toBe('2')
    expect(r1.headers.get('X-RateLimit-Remaining')).toBe('1')
    await app.request('/', { headers: h }, env)
    const r3 = await app.request('/', { headers: h }, env)
    expect(r3.status).toBe(429)
    expect(r3.headers.get('X-RateLimit-Remaining')).toBe('0')
    expect(Number(r3.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1)
    const body = await r3.json() as any
    expect(body.error).toBe('RATE_LIMIT_EXCEEDED')
    expect(new Date(body.resetAt).getTime()).toBeGreaterThan(Date.now() - 1)
    expect(ns.names).toEqual(['s:1.2.3.4', 's:1.2.3.4', 's:1.2.3.4'])
    expect(put).not.toHaveBeenCalled()
  })

  it('ignores spoofable x-forwarded-for: shared unknown bucket', async () => {
    const ns = fakeNamespace()
    const env = createTestEnv({ RATE_LIMITER: ns })
    const app = buildApp({ scope: 's', limit: 1, windowMs: 60_000 })
    expect((await app.request('/', { headers: { 'x-forwarded-for': '9.9.9.9' } }, env)).status).toBe(200)
    expect((await app.request('/', { headers: { 'x-forwarded-for': '8.8.8.8' } }, env)).status).toBe(429)
    expect(ns.names).toEqual(['s:unknown', 's:unknown'])
  })

  it('fails open on DO error for ordinary scopes', async () => {
    const env = createTestEnv({ RATE_LIMITER: fakeNamespace(async () => { throw new Error('do down') }) })
    const res = await buildApp({ scope: 's', limit: 1, windowMs: 1000 }).request('/', {}, env)
    expect(res.status).toBe(200)
  })

  it('fails closed (503) on DO error when failClosed', async () => {
    const env = createTestEnv({ RATE_LIMITER: fakeNamespace(async () => { throw new Error('do down') }) })
    const res = await buildApp({ scope: 's', limit: 1, windowMs: 1000, failClosed: true }).request('/', {}, env)
    expect(res.status).toBe(503)
    expect((await res.json() as any).error).toBe('SERVICE_UNAVAILABLE')
  })

  it('falls back to in-memory limiter when binding is missing (no KV writes)', async () => {
    const env = createTestEnv()
    const put = vi.spyOn(env.SECRETS_KV, 'put')
    const app = buildApp({ scope: 's', limit: 1, windowMs: 60_000 })
    expect((await app.request('/', {}, env)).status).toBe(200)
    expect((await app.request('/', {}, env)).status).toBe(429)
    expect(put).not.toHaveBeenCalled()
  })
})
