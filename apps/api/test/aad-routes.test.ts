import { describe, expect, it } from 'vitest'
import { encryptSecret } from '../src/crypto/envelope'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser } from './helpers/env'
import { seedSecret } from './helpers/env-secrets'

async function setup() {
  const env = createTestEnv()
  const owner = await seedUser(env, { role: 'owner' })
  const projectId = await seedProject(env, owner.orgId)
  const prod = await seedEnvironment(env, projectId, 'prod')
  const staging = await seedEnvironment(env, projectId, 'staging')
  const read = (name: string, envId: string) => call(env, 'GET', `/api/secrets/${name}?envId=${envId}`, { token: owner.token })
  return { env, owner, projectId, prod, staging, read }
}

describe('AAD binding through the API', () => {
  it('new secrets are stored as enc_version 2 and read back', async () => {
    const { env, owner, projectId, prod, read } = await setup()
    const created = await call(env, 'POST', '/api/secrets', { token: owner.token, json: { projectId, envId: prod, name: 'K', value: 'v1' } })
    expect(created.status).toBe(201)
    const row = await env.DB.prepare('SELECT enc_version FROM secrets WHERE id = ?').bind(created.body.data.id).first<{ enc_version: number }>()
    expect(row?.enc_version).toBe(2)
    expect((await read('K', prod)).body.data.value).toBe('v1')
    await call(env, 'PATCH', `/api/secrets/${created.body.data.id}`, { token: owner.token, json: { value: 'v2' } })
    expect((await read('K', prod)).body.data.value).toBe('v2')
    const hist = await env.DB.prepare('SELECT enc_version FROM secret_history WHERE secret_id = ?').bind(created.body.data.id).first<{ enc_version: number }>()
    expect(hist?.enc_version).toBe(2)
  })

  it('ATTACK: moving a prod secret row (blob + wrapped DEK) into staging fails closed', async () => {
    const { env, projectId, prod, staging, read } = await setup()
    const id = await seedSecret(env, projectId, prod, 'DB_URL', 'prod-secret')
    // Attacker with D1 write re-labels the row as a staging secret.
    await env.DB.prepare('UPDATE secrets SET env_id = ? WHERE id = ?').bind(staging, id).run()
    const res = await read('DB_URL', staging)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('DECRYPTION_FAILED')
    expect(JSON.stringify(res.body)).not.toContain('prod-secret')
  })

  it('ATTACK: swapping two secrets blob + wrapped DEK fails closed', async () => {
    const { env, projectId, prod, read } = await setup()
    const a = await seedSecret(env, projectId, prod, 'A', 'value-a')
    const b = await seedSecret(env, projectId, prod, 'B', 'value-b')
    const rows = await env.DB.prepare('SELECT id, wrapped_dek FROM secrets WHERE id IN (?, ?)').bind(a, b).all<{ id: string; wrapped_dek: string }>()
    const dek = new Map(rows.results.map((r) => [r.id, r.wrapped_dek]))
    const blobA = await env.SECRETS_KV.get(`secret:${a}`)
    const blobB = await env.SECRETS_KV.get(`secret:${b}`)
    await env.SECRETS_KV.put(`secret:${a}`, blobB as string)
    await env.DB.prepare('UPDATE secrets SET wrapped_dek = ? WHERE id = ?').bind(dek.get(b), a).run()
    expect(blobA).not.toBeNull()
    expect((await read('A', prod)).status).toBe(500)
  })

  it('legacy (enc_version 1) rows still read until ENFORCE_AAD=true', async () => {
    const { env, projectId, prod, read } = await setup()
    const id = 'sec_legacy'
    const legacy = await encryptSecret('old-value', env.ENCRYPTION_MASTER_KEY)
    await env.SECRETS_KV.put(`secret:${id}`, legacy.encryptedValue)
    const now = new Date().toISOString()
    await env.DB.prepare(
      "INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, key_version, is_computed, dependencies, created_at, updated_at) VALUES (?, ?, ?, 'OLD', ?, 'v1', 0, '[]', ?, ?)",
    ).bind(id, projectId, prod, legacy.wrappedDek, now, now).run()
    expect((await read('OLD', prod)).body.data.value).toBe('old-value')
    ;(env as unknown as Record<string, string>)['ENFORCE_AAD'] = 'true'
    expect((await read('OLD', prod)).status).toBe(500)
  })
})
