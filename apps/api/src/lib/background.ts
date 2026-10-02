import type { Context } from 'hono'

/**
 * Run work after the response is sent (Workers `waitUntil`). Where no execution context exists
 * (unit tests calling `app.request`), the work is awaited instead. Failures are swallowed:
 * background work such as sending mail must never fail the request.
 */
export async function runBackground(c: Context, work: Promise<unknown>): Promise<void> {
  const safe = work.then(() => undefined, () => undefined)
  let ctx: ExecutionContext | undefined
  try {
    ctx = c.executionCtx
  } catch {
    ctx = undefined
  }
  if (ctx) ctx.waitUntil(safe)
  else await safe
}
