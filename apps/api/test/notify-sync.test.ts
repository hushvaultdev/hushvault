import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { notifySyncNeedsAttention } from '../src/lib/notify'
import { createTestEnv, seedUser, type TestEnv } from './helpers/env'

let env: TestEnv
let sent: { to: string; subject: string; text: string; html: string }[]
let logged: string[]

beforeEach(() => {
  env = createTestEnv()
  sent = []
  logged = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

function withMail(e: TestEnv) {
  return Object.assign(e, {
    EMAIL: { send: async (m: { to: string; subject: string; text: string; html: string }) => { sent.push(m); return {} } },
    MAIL_FROM: 'no-reply@hushvault.dev',
    WEB_APP_URL: 'https://beta.hushvault.dev',
  })
}

describe('notifySyncNeedsAttention', () => {
  it('emails every owner with non-secret facts and a dashboard link, and writes one audit row', async () => {
    const owner1 = await seedUser(env, { role: 'owner' })
    const owner2 = await seedUser(env, { role: 'owner', orgId: owner1.orgId })
    await seedUser(env, { role: 'admin', orgId: owner1.orgId }) // not an owner: must not be emailed

    await notifySyncNeedsAttention(withMail(env) as never, {
      orgId: owner1.orgId, targetId: 'ist_abc123', provider: 'cloudflare-workers', errorCode: 'PROVIDER_AUTH',
    })

    expect(sent.map((m) => m.to).sort()).toEqual([owner1.email, owner2.email].sort())
    for (const m of sent) {
      expect(m.text).toContain('ist_abc123')
      expect(m.text).toContain('cloudflare-workers')
      expect(m.text).toContain('PROVIDER_AUTH')
      expect(m.text).toContain('https://beta.hushvault.dev/integrations')
    }
    const audit = await env.DB.prepare("SELECT resource_id, actor_type FROM audit_log WHERE action = 'notify.sync_needs_attention'").all<{ resource_id: string; actor_type: string }>()
    expect(audit.results).toEqual([{ resource_id: 'ist_abc123', actor_type: 'system' }])
  })

  it('writes the audit row but sends nothing when the org has no owner, and never throws', async () => {
    const admin = await seedUser(env, { role: 'admin' })
    await expect(notifySyncNeedsAttention(withMail(env) as never, {
      orgId: admin.orgId, targetId: 'ist_x', provider: 'cloudflare-workers', errorCode: 'CREDENTIAL_UNAVAILABLE',
    })).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'notify.sync_needs_attention'").first<{ n: number }>())?.n).toBe(1)
  })

  it('does not throw when email is unconfigured (still writes the audit row)', async () => {
    const owner = await seedUser(env, { role: 'owner' })
    await expect(notifySyncNeedsAttention(env as never, {
      orgId: owner.orgId, targetId: 'ist_y', provider: 'cloudflare-workers', errorCode: 'PROVIDER_RATE_LIMIT',
    })).resolves.toBeUndefined()
    expect(sent).toHaveLength(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'notify.sync_needs_attention'").first<{ n: number }>())?.n).toBe(1)
  })
})
