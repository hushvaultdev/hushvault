// Cloudflare Workers sync integration end-to-end.
// Writes a HushVault secret, runs the sync, verifies independently via the CF API that the secret
// landed on the sink Worker, then tears down (connection, target, Worker secret, account).
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, cfApi, CF_ACCOUNT_ID, CF_SCRIPT, CF_TOKEN, createProjectAndEnv, makeRunId, registerThrowawayUser, teardownAccount, waitFor } from './_helpers'

describe('[cf-workers-sync] push a HushVault secret to a real Worker and verify independently', () => {
  const runId = makeRunId()
  let user: Awaited<ReturnType<typeof registerThrowawayUser>>
  let projectId = ''
  let envId = ''
  let connectionId = ''
  let targetId = ''
  const secretName = `E2E_SYNC_${runId.replace(/-/g, '_').toUpperCase()}`
  const value = `v_${runId}`

  beforeAll(async () => {
    user = await registerThrowawayUser({ runId })
    const made = await createProjectAndEnv(user.token, runId)
    projectId = made.projectId
    envId = made.envId
  })

  afterAll(async () => {
    // Best-effort: remove the Worker secret if we created it.
    try {
      await cfApi(`/accounts/${CF_ACCOUNT_ID()}/workers/scripts/${CF_SCRIPT()}/secrets-bulk`, {
        method: 'PATCH',
        json: { secrets: { [secretName]: null } },
      })
    } catch { /* ignore */ }
    if (user) await teardownAccount(user.token, user.password)
  })

  it('registers a cloudflare-workers connection', async () => {
    const res = await api('/api/integrations/connections', {
      method: 'POST',
      token: user.token,
      json: {
        provider: 'cloudflare-workers',
        label: `e2e-conn-${runId}`,
        credential: CF_TOKEN(),
        config: { accountId: CF_ACCOUNT_ID() },
      },
    })
    expect(res.status).toBe(201)
    connectionId = (res.body as { data: { id: string } }).data.id
  })

  it('creates a sync target for the sink Worker', async () => {
    const res = await api('/api/integrations/targets', {
      method: 'POST',
      token: user.token,
      json: {
        projectId,
        envId,
        connectionId,
        resource: { accountId: CF_ACCOUNT_ID(), scriptName: CF_SCRIPT() },
      },
    })
    expect(res.status).toBe(201)
    targetId = (res.body as { data: { id: string } }).data.id
  })

  it('creates a secret and runs the sync', async () => {
    const seed = await api('/api/secrets', {
      method: 'POST',
      token: user.token,
      json: { projectId, envId, name: secretName, value },
    })
    expect(seed.status).toBe(201)

    const run = await api(`/api/integrations/targets/${targetId}/run`, { method: 'POST', token: user.token })
    expect([200, 202]).toContain(run.status)
    const runId2 = (run.body as { data: { runId?: string; id?: string } }).data?.runId
      ?? (run.body as { data: { runId?: string; id?: string } }).data?.id
    expect(runId2).toBeTruthy()

    // Poll until success (or timeout).
    await waitFor(async () => {
      const r = await api(`/api/integrations/runs/${runId2}`, { token: user.token })
      const status = (r.body as { data?: { status?: string } }).data?.status
      if (status === 'success') return true
      if (status === 'failed' || status === 'error') {
        throw new Error(`sync run ended with status=${status}: ${JSON.stringify(r.body)}`)
      }
      return null
    }, { timeoutMs: 45_000, intervalMs: 1500 })
  })

  it('secret is present on the sink Worker (independent CF API check)', async () => {
    const res = await cfApi(`/accounts/${CF_ACCOUNT_ID()}/workers/scripts/${CF_SCRIPT()}/secrets`)
    expect(res.status).toBe(200)
    const body = res.body as { result: Array<{ name: string }> }
    const names = body.result.map((s) => s.name)
    expect(names).toContain(secretName)
  })

  it('tears down the target and connection', async () => {
    const dt = await api(`/api/integrations/targets/${targetId}`, { method: 'DELETE', token: user.token })
    expect([200, 204]).toContain(dt.status)
    const dc = await api(`/api/integrations/connections/${connectionId}`, { method: 'DELETE', token: user.token })
    expect([200, 204]).toContain(dc.status)
  })
})
