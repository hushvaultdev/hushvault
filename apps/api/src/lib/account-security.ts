// Session / credential invalidation and the email send budget (issue #26).
import type { Env } from '../index'
import { consumeIdentityLimit } from '../middleware/rate-limit'
import { logEvent } from './security'

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

/** Which send was skipped. A label only — never an address, a token or a link. */
export type EmailPurpose = 'registration' | 'verify_resend' | 'forgot_password' | 'password_changed'

/**
 * Global daily cap, per kind (so a sign-up flood cannot starve password reset), kept below the sending provider's quota so a
 * mail-bombing run cannot make password reset unavailable for everyone. Returns false when the
 * budget is spent or the limiter is unavailable; the caller then skips the send.
 *
 * The log line lives HERE and not at the call sites (issue #83). It used to be at one of three
 * of them, so registration mail and the password-changed notice drying up produced no signal at
 * all — see docs/OPERATIONS.md § 6. Emitting from the one place that can return false makes
 * every present and future caller observable by construction.
 *
 * The two reasons are separate events because the remedy is: `email.budget_exhausted` means the
 * cap did its job (raise `EMAIL_DAILY_BUDGET` or find who is burning it), while
 * `email.budget_unavailable` means the rate limiter is broken and the cap is not being enforced
 * at all. Collapsing them into one false was itself part of the gap.
 */
export async function spendEmailBudget(env: Env, kind: 'verify' | 'reset', purpose: EmailPurpose): Promise<boolean> {
  const configured = Number.parseInt(String(env.EMAIL_DAILY_BUDGET ?? ''), 10)
  const limit = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_EMAIL_DAILY_BUDGET
  const result = await consumeIdentityLimit(env, { scope: `email-send-${kind}`, identity: 'global', limit, windowMs: DAY_MS })
  if (!('allowed' in result)) {
    logEvent('email.budget_unavailable', { kind, purpose })
    return false
  }
  if (!result.allowed) {
    logEvent('email.budget_exhausted', { kind, purpose, limit })
    return false
  }
  return true
}
