import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../index'
import { consumeRateLimit, type RateLimitResult, type WindowState } from '../lib/rate-limiter-do'

type RateLimitOptions = {
  scope: string
  limit: number
  windowMs: number
  /** When the limiter backend errors: false (default) lets the request through; true returns 503. */
  failClosed?: boolean
  /**
   * Bucket identity. Default: the client IP (cf-connecting-ip). Return a string to key the limit on something else,
   * e.g. the authenticated organisation (only valid after auth middleware ran); undefined falls back to the IP.
   */
  keyFn?: (c: Context<{ Bindings: Env }>) => string | undefined
}

// FALLBACK ONLY (local dev / tests where the RATE_LIMITER binding is absent).
// Per-isolate memory: not shared across isolates or colo, so it is NOT a real
// production limiter. Production uses the RateLimiter Durable Object.
// Keyed by the env object so separate test envs (and separate bindings objects) never share counters.
const memoryByEnv = new WeakMap<object, Map<string, WindowState>>()
const MEMORY_MAX_ENTRIES = 10_000

function consumeInMemory(env: object, key: string, now: number, limit: number, windowMs: number): RateLimitResult {
  let memoryWindows = memoryByEnv.get(env)
  if (!memoryWindows) {
    memoryWindows = new Map()
    memoryByEnv.set(env, memoryWindows)
  }
  const windows = memoryWindows
  if (memoryWindows.size > MEMORY_MAX_ENTRIES) {
    for (const [k, v] of windows) {
      if (v.windowStart + windowMs <= now) windows.delete(k)
    }
    if (windows.size > MEMORY_MAX_ENTRIES) windows.clear()
  }
  return consumeRateLimit(
    {
      read: () => windows.get(key) ?? null,
      write: (s) => { windows.set(key, s) },
    },
    now,
    limit,
    windowMs,
  )
}

// Fixed-window per-IP limiter backed by a SQLite Durable Object (one object per
// scope:identity, so counting is atomic and strongly consistent). Each scope keeps
// its own counter so route-specific and global limits stack. All responses carry
// X-RateLimit-*; 429s additionally include Retry-After + resetAt.
export function createRateLimitMiddleware(options: RateLimitOptions): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    // Only cf-connecting-ip is trusted (set by Cloudflare's edge). x-forwarded-for is
    // client-controlled, so when the header is missing everyone shares one bucket.
    const identity = options.keyFn?.(c) ?? c.req.header('cf-connecting-ip') ?? 'unknown'
    const key = `${options.scope}:${identity}`

    let result: RateLimitResult
    try {
      const ns = c.env.RATE_LIMITER as Env['RATE_LIMITER'] | undefined
      if (ns) {
        result = await ns.get(ns.idFromName(key)).hit(options.limit, options.windowMs)
      } else {
        result = consumeInMemory(c.env, key, Date.now(), options.limit, options.windowMs)
      }
    } catch {
      if (options.failClosed) {
        return c.json({ error: 'SERVICE_UNAVAILABLE', message: 'Service temporarily unavailable. Please try again shortly.' }, 503)
      }
      // The Durable Object is unreachable and this scope would rather serve than refuse.
      // Degrade to the per-isolate counter instead of dropping the limit entirely: it is
      // weak (not shared across isolates or colos) but finite, so an outage of the limiter
      // does not hand an attacker an unmetered secret-read endpoint.
      try {
        result = consumeInMemory(c.env, key, Date.now(), options.limit, options.windowMs)
      } catch {
        return next()
      }
    }

    c.header('X-RateLimit-Limit', String(options.limit))
    c.header('X-RateLimit-Remaining', String(result.remaining))

    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetMs - Date.now()) / 1000))
      c.header('Retry-After', String(retryAfter))
      return c.json({
        error: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests. Please slow down and try again shortly.',
        resetAt: new Date(result.resetMs).toISOString(),
      }, 429)
    }

    return next()
  }
}

/** SHA-256 hex of a lowercased identity (e.g. an email), so limiter object names hold no PII. */
export async function identityKey(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value.trim().toLowerCase()))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export type IdentityLimit = { scope: string; identity: string; limit: number; windowMs: number }

/**
 * Consume one hit for a non-IP identity (hash the identity first with identityKey). Returns
 * `{ allowed }`, or `{ unavailable: true }` if the limiter backend failed so the caller can fail closed.
 */
export async function consumeIdentityLimit(env: Env, input: IdentityLimit): Promise<{ allowed: boolean; remaining: number } | { unavailable: true }> {
  const key = `${input.scope}:${input.identity}`
  try {
    const ns = env.RATE_LIMITER as Env['RATE_LIMITER'] | undefined
    const result = ns
      ? await ns.get(ns.idFromName(key)).hit(input.limit, input.windowMs)
      : consumeInMemory(env, key, Date.now(), input.limit, input.windowMs)
    return { allowed: result.allowed, remaining: result.remaining }
  } catch {
    return { unavailable: true }
  }
}
