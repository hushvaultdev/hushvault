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

// Fixed-window per-IP limiter backed by KV. Each scope keeps its own counter so
// route-specific and global limits stack (defence in depth). All responses carry
// the X-RateLimit headers; 429s additionally include Retry-After + resetAt.
export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const identity = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown'
    const bucket = Math.floor(Date.now() / options.windowMs)
    const key = getRateLimitKey(options.scope, identity, bucket)
    const stored = await c.env.SECRETS_KV.get(key)
    const parsed = stored ? Number.parseInt(stored, 10) : 0
    // Normalise corrupted/non-numeric values to 0 so a bad KV entry can't
    // permanently disable the limiter for this key (NaN would bypass the check
    // and be written back, fail-open forever).
    const hits = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    const windowSec = Math.max(1, Math.ceil(options.windowMs / 1000))

    c.header('X-RateLimit-Limit', String(options.limit))

    if (hits >= options.limit) {
      const resetMs = (bucket + 1) * options.windowMs
      const retryAfter = Math.max(1, Math.ceil((resetMs - Date.now()) / 1000))
      c.header('X-RateLimit-Remaining', '0')
      c.header('Retry-After', String(retryAfter))
      return c.json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please slow down and try again shortly.',
        resetAt: new Date(resetMs).toISOString(),
      }, 429)
    }

    c.header('X-RateLimit-Remaining', String(Math.max(0, options.limit - hits - 1)))
    await c.env.SECRETS_KV.put(key, String(hits + 1), { expirationTtl: windowSec })
    return next()
  }
}
