import { describe, expect, it } from 'vitest'
import { TOKEN_TTL_MS, consumeToken, issueToken, purgeExpiredTokens } from '../src/lib/auth-tokens'
import { createTestEnv, seedUser } from './helpers/env'

async function setup() {
  const env = createTestEnv()
  const user = await seedUser(env, { email: 'owner@example.test' })
  return { env, user }
}

describe('auth tokens', () => {
  it('issues unique 256-bit tokens and stores only their hash', async () => {
    const { env, user } = await setup()
    const a = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email })
    const b = await issueToken(env as never, { userId: user.userId, purpose: 'reset_password', email: user.email })
    expect(a.token).not.toBe(b.token)
    expect(Buffer.from(a.token, 'base64url')).toHaveLength(32)
    const rows = (await env.DB.prepare('SELECT * FROM auth_tokens').all<Record<string, unknown>>()).results
    expect(rows).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain(a.token)
    expect(JSON.stringify(rows)).not.toContain(b.token)
  })

  it('redeems once and then refuses', async () => {
    const { env, user } = await setup()
    const { token } = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email })
    expect(await consumeToken(env as never, { token, purpose: 'verify_email' })).toEqual({ userId: user.userId, email: user.email })
    expect(await consumeToken(env as never, { token, purpose: 'verify_email' })).toBeNull()
  })

  it('lets exactly one of several concurrent redemptions succeed', async () => {
    const { env, user } = await setup()
    const { token } = await issueToken(env as never, { userId: user.userId, purpose: 'reset_password', email: user.email })
    const results = await Promise.all(Array.from({ length: 8 }, () => consumeToken(env as never, { token, purpose: 'reset_password' })))
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it('does not accept a token for the wrong purpose, and the wrong attempt does not burn it', async () => {
    const { env, user } = await setup()
    const { token } = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email })
    expect(await consumeToken(env as never, { token, purpose: 'reset_password' })).toBeNull()
    expect(await consumeToken(env as never, { token, purpose: 'verify_email' })).not.toBeNull()
  })

  it('expires: verify after 24 h, reset after 60 min', async () => {
    const { env, user } = await setup()
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const verify = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email, now: t0 })
    const reset = await issueToken(env as never, { userId: user.userId, purpose: 'reset_password', email: user.email, now: t0 })
    const at = (ms: number) => new Date(t0.getTime() + ms)
    expect(await consumeToken(env as never, { token: reset.token, purpose: 'reset_password', now: at(TOKEN_TTL_MS.reset_password) })).toBeNull() // exactly at expiry
    expect(await consumeToken(env as never, { token: verify.token, purpose: 'verify_email', now: at(TOKEN_TTL_MS.reset_password + 1) })).not.toBeNull()
    const verify2 = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email, now: t0 })
    expect(await consumeToken(env as never, { token: verify2.token, purpose: 'verify_email', now: at(TOKEN_TTL_MS.verify_email + 1) })).toBeNull()
  })

  it('a newer token supersedes the previous one of the same purpose', async () => {
    const { env, user } = await setup()
    const first = await issueToken(env as never, { userId: user.userId, purpose: 'reset_password', email: user.email })
    const second = await issueToken(env as never, { userId: user.userId, purpose: 'reset_password', email: user.email })
    expect(await consumeToken(env as never, { token: first.token, purpose: 'reset_password' })).toBeNull()
    expect(await consumeToken(env as never, { token: second.token, purpose: 'reset_password' })).not.toBeNull()
  })

  it('stops working if the account email changed after issue', async () => {
    const { env, user } = await setup()
    const { token } = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email })
    await env.DB.prepare('UPDATE users SET email = ? WHERE id = ?').bind('changed@example.test', user.userId).run()
    expect(await consumeToken(env as never, { token, purpose: 'verify_email' })).toBeNull()
  })

  it('rejects malformed and unknown tokens identically (null)', async () => {
    const { env } = await setup()
    for (const token of ['', 'short', 'x'.repeat(300), 'not-a-real-token-but-long-enough-0123456789']) {
      expect(await consumeToken(env as never, { token, purpose: 'verify_email' })).toBeNull()
    }
  })

  it('is deleted with the user and purged when expired or used', async () => {
    const { env, user } = await setup()
    const t0 = new Date('2026-01-01T00:00:00.000Z')
    const { token } = await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email, now: t0 })
    await purgeExpiredTokens(env as never, new Date(t0.getTime() + 1000))
    expect((await env.DB.prepare('SELECT count(*) AS n FROM auth_tokens').first<{ n: number }>())!.n).toBe(1) // still valid
    await consumeToken(env as never, { token, purpose: 'verify_email', now: new Date(t0.getTime() + 1000) })
    await purgeExpiredTokens(env as never, new Date(t0.getTime() + 2000))
    expect((await env.DB.prepare('SELECT count(*) AS n FROM auth_tokens').first<{ n: number }>())!.n).toBe(0)
    await issueToken(env as never, { userId: user.userId, purpose: 'verify_email', email: user.email })
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.userId).run()
    expect((await env.DB.prepare('SELECT count(*) AS n FROM auth_tokens').first<{ n: number }>())!.n).toBe(0)
  })
})
