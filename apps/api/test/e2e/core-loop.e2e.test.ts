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

  function resolvedValueOf(body: unknown, name: string): string | undefined {
    const data = (body as { data?: { secrets?: Array<{ name: string; value?: string }> } }).data
    const row = data?.secrets?.find((s) => s.name === name)
    return row?.value
  }

  it('reads the plaintext back on /environments/:id/resolved?values=true', async () => {
    const res = await api(`/api/environments/${envId}/resolved?values=true`, { token: user.token })
    expect(res.status).toBe(200)
    expect(resolvedValueOf(res.body, secretName)).toBe(value1)
  })

  it('updates the secret and sees the new value', async () => {
    const patch = await api(`/api/secrets/${secretId}`, {
      method: 'PATCH',
      token: user.token,
      json: { value: value2 },
    })
    expect(patch.status).toBe(200)
    const res = await api(`/api/environments/${envId}/resolved?values=true`, { token: user.token })
    expect(resolvedValueOf(res.body, secretName)).toBe(value2)
  })

  it('deletes the secret; it is gone from resolved', async () => {
    const del = await api(`/api/secrets/${secretId}`, { method: 'DELETE', token: user.token })
    expect([200, 204]).toContain(del.status)
    const res = await api(`/api/environments/${envId}/resolved?values=true`, { token: user.token })
    expect(resolvedValueOf(res.body, secretName)).toBeUndefined()
  })

  it('issues an API key; requireHuman blocks it on POST /api/orgs; GET /api/orgs is still allowed', async () => {
    const issue = await api('/api/auth/api-keys', {
      method: 'POST',
      token: user.token,
      json: { name: `e2e-key-${runId}` },
    })
    expect(issue.status).toBe(201)
    const key = (issue.body as { data: { apiKey: string } }).data.apiKey
    expect(key).toMatch(/^hv_live_/)

    // Read-only endpoints accept an API key.
    const listed = await api('/api/orgs', { token: key })
    expect(listed.status).toBe(200)

    // Writing a new org requires requireHuman — must reject the API key.
    const blocked = await api('/api/orgs', {
      method: 'POST',
      token: key,
      json: { name: `blocked-${runId}` },
    })
    expect(blocked.status).toBe(403)
    const body = blocked.body as { error?: string }
    expect(body.error).toBeDefined()
  })
})
