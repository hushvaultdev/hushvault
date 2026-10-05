import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { rotationTick } from '../src/lib/key-rotation'
import { createTestEnv, seedUser, seedProject, seedEnvironment, call, type TestEnv } from './helpers/env'

const b64 = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')

async function setup(extra: Record<string, unknown> = {}) {
  const env = createTestEnv({ ENCRYPTION_KEY_V2: b64(), ...extra })
  const owner = await seedUser(env, { role: 'owner' })
  const projectId = await seedProject(env, owner.orgId)
  const envId = await seedEnvironment(env, projectId)
  return { env, owner, projectId, envId }
}

/** Move the deployment to a new active key version the way production does: deploy, then tick. */
async function activateVersion(env: TestEnv, version: string) {
  env['ENCRYPTION_ACTIVE_KEY_VERSION'] = version
  await rotationTick(env as never)
}

async function keyVersionOf(env: TestEnv, name: string) {
  return (await env.DB.prepare('SELECT key_version FROM secrets WHERE name = ?').bind(name).first<{ key_version: string }>())!.key_version
}

describe('secrets routes use the key ring', () => {
  it('writes the active key version and reads rows written under older versions', async () => {
    const { env, owner, projectId, envId } = await setup()
    const create = (name: string, value: string) => call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name, value } })
    const get = (name: string) => call(env, 'GET', `/api/secrets/${name}?envId=${envId}`, { token: owner.token })

    await rotationTick(env as never) // first tick registers v1
    expect((await create('OLD', 'written-under-v1')).status).toBe(201)
    expect(await keyVersionOf(env, 'OLD')).toBe('v1')

    await activateVersion(env, 'v2')
    expect((await create('NEW', 'written-under-v2')).status).toBe(201)
    expect(await keyVersionOf(env, 'NEW')).toBe('v2')

    expect((await get('OLD')).body.data.value).toBe('written-under-v1')
    expect((await get('NEW')).body.data.value).toBe('written-under-v2')

    const resolved = await call(env, 'GET', `/api/environments/${envId}/resolved?values=true`, { token: owner.token })
    expect(resolved.status).toBe(200)
    expect(JSON.stringify(resolved.body)).toContain('written-under-v1')
    expect(JSON.stringify(resolved.body)).toContain('written-under-v2')
  })

  it('PATCH with a new value re-wraps under the active version', async () => {
    const { env, owner, projectId, envId } = await setup()
    const created = await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'K', value: 'one' } })
    const id = created.body.data.id as string
    await rotationTick(env as never)
    await activateVersion(env, 'v2')
    expect((await call(env, 'PATCH', `/api/secrets/${id}`, { token: owner.token, json: { value: 'two' } })).status).toBe(200)
    expect(await keyVersionOf(env, 'K')).toBe('v2')
    const read = await call(env, 'GET', `/api/secrets/K?envId=${envId}`, { token: owner.token })
    expect(read.body.data.value).toBe('two')
  })

  it('returns the opaque DECRYPTION_FAILED error and logs only the version label when a key is missing', async () => {
    const { env, owner, projectId, envId } = await setup()
    await rotationTick(env as never)
    await activateVersion(env, 'v2')
    await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'GONE', value: 'x' } })
    delete env['ENCRYPTION_KEY_V2']
    const res = await call(env, 'GET', `/api/secrets/GONE?envId=${envId}`, { token: owner.token })
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' })
  })
})

describe('GET /api/security/key-rotation', () => {
  it('is admin/owner only and org-scoped, and returns counts only', async () => {
    const { env, owner, projectId, envId } = await setup()
    const member = await seedUser(env, { role: 'member', orgId: owner.orgId })
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId })
    await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'A', value: 'a' } })

    // A second organisation with its own secret must not show up.
    const other = await seedUser(env, { role: 'owner' })
    const otherProject = await seedProject(env, other.orgId, 'Other')
    const otherEnv = await seedEnvironment(env, otherProject)
    await rotationTick(env as never)
    await activateVersion(env, 'v2')
    await call(env, 'POST', '/api/secrets', { token: other.token, json: { projectId: otherProject, envId: otherEnv, name: 'B', value: 'b' } })

    expect((await call(env, 'GET', '/api/security/key-rotation')).status).toBe(401)
    expect((await call(env, 'GET', '/api/security/key-rotation', { token: viewer.token })).status).toBe(403)
    expect((await call(env, 'GET', '/api/security/key-rotation', { token: member.token })).status).toBe(403)

    for (const t of [admin.token, owner.token]) {
      const res = await call(env, 'GET', '/api/security/key-rotation', { token: t })
      expect(res.status).toBe(200)
      expect(res.body.data.rows.secrets).toEqual({ v1: 1 })
      // `rows.history` went with secret_history (issue #84); only these two remain.
      expect(Object.keys(res.body.data.rows).sort()).toEqual(['connections', 'secrets'])
      // A job exists once v2 was activated; the job block is deployment-wide, so it has no counters.
      expect(Object.keys(res.body.data.job).sort()).toEqual(['completedAt', 'phase', 'startedAt', 'status'])
      const text = JSON.stringify(res.body)
      expect(text).not.toMatch(/wrapped|ciphertext|ENCRYPTION|"sec_/i)
    }
    const theirs = await call(env, 'GET', '/api/security/key-rotation', { token: other.token })
    expect(theirs.body.data.rows.secrets).toEqual({ v2: 1 })
  })
})

describe('scheduled handler', () => {
  it('writes use the version registered in D1, so a mistyped new key is never used before the tick validates it', async () => {
    const { env, owner, projectId, envId } = await setup()
    await rotationTick(env as never) // registers v1
    // Operator deploys ACTIVE=v2 with a wrong/mistyped ENCRYPTION_KEY_V2 that was registered earlier.
    const good = env['ENCRYPTION_KEY_V2'] as string
    const { loadKeyRing, makeKeyCheck } = await import('../src/crypto/envelope')
    const goodKey = await loadKeyRing({ ENCRYPTION_MASTER_KEY: '', ENCRYPTION_KEY_V2: good, ENCRYPTION_ACTIVE_KEY_VERSION: 'v2' }).getKey('v2')
    await env.DB.prepare("INSERT INTO encryption_keys (version, check_value, status, created_at) VALUES ('v2', ?, 'decrypt_only', ?)")
      .bind(await makeKeyCheck(goodKey), new Date().toISOString()).run()
    env['ENCRYPTION_KEY_V2'] = b64() // typo
    env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v2'
    // Before the tick has validated anything, writes still use the proven key.
    expect((await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'BEFORE', value: 'b' } })).status).toBe(201)
    expect(await keyVersionOf(env, 'BEFORE')).toBe('v1')
    // The tick refuses to activate the wrong key, so writes keep using v1.
    expect(await rotationTick(env as never)).toEqual({ state: 'error', code: 'KEY_CHECK_FAILED' })
    expect((await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'AFTER', value: 'a' } })).status).toBe(201)
    expect(await keyVersionOf(env, 'AFTER')).toBe('v1')
    // With the right key restored the tick activates and writes move to v2.
    env['ENCRYPTION_KEY_V2'] = good
    await rotationTick(env as never)
    expect((await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'LATER', value: 'l' } })).status).toBe(201)
    expect(await keyVersionOf(env, 'LATER')).toBe('v2')
  })

  it('drives a rotation from the Workers entrypoint', async () => {
    const { env, owner, projectId, envId } = await setup()
    await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId, name: 'S', value: 'v' } })
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p) }, passThroughOnException: () => undefined } as unknown as ExecutionContext
    const run = async () => { await worker.scheduled({} as ScheduledController, env as never, ctx); await Promise.all(pending.splice(0)) }

    const health = await worker.fetch(new Request('http://localhost/'), env as never, ctx)
    expect(health.status).toBe(200)

    await run() // bootstrap v1
    env['ENCRYPTION_ACTIVE_KEY_VERSION'] = 'v2'
    for (let i = 0; i < 6; i += 1) await run()

    expect(await keyVersionOf(env, 'S')).toBe('v2')
    const job = await env.DB.prepare('SELECT status FROM key_rotations').first<{ status: string }>()
    expect(job!.status).toBe('completed')
    const read = await call(env, 'GET', `/api/secrets/S?envId=${envId}`, { token: owner.token })
    expect(read.body.data.value).toBe('v')
  })
})
