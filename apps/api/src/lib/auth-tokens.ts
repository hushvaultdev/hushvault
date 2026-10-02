// Single-use tokens for email verification and password reset (issue #26).
//
//  - 256-bit random tokens; only SHA-256(token) is stored, so a database read yields nothing usable.
//  - Single use is enforced by one atomic UPDATE (`used_at IS NULL AND expires_at > now`), so two
//    concurrent redemptions cannot both succeed.
//  - A token is bound to its purpose and to the address it was issued for: it stops working if the
//    user's email changed since.
//  - Issuing a new token of a purpose supersedes the user's earlier ones.
import type { Env } from '../index'
import { createBase64Url } from './auth'

export type TokenPurpose = 'verify_email' | 'reset_password'

export const TOKEN_TTL_MS: Record<TokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 60 * 60 * 1000,
}

const textEncoder = new TextEncoder()

async function hashToken(token: string): Promise<string> {
  return createBase64Url(await crypto.subtle.digest('SHA-256', textEncoder.encode(token)))
}

export type IssuedToken = { token: string; expiresAt: string }

/** Create a token for a user's current email. The raw token is returned once and never stored. */
export async function issueToken(
  env: Pick<Env, 'DB'>,
  input: { userId: string; purpose: TokenPurpose; email: string; now?: Date },
): Promise<IssuedToken> {
  const now = input.now ?? new Date()
  const token = createBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS[input.purpose]).toISOString()
  const nowIso = now.toISOString()

  await env.DB.batch([
    // Supersede earlier tokens of this purpose and tidy this user's expired/used rows.
    env.DB.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND (purpose = ? OR used_at IS NOT NULL OR expires_at <= ?)')
      .bind(input.userId, input.purpose, nowIso),
    env.DB.prepare('INSERT INTO auth_tokens (id, user_id, purpose, token_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`atk_${crypto.randomUUID().replace(/-/g, '')}`, input.userId, input.purpose, await hashToken(token), input.email, expiresAt, nowIso),
  ])
  return { token, expiresAt }
}

export type ConsumedToken = { userId: string; email: string }

/**
 * Redeem a token. Returns the owning user, or null for any invalid, expired, used, wrong-purpose
 * or address-mismatched token (callers must not distinguish these cases to the client).
 */
export async function consumeToken(
  env: Pick<Env, 'DB'>,
  input: { token: string; purpose: TokenPurpose; now?: Date },
): Promise<ConsumedToken | null> {
  if (typeof input.token !== 'string' || input.token.length < 16 || input.token.length > 256) return null
  const nowIso = (input.now ?? new Date()).toISOString()
  const row = await env.DB.prepare(
    `UPDATE auth_tokens SET used_at = ?
     WHERE token_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?
       AND email = (SELECT email FROM users WHERE id = auth_tokens.user_id)
     RETURNING user_id AS userId, email`,
  ).bind(nowIso, await hashToken(input.token), input.purpose, nowIso).first<ConsumedToken>()
  return row ?? null
}

/** Opportunistic global cleanup; call occasionally (there is no cron for this). */
export async function purgeExpiredTokens(env: Pick<Env, 'DB'>, now: Date = new Date()): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at <= ? OR used_at IS NOT NULL').bind(now.toISOString()).run()
}
