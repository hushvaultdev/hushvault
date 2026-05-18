import type { MiddlewareHandler } from 'hono'
import type { Env } from '../index'

type RateLimitOptions = {
  scope: string
  limit: number
  windowMs: number
}

function getRateLimitKey(scope: string, identity: string, bucket: number): string {
  return `rate:${scope}:${identity}:${bucket}`
}

export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const identity = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
    const bucket = Math.floor(Date.now() / options.windowMs)
    const key = getRateLimitKey(options.scope, identity, bucket)
    const current = await c.env.SECRETS_KV.get(key)
    const hits = current ? Number.parseInt(current, 10) : 0

    if (Number.isFinite(hits) && hits >= options.limit) {
      return c.json({ error: 'RATE_LIMITED', message: 'Too many requests' }, 429)
    }

    await c.env.SECRETS_KV.put(key, String(hits + 1), { expirationTtl: Math.max(1, Math.ceil(options.windowMs / 1000)) })
    return next()
  }
}