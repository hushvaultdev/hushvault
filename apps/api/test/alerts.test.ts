import { describe, expect, it, vi } from 'vitest'
import { createTestEnv } from './helpers/env'
import {
  HEARTBEAT_KEYS,
  evaluateAbsence,
  evaluateTickOutcome,
  raiseAlert,
  recordHeartbeat,
} from '../src/lib/alerts'
import { readSystemState, writeSystemState } from '../src/lib/system-state'

/** A send_email binding fake that records what it was asked to send. */
function envWithMailbox(overrides: Record<string, unknown> = {}) {
  const sent: Array<{ to: string; subject: string; text: string }> = []
  const env = createTestEnv({
    ALERT_EMAIL_TO: 'ops@hushvault.test',
    MAIL_FROM: 'no-reply@hushvault.test',
    EMAIL: { send: async (m: { to: string; subject: string; text: string }) => { sent.push(m) } },
    ...overrides,
  })
  return { env, sent }
}

const ELEVEN_MINUTES_AGO = () => new Date(Date.now() - 11 * 60 * 1000).toISOString()

describe('alerts: delivery', () => {
  it('sends an alert and records a dedupe marker', async () => {
    const { env, sent } = envWithMailbox()
    const result = await raiseAlert(env, { key: 'test.condition', severity: 'critical', summary: 'Something broke.' })

    expect(result).toBe('sent')
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('ops@hushvault.test')
    expect(sent[0].subject).toContain('CRITICAL')
    expect(sent[0].subject).toContain('test.condition')
    expect(await readSystemState(env, 'alerts.last_sent.test.condition')).not.toBeNull()
  })

  it('does nothing but log when ALERT_EMAIL_TO is unset — alerting off is not an error', async () => {
    const { env, sent } = envWithMailbox({ ALERT_EMAIL_TO: undefined })
    expect(await raiseAlert(env, { key: 'k', severity: 'warning', summary: 's' })).toBe('unconfigured')
    expect(sent).toHaveLength(0)
  })

  it('reports failed (not sent) when the mail provider refuses, and writes NO dedupe marker', async () => {
    // A failed send must retry on the next tick rather than suppress itself for an hour.
    const { env, sent } = envWithMailbox({
      EMAIL: { send: async () => { throw Object.assign(new Error('nope'), { code: 'SEND_FAILED' }) } },
    })
    expect(await raiseAlert(env, { key: 'test.flaky', severity: 'critical', summary: 's' })).toBe('failed')
    expect(sent).toHaveLength(0)
    expect(await readSystemState(env, 'alerts.last_sent.test.flaky')).toBeNull()
  })
})

describe('alerts: dedupe', () => {
  it('suppresses a repeat of the same key inside the resend window', async () => {
    const { env, sent } = envWithMailbox()
    expect(await raiseAlert(env, { key: 'dup.key', severity: 'warning', summary: 's' })).toBe('sent')
    expect(await raiseAlert(env, { key: 'dup.key', severity: 'warning', summary: 's' })).toBe('deduped')
    expect(sent).toHaveLength(1)
  })

  it('still sends a DIFFERENT key while one is deduped — one noisy condition cannot mask another', async () => {
    const { env, sent } = envWithMailbox()
    await raiseAlert(env, { key: 'noisy', severity: 'warning', summary: 's' })
    await raiseAlert(env, { key: 'noisy', severity: 'warning', summary: 's' })
    expect(await raiseAlert(env, { key: 'distinct', severity: 'critical', summary: 's' })).toBe('sent')
    expect(sent.map((m) => m.subject).filter((s) => s.includes('distinct'))).toHaveLength(1)
  })

  it('resends once the marker has aged past the window', async () => {
    const { env, sent } = envWithMailbox()
    await raiseAlert(env, { key: 'aged', severity: 'warning', summary: 's' })
    // Backdate the marker beyond the 1h resend window.
    await writeSystemState(env, 'alerts.last_sent.aged', 'warning', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
    expect(await raiseAlert(env, { key: 'aged', severity: 'warning', summary: 's' })).toBe('sent')
    expect(sent).toHaveLength(2)
  })
})

describe('alerts: absence detection', () => {
  it('alerts when the sync heartbeat is older than the threshold', async () => {
    const { env, sent } = envWithMailbox()
    await writeSystemState(env, HEARTBEAT_KEYS.sync, 'ok', ELEVEN_MINUTES_AGO())

    await evaluateAbsence(env, Date.now())

    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toContain('sync.tick.absent')
    expect(sent[0].text).toContain('has not run')
  })

  it('stays silent when the heartbeat is fresh', async () => {
    const { env, sent } = envWithMailbox()
    await recordHeartbeat(env, 'sync', new Date().toISOString())
    await evaluateAbsence(env, Date.now())
    expect(sent).toHaveLength(0)
  })

  it('stays silent when there is no heartbeat at all (fresh deploy, not an outage)', async () => {
    const { env, sent } = envWithMailbox()
    await evaluateAbsence(env, Date.now())
    expect(sent).toHaveLength(0)
  })
})

describe('alerts: tick outcomes', () => {
  it('alerts critically on a thrown rotation tick and carries the code', async () => {
    const { env, sent } = envWithMailbox()
    await evaluateTickOutcome(env, { rotation: 'error', rotationCode: 'KEY_VERSION_UNAVAILABLE', sync: 'ok', housekeeping: 'ok' })
    expect(sent).toHaveLength(1)
    expect(sent[0].subject).toContain('CRITICAL')
    expect(sent[0].text).toContain('KEY_VERSION_UNAVAILABLE')
  })

  it('alerts on thrown sync and housekeeping ticks', async () => {
    const { env, sent } = envWithMailbox()
    await evaluateTickOutcome(env, { rotation: 'idle', rotationCode: null, sync: 'threw', housekeeping: 'threw' })
    const subjects = sent.map((m) => m.subject).join('\n')
    expect(subjects).toContain('sync.tick_failed')
    expect(subjects).toContain('housekeeping.tick_failed')
  })

  it('stays silent on a fully healthy tick', async () => {
    const { env, sent } = envWithMailbox()
    await evaluateTickOutcome(env, { rotation: 'idle', rotationCode: null, sync: 'ok', housekeeping: 'ok' })
    expect(sent).toHaveLength(0)
  })
})

describe('alerts: safety properties', () => {
  it('never throws, even when D1 and the mail binding are both broken', async () => {
    // Alerting rides on the cron; it must not be able to take down key rotation or sync.
    const env = createTestEnv({
      ALERT_EMAIL_TO: 'ops@hushvault.test',
      MAIL_FROM: 'no-reply@hushvault.test',
      EMAIL: { send: async () => { throw new Error('mail down') } },
      DB: { prepare: () => { throw new Error('d1 down') } },
    })
    await expect(raiseAlert(env, { key: 'k', severity: 'critical', summary: 's' })).resolves.toBeDefined()
    await expect(evaluateAbsence(env, Date.now())).resolves.toBeUndefined()
    await expect(evaluateTickOutcome(env, { rotation: 'threw', rotationCode: null, sync: 'threw', housekeeping: 'threw' }))
      .resolves.toBeUndefined()
  })

  it('an alert body carries no secret material', async () => {
    const { env, sent } = envWithMailbox()
    await raiseAlert(env, {
      key: 'secret.decrypt_failed',
      severity: 'critical',
      summary: 'Could not decrypt a secret.',
      detail: { secretId: 'sec_abc123', reason: 'DECRYPTION_FAILED', count: 3 },
    })
    const body = `${sent[0].subject}\n${sent[0].text}`
    // Ids, codes and counts are fine; the master key and any plaintext must never appear.
    expect(body).toContain('DECRYPTION_FAILED')
    expect(body).toContain('sec_abc123')
    expect(body).not.toContain(env.ENCRYPTION_MASTER_KEY)
    expect(body).not.toContain(env.JWT_SECRET)
  })

  it('stops sending once the daily alert budget is spent', async () => {
    const { env, sent } = envWithMailbox()
    // 50/day ceiling; each distinct key consumes one. Spend past it.
    for (let i = 0; i < 55; i++) {
      await raiseAlert(env, { key: `burst.${i}`, severity: 'warning', summary: 's' })
    }
    expect(sent.length).toBeLessThanOrEqual(50)
    const last = await raiseAlert(env, { key: 'burst.after', severity: 'warning', summary: 's' })
    expect(last).toBe('budget')
  })
})
