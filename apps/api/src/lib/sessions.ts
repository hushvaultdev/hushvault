// Short-lived access tokens + rotating refresh tokens (issue #77).
//
//  - Access JWT: 15 minutes, so a stolen one is a small window and role/org changes show up quickly.
//  - Refresh token: 256-bit opaque value, stored only as SHA-256. Single use: each refresh issues a new
//    token in the same family. Presenting an already-used token (outside a short race window, for two
//    tabs refreshing together) is treated as theft and revokes the whole family.
//  - Idle expiry 30 days, absolute family lifetime 90 days.
//  - A refresh token created before users.sessions_valid_after is dead (password reset, account claim, logout-all).
import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Env } from '../index'
import { createBase64Url, signJwt } from './auth'

export const ACCESS_TTL_SECONDS = 15 * 60
export const REFRESH_IDLE_SECONDS = 30 * 24 * 60 * 60
export const REFRESH_ABSOLUTE_SECONDS = 90 * 24 * 60 * 60
export const REFRESH_REUSE_GRACE_SECONDS = 10

type Role = 'owner' | 'admin' | 'member' | 'viewer'
type Ctx = Context<{ Bindings: Env }>

const textEncoder = new TextEncoder()

async function hashToken(token: string): Promise<string> {
  return createBase64Url(await crypto.subtle.digest('SHA-256', textEncoder.encode(token)))
}

export type IssuedSession = { accessToken: string; refreshToken: string; expiresIn: number }

/**
 * Mint an access token and a fresh refresh token. `issuedAt` (unix seconds) lets the OAuth account
 * claim mint a session at its invalidation cutoff so the new session survives the invalidation it caused.
 */
export async function issueSession(
  env: Env,
  input: { userId: string; orgId: string; role: Role; family?: { id: string; startedAt: number }; issuedAt?: number },
): Promise<IssuedSession> {
  const now = input.issuedAt ?? Math.floor(Date.now() / 1000)
  const accessToken = await signJwt({ sub: input.userId, orgId: input.orgId, role: input.role }, env.JWT_SECRET, ACCESS_TTL_SECONDS, input.issuedAt)
  const refreshToken = `hvr_${createBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
  const familyId = input.family?.id ?? `rtf_${crypto.randomUUID().replace(/-/g, '')}`
  const startedAt = input.family?.startedAt ?? now
  await env.DB.batch([
    env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND expires_at <= ?').bind(input.userId, now),
    env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, family_started_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(`rt_${crypto.randomUUID().replace(/-/g, '')}`, input.userId, familyId, await hashToken(refreshToken), now, now + REFRESH_IDLE_SECONDS, startedAt),
  ])
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }
}

export type RotateResult =
  | { ok: true; userId: string; family: { id: string; startedAt: number } }
  | { ok: false; reason: 'invalid' | 'race' | 'reuse' }

type RefreshRow = { id: string; user_id: string; family_id: string; created_at: number; expires_at: number; family_started_at: number; used_at: number | null }

/** Consume a refresh token. The caller then issues the next session in the same family. */
export async function rotateRefreshToken(env: Pick<Env, 'DB'>, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<RotateResult> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return { ok: false, reason: 'invalid' }
  const hash = await hashToken(token)
  const row = await env.DB.prepare('SELECT id, user_id, family_id, created_at, expires_at, family_started_at, used_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1')
    .bind(hash).first<RefreshRow>()
  if (!row) return { ok: false, reason: 'invalid' }

  const revokeFamily = () => env.DB.prepare('DELETE FROM refresh_tokens WHERE family_id = ?').bind(row.family_id).run()

  if (row.used_at !== null) {
    if (nowSeconds - row.used_at <= REFRESH_REUSE_GRACE_SECONDS) return { ok: false, reason: 'race' }
    await revokeFamily() // an old token came back: someone has a copy
    return { ok: false, reason: 'reuse' }
  }
  if (row.expires_at <= nowSeconds || nowSeconds >= row.family_started_at + REFRESH_ABSOLUTE_SECONDS) {
    await revokeFamily()
    return { ok: false, reason: 'invalid' }
  }

  const user = await env.DB.prepare('SELECT sessions_valid_after FROM users WHERE id = ? LIMIT 1').bind(row.user_id).first<{ sessions_valid_after: number }>()
  if (!user || row.created_at < user.sessions_valid_after) {
    await revokeFamily()
    return { ok: false, reason: 'invalid' }
  }

  // Atomic single use: of two concurrent redemptions only one flips used_at.
  const claimed = await env.DB.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL RETURNING id').bind(nowSeconds, row.id).first<{ id: string }>()
  if (!claimed) return { ok: false, reason: 'race' }
  return { ok: true, userId: row.user_id, family: { id: row.family_id, startedAt: row.family_started_at } }
}

/** Delete the family of a presented refresh token (logout). Unknown tokens are a no-op. */
export async function revokeRefreshFamily(env: Pick<Env, 'DB'>, token: string): Promise<void> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return
  await env.DB.prepare('DELETE FROM refresh_tokens WHERE family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)').bind(await hashToken(token)).run()
}

// --- Cookie transport (browser) ---------------------------------------------------------------
// HttpOnly so page scripts (XSS, extensions) cannot read it; SameSite=Strict so other sites cannot
// trigger it. The API and the dashboard share a registrable domain, so Strict still attaches it.

function isHttps(c: Ctx): boolean {
  return new URL(c.req.url).protocol === 'https:'
}

export function refreshCookieName(c: Ctx): string {
  return isHttps(c) ? '__Host-hv_refresh' : 'hv_refresh'
}

export function setRefreshCookie(c: Ctx, token: string): void {
  setCookie(c, refreshCookieName(c), token, {
    httpOnly: true, secure: isHttps(c), sameSite: 'Strict', path: '/', maxAge: REFRESH_IDLE_SECONDS,
  })
}

export function clearRefreshCookie(c: Ctx): void {
  deleteCookie(c, refreshCookieName(c), { path: '/', secure: isHttps(c) })
}

export function readRefreshCookie(c: Ctx): string | undefined {
  return getCookie(c, refreshCookieName(c))
}

/** Non-browser clients (the CLI) receive the refresh token in the response body instead of a cookie. */
export function wantsBodyRefresh(c: Ctx): boolean {
  return c.req.header('x-hushvault-client') === 'cli'
}
