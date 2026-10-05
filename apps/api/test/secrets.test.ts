import { describe, it, expect, beforeEach } from 'vitest'
import { createTestEnv, seedUser, seedApiKey, seedProject, seedEnvironment, call, type TestEnv } from './helpers/env'
import { secretBlobKey } from '../src/lib/secret-blobs'

const PLAINTEXT = 'super-secret-plaintext-value-12345'

// Rate limiter also stores counters in KV, so only look at secret blobs. `secrethist:` is
// included so that a regression that started writing superseded copies again would be caught
// here rather than silently pass: issue #84 removed the only writer of that prefix.
function blobKeys(env: TestEnv) {
  return [...env.SECRETS_KV.store.keys()].filter((k) => k.startsWith('secret:') || k.startsWith('secrethist:'))
}

/** The KV key the row currently points at. Never hardcode the layout in a test. */
async function liveBlobKey(env: TestEnv, secretId: string) {
  const row = await env.DB.prepare('SELECT blob_rev FROM secrets WHERE id = ?').bind(secretId).first<{ blob_rev: number }>()
  return secretBlobKey(secretId, row?.blob_rev ?? 0)
}

async function setup() {
  const env = createTestEnv()
  const owner = await seedUser(env, { role: 'owner' })
  const member = await seedUser(env, { role: 'member', orgId: owner.orgId })
  const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
  const projectId = await seedProject(env, owner.orgId)
  const envId = await seedEnvironment(env, projectId)
  return { env, owner, member, viewer, projectId, envId }
}

async function create(env: TestEnv, token: string, projectId: string, envId: string, name = 'API_KEY', value = PLAINTEXT) {
  return call(env, 'POST', '/api/secrets', { token, json: { projectId, envId, name, value } })
}

describe('secrets routes', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  beforeEach(async () => { ctx = await setup() })

  it('creates and reads back a secret', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ name: 'API_KEY', projectId, envId, isComputed: false, template: null })
    const got = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: member.token })
    expect(got.status).toBe(200)
    expect(got.body.data.value).toBe(PLAINTEXT)
    expect(got.body.data.id).toBe(res.body.data.id)
  })

  it('stores no plaintext in KV', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    await call(env, 'PATCH', `/api/secrets/${res.body.data.id}`, { token: member.token, json: { value: 'second-plaintext-abc' } })
    expect(blobKeys(env).length).toBeGreaterThan(0)
    for (const k of blobKeys(env)) {
      const v = env.SECRETS_KV.store.get(k) as string
      expect(v).not.toContain(PLAINTEXT)
      expect(v).not.toContain('second-plaintext-abc')
    }
  })

  it('PATCH with only name keeps the stored value', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    const patch = await call(env, 'PATCH', `/api/secrets/${res.body.data.id}`, { token: member.token, json: { name: 'RENAMED' } })
    expect(patch.status).toBe(200)
    const got = await call(env, 'GET', `/api/secrets/RENAMED?envId=${envId}`, { token: member.token })
    expect(got.status).toBe(200)
    expect(got.body.data.value).toBe(PLAINTEXT)
  })

  it('PATCH with only isComputed keeps the stored value', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    await call(env, 'PATCH', `/api/secrets/${res.body.data.id}`, { token: member.token, json: { isComputed: true } })
    const got = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: member.token })
    expect(got.body.data.value).toBe(PLAINTEXT)
    expect(got.body.data.isComputed).toBe(true)
  })

  it('PATCH value writes a new revision and leaves the old one untouched', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    const id = res.body.data.id
    const oldKey = await liveBlobKey(env, id)
    const oldBlob = env.SECRETS_KV.store.get(oldKey)
    const oldRow = await env.DB.prepare('SELECT wrapped_dek, key_version, blob_rev FROM secrets WHERE id = ?').bind(id).first<{ wrapped_dek: string; key_version: string; blob_rev: number }>()
    const patch = await call(env, 'PATCH', `/api/secrets/${id}`, { token: member.token, json: { value: 'new-value' } })
    expect(patch.status).toBe(200)
    const got = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: member.token })
    expect(got.body.data.value).toBe('new-value')

    // Nothing records the superseded pair any more (issue #84): no history row, and no copy of
    // the old ciphertext under its own key. The old revision itself is still in KV, untouched —
    // that is the write-once rule, which has nothing to do with retention.
    expect(blobKeys(env).filter((k) => k.startsWith('secrethist:'))).toHaveLength(0)
    expect(oldRow?.wrapped_dek).toBeTruthy()
    const newRow = await env.DB.prepare('SELECT wrapped_dek, blob_rev FROM secrets WHERE id = ?').bind(id).first<{ wrapped_dek: string; blob_rev: number }>()
    expect(newRow?.wrapped_dek).not.toBe(oldRow?.wrapped_dek)
    expect(newRow?.blob_rev).toBe((oldRow?.blob_rev ?? 0) + 1)

    // The pointer moved to a key that did not exist before, and the old one is byte-identical.
    const newKey = await liveBlobKey(env, id)
    expect(newKey).not.toBe(oldKey)
    expect(env.SECRETS_KV.store.get(oldKey)).toBe(oldBlob)
    expect(env.SECRETS_KV.store.get(newKey)).not.toBe(oldBlob)
  })

  it('returns 409 on duplicate create and duplicate rename', async () => {
    const { env, member, projectId, envId } = ctx
    await create(env, member.token, projectId, envId, 'A')
    const dup = await create(env, member.token, projectId, envId, 'A')
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('CONFLICT')
    const b = await create(env, member.token, projectId, envId, 'B')
    const ren = await call(env, 'PATCH', `/api/secrets/${b.body.data.id}`, { token: member.token, json: { name: 'A' } })
    expect(ren.status).toBe(409)
    expect(ren.body.error).toBe('CONFLICT')
    // no orphan KV blob from the rejected create
    expect(blobKeys(env)).toHaveLength(2)
  })

  it('enforces viewer read-only', async () => {
    const { env, member, viewer, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    const id = res.body.data.id
    expect((await create(env, viewer.token, projectId, envId, 'X')).status).toBe(403)
    expect((await call(env, 'PATCH', `/api/secrets/${id}`, { token: viewer.token, json: { name: 'Y' } })).status).toBe(403)
    expect((await call(env, 'DELETE', `/api/secrets/${id}`, { token: viewer.token })).status).toBe(403)
    const list = await call(env, 'GET', `/api/secrets?envId=${envId}`, { token: viewer.token })
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(1)
    expect(list.body.data[0]).toHaveProperty('env_id')
    const got = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: viewer.token })
    expect(got.status).toBe(200)
    expect(got.body.data.value).toBe(PLAINTEXT)
  })

  it('isolates organisations', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    const other = await seedUser(env, { role: 'owner' })
    expect((await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: other.token })).status).toBe(404)
    expect((await call(env, 'PATCH', `/api/secrets/${res.body.data.id}`, { token: other.token, json: { name: 'Z' } })).status).toBe(404)
    expect((await call(env, 'DELETE', `/api/secrets/${res.body.data.id}`, { token: other.token })).status).toBe(404)
    expect((await create(env, other.token, projectId, envId, 'EVIL')).status).toBe(404)
    const list = await call(env, 'GET', `/api/secrets?envId=${envId}`, { token: other.token })
    expect(list.body.data).toHaveLength(0)
  })

  it('rejects invalid names on create and update', async () => {
    const { env, member, projectId, envId } = ctx
    for (const bad of ['1ABC', 'has space', 'a-b', 'a.b', '']) {
      const r = await create(env, member.token, projectId, envId, bad)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('VALIDATION_ERROR')
    }
    expect((await create(env, member.token, projectId, envId, 'A'.repeat(129))).status).toBe(400)
    const ok = await create(env, member.token, projectId, envId, '_ok_1')
    expect(ok.status).toBe(201)
    const r = await call(env, 'PATCH', `/api/secrets/${ok.body.data.id}`, { token: member.token, json: { name: 'bad-name' } })
    expect(r.status).toBe(400)
    expect(r.body.error).toBe('VALIDATION_ERROR')
  })

  it('rejects oversize values with 400 (by bytes)', async () => {
    const { env, member, projectId, envId } = ctx
    const tooMany = 'x'.repeat(65537)
    const multibyte = '€'.repeat(30000) // 30000 chars, 90000 bytes
    for (const value of [tooMany, multibyte]) {
      const r = await create(env, member.token, projectId, envId, 'BIG', value)
      expect(r.status).toBe(400)
      expect(r.body.error).toBe('VALIDATION_ERROR')
    }
    const okRes = await create(env, member.token, projectId, envId, 'OK', 'x'.repeat(65536))
    expect(okRes.status).toBe(201)
    const p = await call(env, 'PATCH', `/api/secrets/${okRes.body.data.id}`, { token: member.token, json: { value: multibyte } })
    expect(p.status).toBe(400)
    const p2 = await call(env, 'PATCH', `/api/secrets/${okRes.body.data.id}`, { token: member.token, json: { value: tooMany } })
    expect(p2.status).toBe(400)
  })

  it('delete removes every revision of the value', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    const id = res.body.data.id
    await call(env, 'PATCH', `/api/secrets/${id}`, { token: member.token, json: { value: 'v2' } })
    await call(env, 'PATCH', `/api/secrets/${id}`, { token: member.token, json: { value: 'v3' } })
    const keys = () => blobKeys(env)
    // Three values written, three revisions, no separate history copies.
    expect(keys()).toHaveLength(3)
    const del = await call(env, 'DELETE', `/api/secrets/${id}`, { token: member.token })
    expect(del.status).toBe(200)
    expect(keys()).toHaveLength(0)
    expect((await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: member.token })).status).toBe(404)
  })

  it('returns opaque DECRYPTION_FAILED when the blob is corrupt', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    env.SECRETS_KV.store.set(await liveBlobKey(env, res.body.data.id), 'not-a-valid-blob')
    const got = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: member.token })
    expect(got.status).toBe(500)
    expect(got.body).toEqual({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' })
  })

  it('cleans up KV when the D1 insert fails', async () => {
    const { env, member, projectId, envId } = ctx
    env.DB.sqlite.exec('CREATE TRIGGER fail_insert BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT, \'boom\'); END')
    const res = await create(env, member.token, projectId, envId)
    expect(res.status).toBe(500)
    expect(JSON.stringify(res.body)).not.toContain('boom')
    expect(blobKeys(env)).toHaveLength(0)
  })

  // The whole point of the write-once layout: a failed D1 write cannot desynchronise KV
  // from D1, so there is nothing to roll back and the secret stays readable. The old code
  // overwrote the live key first and compensated with a second write to the same key,
  // which KV's one-write-per-second-per-key limit makes unreliable.
  it('leaves the secret readable when the D1 update fails', async () => {
    const { env, member, projectId, envId } = ctx
    const res = await create(env, member.token, projectId, envId)
    const id = res.body.data.id
    const liveKey = await liveBlobKey(env, id)
    const oldBlob = env.SECRETS_KV.store.get(liveKey)
    expect(oldBlob).toBeTruthy()

    env.DB.sqlite.exec('CREATE TRIGGER fail_update BEFORE UPDATE ON secrets BEGIN SELECT RAISE(ABORT, \'boom\'); END')
    const p = await call(env, 'PATCH', `/api/secrets/${id}`, { token: member.token, json: { value: 'nope' } })
    expect(p.status).toBe(500)

    // The pointer never moved, and the bytes it points at were never touched.
    expect(await liveBlobKey(env, id)).toBe(liveKey)
    expect(env.SECRETS_KV.store.get(liveKey)).toBe(oldBlob)

    // And the secret is still decryptable, which is what the old design could not guarantee.
    env.DB.sqlite.exec('DROP TRIGGER fail_update')
    const got = await call(env, 'GET', `/api/secrets/API_KEY?envId=${envId}`, { token: member.token })
    expect(got.status).toBe(200)
    expect(got.body.data.value).toBe(PLAINTEXT)
  })

  it('works with API-key bearer auth for a member', async () => {
    const { env, member, projectId, envId } = ctx
    const { rawKey } = await seedApiKey(env, member.userId)
    const res = await create(env, rawKey, projectId, envId, 'VIA_KEY', 'kv')
    expect(res.status).toBe(201)
    const got = await call(env, 'GET', `/api/secrets/VIA_KEY?envId=${envId}`, { token: rawKey })
    expect(got.body.data.value).toBe('kv')
  })
})
