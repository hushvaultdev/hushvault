import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, createTestEnv, seedApiKey, seedUser, type TestEnv } from './helpers/env'

const PASSWORD = 'correct horse battery staple'
type Sent = { from: string; to: string; subject: string; text: string; html: string }

function makeEnv(extra: Record<string, unknown> = {}) {
  const sent: Sent[] = []
  const env = createTestEnv({
    WEB_APP_URL: 'https://beta.hushvault.dev',
    MAIL_FROM: 'no-reply@hushvault.dev',
    EMAIL: { send: async (m: Sent) => { sent.push(m); return { messageId: 'm' } } },
    ...extra,
  })
  return { env, sent }
}

function tokenFrom(mail: Sent): string {
  const m = /#token=([A-Za-z0-9_-]+)/.exec(mail.text)
  if (!m) throw new Error('no token link in mail')
  return m[1] as string
}

const register = (env: TestEnv, email = 'ann@x.com') =>
  call(env, 'POST', '/api/auth/register', { json: { email, password: PASSWORD, organisationName: 'Ann Org' } })

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('email verification', () => {
  it('registration sends one verification mail with a fragment-only link, and the token verifies once', async () => {
    const { env, sent } = makeEnv()
    const reg = await register(env)
    expect(reg.status).toBe(201)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ from: 'no-reply@hushvault.dev', to: 'ann@x.com' })
    expect(sent[0]!.text).toContain('https://beta.hushvault.dev/verify-email#token=')
    expect(sent[0]!.text).not.toMatch(/[?&]token=/)

    const token = tokenFrom(sent[0]!)
    const ok = await call(env, 'POST', '/api/auth/verify-email', { json: { token } })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ data: { verified: true } })
    const row = await env.DB.prepare('SELECT email_verified FROM users WHERE email = ?').bind('ann@x.com').first<{ email_verified: number }>()
    expect(row!.email_verified).toBe(1)

    const again = await call(env, 'POST', '/api/auth/verify-email', { json: { token } })
    const bogus = await call(env, 'POST', '/api/auth/verify-email', { json: { token: 'x'.repeat(40) } })
    expect(again.status).toBe(400)
    expect(again.body).toEqual({ error: 'INVALID_TOKEN', message: 'This link is invalid or has expired' })
    expect(bogus.body).toEqual(again.body)
  })

  it('registration still succeeds when the mail cannot be sent, or nothing is configured', async () => {
    const failing = makeEnv({ EMAIL: { send: async () => { throw Object.assign(new Error('x'), { code: 'E_X' }) } } })
    expect((await register(failing.env)).status).toBe(201)
    const unconfigured = createTestEnv()
    expect((await register(unconfigured)).status).toBe(201)
  })

  it('a verification token cannot reset a password and vice versa', async () => {
    const { env, sent } = makeEnv()
    await register(env)
    const verifyToken = tokenFrom(sent[0]!)
    const wrong = await call(env, 'POST', '/api/auth/reset-password', { json: { token: verifyToken, password: 'a brand new passphrase' } })
    expect(wrong.status).toBe(400)
    await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'ann@x.com' } })
    const resetToken = tokenFrom(sent[1]!)
    expect((await call(env, 'POST', '/api/auth/verify-email', { json: { token: resetToken } })).status).toBe(400)
  })

  it('verify-email/send needs auth, is rate limited, and is a silent 202 once verified', async () => {
    const { env, sent } = makeEnv()
    expect((await call(env, 'POST', '/api/auth/verify-email/send')).status).toBe(401)
    const reg = await register(env)
    sent.length = 0
    const first = await call(env, 'POST', '/api/auth/verify-email/send', { token: reg.body.data.token })
    expect(first.status).toBe(202)
    expect(sent).toHaveLength(1)
    const second = await call(env, 'POST', '/api/auth/verify-email/send', { token: reg.body.data.token })
    expect(second.status).toBe(429)
    expect(sent).toHaveLength(1)

    const verified = await seedUser(env, { emailVerified: true })
    const quiet = await call(env, 'POST', '/api/auth/verify-email/send', { token: verified.token })
    expect(quiet.status).toBe(202)
    expect(sent).toHaveLength(1)
  })

  it('login reports emailVerified', async () => {
    const { env } = makeEnv()
    await register(env)
    const login = await call(env, 'POST', '/api/auth/login', { json: { email: 'ann@x.com', password: PASSWORD } })
    expect(login.body.data.emailVerified).toBe(false)
  })
})

describe('forgot / reset password', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { logs.push(String(m)) })
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)) })
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { logs.push(String(m)) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('answers identically for known, unknown, OAuth-only and throttled addresses, and only mails real accounts', async () => {
    const { env, sent } = makeEnv()
    await register(env)
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, provider, provider_id, created_at, email_verified) VALUES ('usr_o', 'oauth@x.com', '', '', 'github', '9', ?, 1)")
      .bind(new Date().toISOString()).run()
    sent.length = 0

    const known = await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'ann@x.com' } })
    const unknown = await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'nobody@x.com' } })
    const oauth = await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'oauth@x.com' } })
    expect([known.status, unknown.status, oauth.status]).toEqual([202, 202, 202])
    expect(unknown.body).toEqual(known.body)
    expect(oauth.body).toEqual(known.body)
    expect(known.body).toEqual({ data: { ok: true } })
    expect(sent.map((m) => m.to).sort()).toEqual(['ann@x.com', 'oauth@x.com'])
    expect(sent.find((m) => m.to === 'oauth@x.com')!.text).toContain('GitHub or Google')

    // Per-email limit (3/hour): the 4th request is still 202 with the same body but sends nothing.
    sent.length = 0
    const bodies = []
    for (let i = 0; i < 4; i += 1) bodies.push(await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'ann@x.com' }, headers: { 'cf-connecting-ip': `203.0.113.${i + 10}` } }))
    expect(new Set(bodies.map((b) => JSON.stringify(b.body))).size).toBe(1)
    expect(bodies.slice(0, 2).every((b) => b.status === 202)).toBe(true)
    expect(sent.length).toBeLessThanOrEqual(2) // 1 was used by the first request above
  })

  it('never logs the address or token, and nothing is audited for unknown addresses', async () => {
    const { env, sent } = makeEnv()
    await register(env)
    await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'ann@x.com' } })
    await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'ghost@x.com' } })
    const token = tokenFrom(sent.at(-1)!)
    const out = logs.join('\n')
    expect(out).not.toContain('ann@x.com')
    expect(out).not.toContain('ghost@x.com')
    expect(out).not.toContain(token)
    const audits = await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'auth.password_reset%'").all<{ action: string }>()
    expect(audits.results).toHaveLength(1)
  })

  it('respects the global daily send budget silently', async () => {
    const { env, sent } = makeEnv({ EMAIL_DAILY_BUDGET: '1' })
    await seedUser(env, { email: 'a@x.com' })
    await seedUser(env, { email: 'b@x.com' })
    const a = await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'a@x.com' } })
    const b = await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'b@x.com' } })
    expect(a.status).toBe(202)
    expect(b.body).toEqual(a.body)
    expect(sent).toHaveLength(1)
  })

  it('resets the password: old session and password die, new login works, no auto-login, token is single use', async () => {
    const { env, sent } = makeEnv()
    const reg = await register(env)
    const oldToken = reg.body.data.token as string
    sent.length = 0
    await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'ann@x.com' } })
    const resetToken = tokenFrom(sent[0]!)
    await wait(1100) // JWT iat is whole seconds

    const weak = await call(env, 'POST', '/api/auth/reset-password', { json: { token: resetToken, password: 'short' } })
    expect(weak.status).toBe(400)
    const tooLong = await call(env, 'POST', '/api/auth/reset-password', { json: { token: resetToken, password: 'x'.repeat(129) } })
    expect(tooLong.status).toBe(400)

    const res = await call(env, 'POST', '/api/auth/reset-password', { json: { token: resetToken, password: 'a brand new passphrase' } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { reset: true } })
    expect(JSON.stringify(res.body)).not.toMatch(/token|jwt/i)

    expect((await call(env, 'GET', '/api/projects', { token: oldToken })).status).toBe(401)
    expect((await call(env, 'POST', '/api/auth/login', { json: { email: 'ann@x.com', password: PASSWORD } })).status).toBe(401)
    // The invalidation cutoff is one second ahead (same-second tokens must die), so wait it out.
    await new Promise((r) => setTimeout(r, 1100))
    const login = await call(env, 'POST', '/api/auth/login', { json: { email: 'ann@x.com', password: 'a brand new passphrase' } })
    expect(login.status).toBe(200)
    expect(login.body.data.emailVerified).toBe(true)
    expect((await call(env, 'GET', '/api/projects', { token: login.body.data.token })).status).toBe(200)

    expect((await call(env, 'POST', '/api/auth/reset-password', { json: { token: resetToken, password: 'another passphrase here' } })).status).toBe(400)
    expect(sent.some((m) => m.subject.toLowerCase().includes('password was changed'))).toBe(true)
  })

  it('revokes API keys on reset only for accounts that were unverified', async () => {
    const { env, sent } = makeEnv()
    const unverified = await seedUser(env, { email: 'u@x.com', emailVerified: false })
    const verified = await seedUser(env, { email: 'v@x.com', emailVerified: true })
    const uKey = await seedApiKey(env, unverified.userId)
    const vKey = await seedApiKey(env, verified.userId)
    for (const email of ['u@x.com', 'v@x.com']) await call(env, 'POST', '/api/auth/forgot-password', { json: { email } })
    const resetMails = sent.filter((m) => m.subject.toLowerCase().includes('reset'))
    expect(resetMails).toHaveLength(2)
    for (const mail of resetMails) {
      const r = await call(env, 'POST', '/api/auth/reset-password', { json: { token: tokenFrom(mail), password: 'a brand new passphrase' } })
      expect(r.status).toBe(200)
    }
    expect((await call(env, 'GET', '/api/projects', { token: uKey.rawKey })).status).toBe(401)
    expect((await call(env, 'GET', '/api/projects', { token: vKey.rawKey })).status).toBe(200)
  })

  it('lets an OAuth-only account add a password through reset', async () => {
    const { env, sent } = makeEnv()
    await env.DB.prepare("INSERT INTO users (id, email, password_hash, salt, provider, provider_id, created_at, email_verified) VALUES ('usr_o', 'oauth@x.com', '', '', 'github', '9', ?, 1)")
      .bind(new Date().toISOString()).run()
    await env.DB.prepare("INSERT INTO organisations (id, name, slug, plan, created_at) VALUES ('org_o', 'O', 'o', 'free', ?)").bind(new Date().toISOString()).run()
    await env.DB.prepare("INSERT INTO members (id, org_id, user_id, role, created_at) VALUES ('mem_o', 'org_o', 'usr_o', 'owner', ?)").bind(new Date().toISOString()).run()
    await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'oauth@x.com' } })
    const r = await call(env, 'POST', '/api/auth/reset-password', { json: { token: tokenFrom(sent[0]!), password: 'a brand new passphrase' } })
    expect(r.status).toBe(200)
    expect((await call(env, 'POST', '/api/auth/login', { json: { email: 'oauth@x.com', password: 'a brand new passphrase' } })).status).toBe(200)
  })
})

describe('REQUIRE_VERIFIED_EMAIL', () => {
  it('is off by default and, when on, blocks sensitive actions for unverified accounts only', async () => {
    const { env } = makeEnv()
    const unverified = await seedUser(env, { emailVerified: false })
    const verified = await seedUser(env, { emailVerified: true })
    const createKey = (token: string) => call(env, 'POST', '/api/auth/api-keys', { token, json: { name: 'ci key' } })

    expect((await createKey(unverified.token)).status).toBe(201)
    env['REQUIRE_VERIFIED_EMAIL'] = '1'
    const blocked = await createKey(unverified.token)
    expect(blocked.status).toBe(403)
    expect(blocked.body.error).toBe('EMAIL_NOT_VERIFIED')
    expect((await createKey(verified.token)).status).toBe(201)
    // Never gates login or the recovery endpoints.
    expect((await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'x@x.com' } })).status).toBe(202)
  })
})

// The per-kind budget exists so that a sign-up flood cannot take account recovery down with it.
// Password reset was spending the verification bucket, which undid exactly that.
describe('email budget is per kind', () => {
  it('a registration flood that exhausts verification mail still leaves password reset working', async () => {
    const { env, sent } = makeEnv({ EMAIL_DAILY_BUDGET: '2' })

    // A real account to recover, created before the flood.
    await register(env, 'victim@x.com')
    await wait(20)
    expect(sent.filter((m) => m.subject.startsWith("Confirm your")).length).toBe(1)

    // Spend what is left of the verification budget, then overrun it.
    await register(env, 'flood1@x.com')
    await register(env, 'flood2@x.com')
    await register(env, 'flood3@x.com')
    await wait(20)
    const verificationMails = sent.filter((m) => m.subject.startsWith("Confirm your")).length
    expect(verificationMails).toBe(2)

    sent.length = 0
    const forgot = await call(env, 'POST', '/api/auth/forgot-password', { json: { email: 'victim@x.com' } })
    expect(forgot.status).toBe(202)
    await wait(20)

    // The reset mail is sent from its own bucket, and a usable token was issued.
    expect(sent.length).toBe(1)
    const tokens = await env.DB.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE purpose = 'reset_password'")
      .first<{ n: number }>()
    expect(tokens?.n).toBe(1)
  })
})
