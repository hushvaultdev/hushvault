import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import {
  CloudflareEmailSender,
  UnconfiguredEmailSender,
  getEmailSender,
  mapEmailError,
  sendEmail,
  type EmailMessage,
  type EmailSender,
} from '../src/lib/email'
import { buildTokenLink, passwordChangedMessage, resetPasswordMessage, verifyEmailMessage } from '../src/lib/email-templates'
import { runBackground } from '../src/lib/background'
import { consumeIdentityLimit, identityKey } from '../src/middleware/rate-limit'
import { createTestEnv } from './helpers/env'

const TOKEN = 'dGVzdC10b2tlbi10ZXN0LXRva2VuLXRlc3QtdG9rZW4'
const msg = (): EmailMessage => ({ to: 'victim@example.test', subject: 's', text: `t ${TOKEN}`, html: `<p>${TOKEN}</p>` })

describe('email templates', () => {
  it('put the token in the URL fragment only and take the base from WEB_APP_URL', () => {
    const link = buildTokenLink({ WEB_APP_URL: 'https://beta.hushvault.dev/some/path?x=1' }, '/reset-password', TOKEN)
    expect(link).toBe(`https://beta.hushvault.dev/reset-password#token=${TOKEN}`)
    expect(link).not.toContain('?')
    for (const m of [verifyEmailMessage('a@example.test', link!), resetPasswordMessage('a@example.test', link!)]) {
      expect(m.text).toContain('#token=')
      expect(m.html).toContain('#token=')
      expect(m.text).not.toMatch(/[?&]token=/)
      expect(m.html).not.toMatch(/[?&]token=/)
      expect(m.text.toLowerCase()).toContain('ignore')
    }
  })

  it('refuses to build a link without a valid WEB_APP_URL or a relative path', () => {
    expect(buildTokenLink({}, '/verify-email', TOKEN)).toBeNull()
    expect(buildTokenLink({ WEB_APP_URL: 'not a url' }, '/verify-email', TOKEN)).toBeNull()
    expect(buildTokenLink({ WEB_APP_URL: 'https://beta.hushvault.dev' }, 'verify-email', TOKEN)).toBeNull()
  })

  it('escapes HTML in links and never contains a password', () => {
    const m = verifyEmailMessage('a@example.test', 'https://x.test/a#token="><script>alert(1)</script>')
    expect(m.html).not.toContain('<script>')
    expect(passwordChangedMessage('a@example.test').text.toLowerCase()).not.toContain('password:')
  })
})

describe('email sender', () => {
  let logs: string[]
  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { logs.push(String(m)) })
    vi.spyOn(console, 'warn').mockImplementation((m: unknown) => { logs.push(String(m)) })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('is unconfigured without a binding or MAIL_FROM, and never throws', async () => {
    expect(getEmailSender({})).toBeInstanceOf(UnconfiguredEmailSender)
    expect(getEmailSender({ MAIL_FROM: 'no-reply@hushvault.dev' })).toBeInstanceOf(UnconfiguredEmailSender)
    expect(getEmailSender({ EMAIL: { send: async () => ({}) } })).toBeInstanceOf(UnconfiguredEmailSender)
    expect(await sendEmail({}, msg())).toEqual({ ok: false, code: 'EMAIL_NOT_CONFIGURED' })
  })

  it('sends through the binding with the configured from address', async () => {
    const calls: unknown[] = []
    const sender = getEmailSender({ EMAIL: { send: async (m) => { calls.push(m); return { messageId: 'x' } } }, MAIL_FROM: 'no-reply@hushvault.dev' })
    expect(sender).toBeInstanceOf(CloudflareEmailSender)
    expect(await sender.send(msg())).toEqual({ ok: true })
    expect(calls).toEqual([{ from: 'no-reply@hushvault.dev', to: 'victim@example.test', subject: 's', text: `t ${TOKEN}`, html: `<p>${TOKEN}</p>` }])
  })

  it('maps provider error codes and hides provider detail', () => {
    const e = (code: string) => Object.assign(new Error('provider detail with victim@example.test'), { code })
    expect(mapEmailError(e('E_RECIPIENT_SUPPRESSED'))).toBe('RECIPIENT_SUPPRESSED')
    expect(mapEmailError(e('E_RATE_LIMIT_EXCEEDED'))).toBe('RATE_LIMITED')
    expect(mapEmailError(e('E_DAILY_LIMIT_EXCEEDED'))).toBe('RATE_LIMITED')
    expect(mapEmailError(e('E_SENDER_NOT_VERIFIED'))).toBe('SENDER_NOT_VERIFIED')
    expect(mapEmailError(new Error('boom'))).toBe('SEND_FAILED')
    expect(mapEmailError(null)).toBe('SEND_FAILED')
  })

  it('swallows failures and logs only a code, never the address, link or token', async () => {
    const failing: EmailSender = { send: async () => { throw Object.assign(new Error('victim@example.test ' + TOKEN), { code: 'E_X' }) } }
    expect(await sendEmail({}, msg(), failing)).toEqual({ ok: false, code: 'SEND_FAILED' })
    const suppressed = new CloudflareEmailSender({ send: async () => { throw Object.assign(new Error('x'), { code: 'E_RECIPIENT_SUPPRESSED' }) } }, 'no-reply@hushvault.dev')
    expect(await sendEmail({}, msg(), suppressed)).toEqual({ ok: false, code: 'RECIPIENT_SUPPRESSED' })
    const out = logs.join('\n')
    expect(out).toContain('RECIPIENT_SUPPRESSED')
    expect(out).not.toContain('victim@example.test')
    expect(out).not.toContain(TOKEN)
  })
})

describe('runBackground', () => {
  it('awaits the work when there is no execution context and swallows its errors', async () => {
    const app = new Hono()
    let done = false
    app.get('/', async (c) => {
      await runBackground(c, (async () => { await Promise.resolve(); done = true; throw new Error('ignored') })())
      return c.text(done ? 'done' : 'not done')
    })
    const res = await app.request('/')
    expect(await res.text()).toBe('done')
  })

  it('hands the work to waitUntil when a context exists', async () => {
    const app = new Hono()
    app.get('/', async (c) => { await runBackground(c, Promise.resolve()); return c.text('ok') })
    const waited: Promise<unknown>[] = []
    const res = await app.request('/', {}, {}, { waitUntil: (p: Promise<unknown>) => { waited.push(p) }, passThroughOnException: () => undefined } as unknown as ExecutionContext)
    expect(await res.text()).toBe('ok')
    expect(waited).toHaveLength(1)
  })
})

describe('per-identity rate limit helper', () => {
  it('hashes identities so object names carry no PII, case-insensitively', async () => {
    const a = await identityKey('Victim@Example.test ')
    expect(a).toBe(await identityKey('victim@example.test'))
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toContain('victim')
  })

  it('limits per identity and scope independently', async () => {
    const env = createTestEnv()
    const one = await identityKey('one@example.test')
    const two = await identityKey('two@example.test')
    const hit = (identity: string, scope = 'forgot-email') => consumeIdentityLimit(env as never, { scope, identity, limit: 3, windowMs: 60_000 })
    expect([await hit(one), await hit(one), await hit(one)].map((r) => 'allowed' in r && r.allowed)).toEqual([true, true, true])
    expect(await hit(one)).toMatchObject({ allowed: false })
    expect(await hit(two)).toMatchObject({ allowed: true })
    expect(await hit(one, 'other-scope')).toMatchObject({ allowed: true })
  })

  it('reports unavailable when the limiter backend fails', async () => {
    const env = createTestEnv({ RATE_LIMITER: { idFromName: () => { throw new Error('down') }, get: () => { throw new Error('down') } } })
    expect(await consumeIdentityLimit(env as never, { scope: 's', identity: 'i', limit: 1, windowMs: 1000 })).toEqual({ unavailable: true })
  })
})
