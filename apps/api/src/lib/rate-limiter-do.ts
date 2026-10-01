import { DurableObject } from 'cloudflare:workers'

export type RateLimitResult = {
  allowed: boolean
  /** Hits still available in the current window after this call. */
  remaining: number
  /** Absolute epoch-ms at which the current window ends. */
  resetMs: number
}

export type WindowState = { windowStart: number; count: number }

/** Minimal synchronous storage handle so the counting logic can be unit-tested with a fake. */
export type WindowStore = {
  read(): WindowState | null
  write(state: WindowState): void
}

/**
 * Fixed-window counter. Windows are aligned to multiples of windowMs (same as the
 * old KV limiter). A denied request does NOT increment the counter. Known trade-off:
 * a client can burst up to 2x limit across a window boundary; acceptable here
 * because every route also sits under the global limiter.
 * State is a single record, so storage can never grow beyond one row.
 */
export function consumeRateLimit(store: WindowStore, now: number, limit: number, windowMs: number): RateLimitResult {
  const windowStart = Math.floor(now / windowMs) * windowMs
  const resetMs = windowStart + windowMs
  const stored = store.read()
  const count = stored && stored.windowStart === windowStart && Number.isFinite(stored.count) && stored.count > 0
    ? stored.count
    : 0
  if (count >= limit) {
    return { allowed: false, remaining: 0, resetMs }
  }
  store.write({ windowStart, count: count + 1 })
  return { allowed: true, remaining: Math.max(0, limit - count - 1), resetMs }
}

const STATE_KEY = 'w'

/**
 * One instance per `scope:identity` (idFromName). Thin wrapper over consumeRateLimit,
 * using the synchronous KV API of SQLite-backed Durable Objects (ctx.storage.kv).
 * An alarm at the end of the window deletes the record so idle objects hold no data.
 */
export class RateLimiter extends DurableObject {
  async hit(limit: number, windowMs: number): Promise<RateLimitResult> {
    const kv = this.ctx.storage.kv
    const result = consumeRateLimit(
      {
        read: () => kv.get<WindowState>(STATE_KEY) ?? null,
        write: (s) => kv.put(STATE_KEY, s),
      },
      Date.now(),
      limit,
      windowMs,
    )
    if (result.allowed) {
      const existing = await this.ctx.storage.getAlarm()
      if (existing === null) await this.ctx.storage.setAlarm(result.resetMs + 1_000)
    }
    return result
  }

  async alarm(): Promise<void> {
    // Window has ended; drop state. A later hit() re-creates it and re-arms the alarm.
    await this.ctx.storage.deleteAll()
  }
}
