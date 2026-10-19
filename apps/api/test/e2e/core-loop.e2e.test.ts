// Primary secrets round-trip: register → org → project → env → secret CRUD → resolved.
// All against live dev. Cleans up by deleting the throwaway user's account at the end.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { api, createProjectAndEnv, makeRunId, registerThrowawayUser, teardownAccount } from './_helpers'

describe('[core-loop] write, read, update, delete a secret end-to-end', () => {
  const runId = makeRunId()
  let user: Awaited<ReturnType<typeof registerThrowawayUser>>
  let projectId = ''
  let envId = ''
  let secretId = ''
  const secretName = `E2E_K_${runId.replace(/-/g, '_')}`
  const value1 = `v1_${runId}`
  const value2 = `v2_${runId}`

  beforeAll(async () => {
    user = await registerThrowawayUser({ runId })
    const made = await createProjectAndEnv(user.token, runId)
    projectId = made.projectId
    envId = made.envId
  })

  afterAll(async () => {
    if (user) await teardownAccount(user.token, user.password)
  })

  it('creates a secret', async () => {
    const res = await api('/api/secrets', {
      method: 'POST',
      token: user.token,
      json: { projectId, envId, name: secretName, value: value1 },
    })
    expect(res.status).toBe(201)
    const body = res.body as { data: { id: string; name: string } }
    expect(body.data.name).toBe(secretName)
    secretId = body.data.id
  })

  it('reads the plaintext back on /environments/:id/resolved', async () => {
    const res = await api(`/api/environments/${envId}/resolved`, { token: user.token })
    expect(res.status).toBe(200)
    const body = res.body as { data: Record<string, string> | Array<{ name: string; value: string }> }
    const asRecord = Array.isArray(body.data)
      ? Object.fromEntries(body.data.map((r) => [r.name, r.value]))
      : body.data
    expect(asRecord[secretName]).toBe(value1)
  })

  it('updates the secret and sees the new value', async () => {
    const patch = await api(`/api/secrets/${secretId}`, {
      method: 'PATCH',
      token: user.token,
      json: { value: value2 },
    })
    expect(patch.status).toBe(200)
    const res = await api(`/api/environments/${envId}/resolved`, { token: user.token })
    const body = res.body as { data: Record<string, string> | Array<{ name: string; value: string }> }
    const asRecord = Array.isArray(body.data)
      ? Object.fromEntries(body.data.map((r) => [r.name, r.value]))
      : body.data
    expect(asRecord[secretName]).toBe(value2)
  })

  it('deletes the secret; it is gone from resolved', async () => {
    const del = await api(`/api/secrets/${secretId}`, { method: 'DELETE', token: user.token })
    expect([200, 204]).toContain(del.status)
    const res = await api(`/api/environments/${envId}/resolved`, { token: user.token })
    const body = res.body as { data: Record<string, string> | Array<{ name: string; value: string }> }
    const asRecord = Array.isArray(body.data)
      ? Object.fromEntries(body.data.map((r) => [r.name, r.value]))
      : body.data
    expect(asRecord[secretName]).toBeUndefined()
  })

  it('issues an API key, then requireHuman blocks it on /api/orgs', async () => {
    const issue = await api('/api/auth/api-keys', {
      method: 'POST',
      token: user.token,
      json: { name: `e2e-key-${runId}` },
    })
    expect(issue.status).toBe(201)
    const key = (issue.body as { data: { token: string } }).data.token
    expect(key).toMatch(/^hv_live_/)
    const blocked = await api('/api/orgs', { token: key })
    expect(blocked.status).toBe(403)
    const body = blocked.body as { error?: string }
    expect(body.error).toBeDefined()
  })
})
