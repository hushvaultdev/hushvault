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
 * A refresh-token family, as read back from the row that was presented. `orgId` is the
 * organisation the whole family is bound to (migration 0018, issue #82) and is NOT an input to a
 * rotation: a rotation copies it from the row it consumes, so no refresh can move a session to
 * another org. Changing org means `revokeRefreshFamily` + `issueSession`, i.e. a new family.
 * `orgId: null` is a family minted before 0018; callers must fail closed on it, never guess.
 */
export type SessionFamily = { id: string; startedAt: number; orgId: string | null }

const INSERT_COLUMNS = 'INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, family_started_at, org_id)'

function newRefreshToken(): string {
  return `hvr_${createBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`
}

/** Remove this user's spent and expired rows. Runs in the same batch as every mint. */
function pruneStatement(env: Env, userId: string, wall: number) {
  return env.DB.prepare('DELETE FROM refresh_tokens WHERE user_id = ? AND (expires_at <= ? OR used_at < ?)')
    .bind(userId, wall, wall - REFRESH_REUSE_GRACE_SECONDS)
}

/**
 * Start a NEW refresh-token family for `orgId` and mint the matching access token. `issuedAt`
 * (unix seconds) lets the OAuth account claim mint a session at its invalidation cutoff so the new
 * session survives the invalidation it caused.
 */
export async function issueSession(
  env: Env,
  input: { userId: string; orgId: string; role: Role; issuedAt?: number },
): Promise<IssuedSession> {
  const now = input.issuedAt ?? Math.floor(Date.now() / 1000)
  const accessToken = await signJwt({ sub: input.userId, orgId: input.orgId, role: input.role }, env.JWT_SECRET, ACCESS_TTL_SECONDS, input.issuedAt)
  const refreshToken = newRefreshToken()
  const wall = Math.floor(Date.now() / 1000)
  await env.DB.batch([
    pruneStatement(env, input.userId, wall),
    env.DB.prepare(`${INSERT_COLUMNS} VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      `rt_${crypto.randomUUID().replace(/-/g, '')}`,
      input.userId,
      `rtf_${crypto.randomUUID().replace(/-/g, '')}`,
      await hashToken(refreshToken),
      now,
      now + REFRESH_IDLE_SECONDS,
      now,
      input.orgId,
    ),
  ])
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }
}

/**
 * Issue the successor of a validated refresh token and mark that token used, atomically.
 * Null = lost a race, or the family's org is unusable.
 *
 * The org is taken from `family.orgId` for the access token and copied by the INSERT from the row
 * being consumed for the stored row, so the two cannot diverge and neither can be chosen by the
 * caller. A family minted before migration 0018 has no org: that is not rotatable, and the caller
 * is expected to revoke the family rather than fall back to a membership lookup.
 */
export async function rotateSession(
  env: Env,
  input: { userId: string; role: Role; family: SessionFamily; consume: string },
): Promise<IssuedSession | null> {
  if (!input.family.orgId) return null
  const now = Math.floor(Date.now() / 1000)
  const accessToken = await signJwt({ sub: input.userId, orgId: input.family.orgId, role: input.role }, env.JWT_SECRET, ACCESS_TTL_SECONDS)
  const refreshToken = newRefreshToken()
  const tokenHash = await hashToken(refreshToken)
  // Rotation in one transaction: the successor is inserted only while the old token is still unused, then the
  // old token is marked used. A failure leaves the old token intact (retryable); two racers cannot both succeed.
  // The successor's org_id is SELECTed from the predecessor, which is what makes the family's org immutable.
  await env.DB.batch([
    env.DB.prepare(
      `${INSERT_COLUMNS} SELECT ?, ?, ?, ?, ?, ?, ?, org_id FROM refresh_tokens WHERE id = ? AND used_at IS NULL`,
    ).bind(
      `rt_${crypto.randomUUID().replace(/-/g, '')}`,
      input.userId,
      input.family.id,
      tokenHash,
      now,
      now + REFRESH_IDLE_SECONDS,
      input.family.startedAt,
      input.consume,
    ),
    env.DB.prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL').bind(now, input.consume),
    pruneStatement(env, input.userId, now),
  ])
  // Verify by reading the row back rather than trusting a change counter (D1 documents `changes` only as a
  // rough indication): the successor exists exactly when this call won the rotation.
  const won = await env.DB.prepare('SELECT 1 AS ok FROM refresh_tokens WHERE token_hash = ? LIMIT 1').bind(tokenHash).first<{ ok: number }>()
  if (!won) return null
  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS }
}

export type RotateResult =
  | { ok: true; userId: string; tokenId: string; family: SessionFamily }
  | { ok: false; reason: 'unknown' | 'expired' | 'invalidated' | 'race' | 'reuse' }

type RefreshRow = { id: string; user_id: string; family_id: string; created_at: number; expires_at: number; family_started_at: number; used_at: number | null; org_id: string | null }

/** Validate a refresh token. The caller then issues the next session with `consume: tokenId`, which marks it used atomically. */
export async function rotateRefreshToken(env: Pick<Env, 'DB'>, token: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<RotateResult> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return { ok: false, reason: 'unknown' }
  const hash = await hashToken(token)
  const row = await env.DB.prepare('SELECT id, user_id, family_id, created_at, expires_at, family_started_at, used_at, org_id FROM refresh_tokens WHERE token_hash = ? LIMIT 1')
    .bind(hash).first<RefreshRow>()
  if (!row) return { ok: false, reason: 'unknown' }

  const revokeFamily = () => env.DB.prepare('DELETE FROM refresh_tokens WHERE family_id = ?').bind(row.family_id).run()

  if (row.used_at !== null) {
    if (nowSeconds - row.used_at <= REFRESH_REUSE_GRACE_SECONDS) return { ok: false, reason: 'race' }
    await revokeFamily() // an old token came back: someone has a copy
    return { ok: false, reason: 'reuse' }
  }
  if (row.expires_at <= nowSeconds || nowSeconds >= row.family_started_at + REFRESH_ABSOLUTE_SECONDS) {
    await revokeFamily()
    return { ok: false, reason: 'expired' }
  }

  const user = await env.DB.prepare('SELECT sessions_valid_after FROM users WHERE id = ? LIMIT 1').bind(row.user_id).first<{ sessions_valid_after: number }>()
  if (!user || row.created_at < user.sessions_valid_after) {
    await revokeFamily()
    return { ok: false, reason: 'invalidated' }
  }

  // Validated only. The caller consumes it atomically while issuing the successor (rotateSession `consume`).
  return {
    ok: true,
    userId: row.user_id,
    tokenId: row.id,
    family: { id: row.family_id, startedAt: row.family_started_at, orgId: row.org_id },
  }
}

/**
 * Delete the family of a presented refresh token (logout, and the old family on an org switch).
 * Unknown tokens are a no-op.
 *
 * `userId` scopes it to one user's families. Pass it wherever the presented refresh token is NOT
 * what authenticated the request (org switch), so a caller cannot hand in someone else's token and
 * end their session. Logout omits it: there the token itself is the credential.
 */
export async function revokeRefreshFamily(env: Pick<Env, 'DB'>, token: string, userId?: string): Promise<void> {
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return
  const hash = await hashToken(token)
  if (userId === undefined) {
    await env.DB.prepare('DELETE FROM refresh_tokens WHERE family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = ?)').bind(hash).run()
    return
  }
  await env.DB.prepare(
    'DELETE FROM refresh_tokens WHERE family_id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = ? AND user_id = ?)',
  ).bind(hash, userId).run()
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

export type PresentedRefreshToken = { token: string } | { missing: 'no_client_header' | 'no_cookie' }

/**
 * The refresh token comes from the request body (CLI) or the HttpOnly cookie (browser). Cookie use must
 * carry the custom client header: a cross-site form post cannot set it and a cross-origin fetch with it
 * needs a CORS preflight, so cookie-borne requests cannot be forged by other sites.
 *
 * Lives here rather than in routes/auth.ts because org switching rotates the same cookie (issue #82).
 */
export function presentedRefreshToken(c: Ctx, bodyToken: string | undefined): PresentedRefreshToken {
  if (bodyToken) return { token: bodyToken }
  if (!c.req.header('x-hushvault-client')) return { missing: 'no_client_header' }
  const cookie = readRefreshCookie(c)
  return cookie ? { token: cookie } : { missing: 'no_cookie' }
}
