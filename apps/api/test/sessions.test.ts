import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedUser, type TestEnv } from './helpers/env'

const PASSWORD = 'a-very-long-password-123'
const WEB = { 'x-hushvault-client': 'web' }
const CLI = { 'x-hushvault-client': 'cli' }

function cookieOf(res: { headers: Headers }): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
}

async function register(env: TestEnv, headers: Record<string, string> = WEB) {
  const res = await call(env, 'POST', '/api/auth/register', { headers, json: { email: 'ann@x.com', password: PASSWORD, organisationName: 'Ann Org' } })
  expect(res.status).toBe(201)
  return res
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function jwtPayload(token: string): { iat: number; exp: number } {
  return JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString())
}

describe('short-lived access tokens + rotating refresh tokens', () => {
  it('issues a 15 minute access token and an HttpOnly Strict refresh cookie', async () => {
    const env = createTestEnv()
    const res = await register(env)
    const p = jwtPayload(res.body.data.token)
    expect(p.exp - p.iat).toBe(900)
    const setCookie = res.headers.get('set-cookie') ?? ''
    expect(setCookie).toMatch(/hv_refresh=hvr_/)
    expect(setCookie).toMatch(/HttpOnly/i)
    expect(setCookie).toMatch(/SameSite=Strict/i)
    expect(res.body.data.refreshToken).toBeUndefined() // browsers never see it in the body
  })

  it('stores only a hash of the refresh token', async () => {
    const env = createTestEnv()
    const res = await register(env)
    const raw = cookieOf(res).split('=')[1] as string
    const rows = await env.DB.prepare('SELECT token_hash FROM refresh_tokens').all<{ token_hash: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0]?.token_hash).not.toBe(raw)
    expect(JSON.stringify(rows.results)).not.toContain(raw)
  })

  it('refreshes via cookie, rotating the token and re-reading role and org', async () => {
    const env = createTestEnv()
    const reg = await register(env)
    const first = cookieOf(reg)
    const res = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: first } })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ userId: reg.body.data.userId, orgId: reg.body.data.orgId, role: 'owner', emailVerified: false, expiresIn: 900 })
    const second = cookieOf(res)
    expect(second).not.toBe(first)
    expect((await call(env, 'GET', '/api/projects', { token: res.body.data.token })).status).toBe(200)

    // A membership change reaches the session at the next refresh.
    await env.DB.prepare("UPDATE members SET role = 'viewer' WHERE user_id = ?").bind(reg.body.data.userId).run()
    const again = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: second } })
    expect(again.body.data.role).toBe('viewer')
  })

  it('CSRF: a cookie-borne refresh without the client header is refused', async () => {
    const env = createTestEnv()
    const reg = await register(env)
    const res = await call(env, 'POST', '/api/auth/refresh', { headers: { cookie: cookieOf(reg) } })
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('INVALID_REFRESH')
  })

  it('REUSE: replaying a used refresh token revokes the whole family', async () => {
    const env = createTestEnv()
    const reg = await register(env)
    const stolen = cookieOf(reg)
    const legit = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: stolen } })
    expect(legit.status).toBe(200)
    await env.DB.prepare('UPDATE refresh_tokens SET used_at = used_at - 60 WHERE used_at IS NOT NULL').run() // past the race window
    const replay = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: stolen } })
    expect(replay.status).toBe(401)
    // The legitimate holder's newest token died with the family.
    const dead = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(legit) } })
    expect(dead.status).toBe(401)
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').first<{ n: number }>()
    expect(left?.n).toBe(0)
  })

  it('RACE: two tabs refreshing together do not log the user out', async () => {
    const env = createTestEnv()
    const reg = await register(env)
    const cookie = cookieOf(reg)
    const a = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie } })
    const b = await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie } })
    expect(a.status).toBe(200)
    expect(b.status).toBe(409)
    expect(b.body.error).toBe('REFRESH_RACE')
    // The winner's cookie still works afterwards.
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(a) } })).status).toBe(200)
  })

  it('CLI gets the refresh token in the body and can refresh with it', async () => {
    const env = createTestEnv()
    await register(env, WEB)
    const login = await call(env, 'POST', '/api/auth/login', { headers: CLI, json: { email: 'ann@x.com', password: PASSWORD } })
    expect(login.body.data.refreshToken).toMatch(/^hvr_/)
    const next = await call(env, 'POST', '/api/auth/refresh', { headers: CLI, json: { refreshToken: login.body.data.refreshToken } })
    expect(next.status).toBe(200)
    expect(next.body.data.refreshToken).toMatch(/^hvr_/)
    expect(next.body.data.refreshToken).not.toBe(login.body.data.refreshToken)
  })

  it('logout revokes the family and clears the cookie; logout-all kills access tokens too', async () => {
    const env = createTestEnv()
    const reg = await register(env)
    const cookie = cookieOf(reg)
    const out = await call(env, 'POST', '/api/auth/logout', { headers: { ...WEB, cookie } })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie') ?? '').toMatch(/Max-Age=0|hv_refresh=;/i)
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie } })).status).toBe(401)

    await wait(1100)
    const login = await call(env, 'POST', '/api/auth/login', { json: { email: 'ann@x.com', password: PASSWORD } })
    const access = login.body.data.token as string
    expect((await call(env, 'GET', '/api/projects', { token: access })).status).toBe(200)
    expect((await call(env, 'POST', '/api/auth/logout-all', { token: access })).status).toBe(200)
    expect((await call(env, 'GET', '/api/projects', { token: access })).status).toBe(401)
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(login) } })).status).toBe(401)
  })

  it('a password reset kills refresh tokens issued before it', async () => {
    const env = createTestEnv()
    const u = await seedUser(env, { email: 'ann@x.com', password: PASSWORD, emailVerified: true })
    const login = await call(env, 'POST', '/api/auth/login', { json: { email: 'ann@x.com', password: PASSWORD } })
    const cookie = cookieOf(login)
    await env.DB.prepare('UPDATE users SET sessions_valid_after = ? WHERE id = ?').bind(Math.floor(Date.now() / 1000) + 1, u.userId).run()
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie } })).status).toBe(401)
  })

  it('rejects expired and absolute-lifetime-exceeded refresh tokens', async () => {
    const env = createTestEnv()
    const reg = await register(env)
    await env.DB.prepare('UPDATE refresh_tokens SET expires_at = 1').run()
    expect((await call(env, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(reg) } })).status).toBe(401)

    const env2 = createTestEnv()
    const reg2 = await register(env2)
    await env2.DB.prepare('UPDATE refresh_tokens SET family_started_at = 1').run()
    expect((await call(env2, 'POST', '/api/auth/refresh', { headers: { ...WEB, cookie: cookieOf(reg2) } })).status).toBe(401)
  })
})
