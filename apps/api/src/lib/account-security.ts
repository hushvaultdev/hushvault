// Session / credential invalidation and the email send budget (issue #26).
import type { Env } from '../index'
import { consumeIdentityLimit } from '../middleware/rate-limit'

/** JWTs issued before this moment stop working (checked by requireAuth). Unix seconds, `iat < value` is rejected. */
export function invalidateSessionsStatement(env: Pick<Env, 'DB'>, userId: string, nowSeconds: number) {
  return env.DB.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?').bind(nowSeconds, userId)
}

export function revokeApiKeysStatement(env: Pick<Env, 'DB'>, userId: string, nowSeconds: number, reason: string) {
  return env.DB.prepare('UPDATE api_keys SET revoked_at = ?, revoked_reason = ? WHERE user_id = ? AND revoked_at IS NULL')
    .bind(nowSeconds, reason, userId)
}

const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_EMAIL_DAILY_BUDGET = 200

/**
 * Global daily cap, per kind (so a sign-up flood cannot starve password reset), kept below the sending provider's quota so a
 * mail-bombing run cannot make password reset unavailable for everyone. Returns false when the
 * budget is spent or the limiter is unavailable (callers then silently skip the send).
 */
export async function spendEmailBudget(env: Env, kind: 'verify' | 'reset'): Promise<boolean> {
  const configured = Number.parseInt(String(env.EMAIL_DAILY_BUDGET ?? ''), 10)
  const limit = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_EMAIL_DAILY_BUDGET
  const result = await consumeIdentityLimit(env, { scope: `email-send-${kind}`, identity: 'global', limit, windowMs: DAY_MS })
  return 'allowed' in result && result.allowed
}
