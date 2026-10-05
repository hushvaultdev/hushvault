import { beforeEach, describe, expect, it, vi } from 'vitest'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { seedComputed, seedSecret } from './helpers/env-secrets'

let env: TestEnv
let owner: Awaited<ReturnType<typeof seedUser>>
let projectId: string

beforeEach(async () => {
  env = createTestEnv()
  owner = await seedUser(env, { role: 'owner' })
  projectId = await seedProject(env, owner.orgId)
})

const get = (id: string, token: string, values = false) =>
  call(env, 'GET', `/api/environments/${id}/resolved${values ? '?values=true' : ''}`, { token })

describe('GET /api/environments/:id/resolved', () => {
  it('applies inheritance with child override and inheritedFrom', async () => {
    const prod = await seedEnvironment(env, projectId, 'prod')
    const dev = await seedEnvironment(env, projectId, 'dev', prod)
    await seedSecret(env, projectId, prod, 'A', 'prod-a')
    await seedSecret(env, projectId, prod, 'B', 'prod-b')
    await seedSecret(env, projectId, dev, 'B', 'dev-b')

    const res = await get(dev, owner.token, true)
    expect(res.status).toBe(200)
    const s = res.body.data.secrets
    expect(s.map((x: any) => x.name)).toEqual(['A', 'B'])
    expect(s[0]).toMatchObject({ value: 'prod-a', inheritedFrom: prod, isComputed: false, template: null })
    expect(s[1]).toMatchObject({ value: 'dev-b', inheritedFrom: null })
    expect(res.body.data).toMatchObject({ environmentId: dev, values: true })
  })

  it('walks a 3-level chain', async () => {
    const a = await seedEnvironment(env, projectId, 'a')
    const b = await seedEnvironment(env, projectId, 'b', a)
    const c = await seedEnvironment(env, projectId, 'c', b)
    await seedSecret(env, projectId, a, 'ROOT', '1')
    await seedSecret(env, projectId, b, 'MID', '2')
    await seedSecret(env, projectId, c, 'LEAF', '3')
    const res = await get(c, owner.token, true)
    expect(res.body.data.secrets.map((x: any) => [x.name, x.value, x.inheritedFrom])).toEqual([
      ['LEAF', '3', null], ['MID', '2', b], ['ROOT', '1', a],
    ])
  })

  it('values=false returns no value keys and does no secret KV reads', async () => {
    const prod = await seedEnvironment(env, projectId, 'prod')
    const dev = await seedEnvironment(env, projectId, 'dev', prod)
    await seedSecret(env, projectId, prod, 'A', 'x')
    await seedComputed(env, projectId, dev, 'URL', 'http://${A}')
    const spy = vi.spyOn(env.SECRETS_KV, 'get')
    const res = await get(dev, owner.token)
    expect(res.status).toBe(200)
    expect(res.body.data.values).toBe(false)
    for (const s of res.body.data.secrets) expect('value' in s).toBe(false)
    expect(res.body.data.secrets.find((s: any) => s.name === 'URL').template).toBe('http://${A}')
    expect(spy.mock.calls.filter(([k]) => String(k).startsWith('secret:'))).toHaveLength(0)
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.read_bulk'").first<{ n: number }>()
    expect(audits?.n).toBe(0)
  })

  it('evaluates computed secrets, including inherited references and chains', async () => {
    const prod = await seedEnvironment(env, projectId, 'prod')
    const dev = await seedEnvironment(env, projectId, 'dev', prod)
    await seedSecret(env, projectId, prod, 'DB_USER', 'bob')
    await seedSecret(env, projectId, prod, 'DB_PASS', 'pw')
    await seedSecret(env, projectId, dev, 'DB_PASS', 'devpw')
    await seedComputed(env, projectId, prod, 'BASE', 'postgres://${DB_USER}:${DB_PASS}@host')
    await seedComputed(env, projectId, dev, 'FULL', '${BASE}/db')
    const res = await get(dev, owner.token, true)
    expect(res.status).toBe(200)
    const m = Object.fromEntries(res.body.data.secrets.map((s: any) => [s.name, s]))
    // parent's computed secret is evaluated against the child's resolved values
    expect(m.BASE.value).toBe('postgres://bob:devpw@host')
    expect(m.BASE.inheritedFrom).toBe(prod)
    expect(m.FULL.value).toBe('postgres://bob:devpw@host/db')
    expect(m.FULL.isComputed).toBe(true)
  })

  it('returns 422 for missing reference without leaking values', async () => {
    const e = await seedEnvironment(env, projectId, 'e')
    await seedSecret(env, projectId, e, 'KEEP', 'super-secret-value')
    await seedComputed(env, projectId, e, 'BAD', '${KEEP}${GONE}')
    const res = await get(e, owner.token, true)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('COMPUTED_SECRET_ERROR')
    expect(res.body.message).toContain('BAD')
    expect(res.body.message).toContain('GONE')
    expect(JSON.stringify(res.body)).not.toContain('super-secret-value')
  })

  it('returns 422 for circular computed secrets', async () => {
    const e = await seedEnvironment(env, projectId, 'e')
    await seedComputed(env, projectId, e, 'A', '${B}')
    await seedComputed(env, projectId, e, 'B', '${A}')
    const res = await get(e, owner.token, true)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('COMPUTED_SECRET_ERROR')
  })

  it('does not hang on a parent cycle in data', async () => {
    const a = await seedEnvironment(env, projectId, 'a')
    const b = await seedEnvironment(env, projectId, 'b', a)
    env.DB.sqlite.exec(`UPDATE environments SET parent_env_id = '${b}' WHERE id = '${a}'`)
    const res = await get(b, owner.token)
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('INVALID_ENVIRONMENT_CHAIN')
  })

  it('rejects an ancestor from another project', async () => {
    const other = await seedProject(env, owner.orgId, 'Other')
    const foreign = await seedEnvironment(env, other, 'foreign')
    const e = await seedEnvironment(env, projectId, 'e')
    env.DB.sqlite.exec(`UPDATE environments SET parent_env_id = '${foreign}' WHERE id = '${e}'`)
    await seedSecret(env, other, foreign, 'LEAK', 'nope')
    const res = await get(e, owner.token, true)
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body)).not.toContain('LEAK')
  })

  it('writes exactly one audit row for values=true, without names or values', async () => {
    const e = await seedEnvironment(env, projectId, 'e')
    await seedSecret(env, projectId, e, 'TOPNAME', 'topvalue')
    await get(e, owner.token, true)
    const rows = env.DB.sqlite.prepare("SELECT * FROM audit_log WHERE action = 'secret.read_bulk'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ resource_type: 'environment', resource_id: e, org_id: owner.orgId, actor_id: owner.userId })
    expect(JSON.stringify(rows[0])).not.toMatch(/TOPNAME|topvalue/)
  })

  it('returns opaque 500 on decryption failure', async () => {
    const e = await seedEnvironment(env, projectId, 'e')
    const id = await seedSecret(env, projectId, e, 'A', 'x')
    env.SECRETS_KV.store.set(`secret:${id}`, 'garbage')
    const res = await get(e, owner.token, true)
    expect(res.status).toBe(500)
    expect(res.body).toEqual({ error: 'DECRYPTION_FAILED', message: 'Could not decrypt secret' })
  })

  it('lets a viewer read values', async () => {
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
    const e = await seedEnvironment(env, projectId, 'e')
    await seedSecret(env, projectId, e, 'A', 'x')
    const res = await get(e, viewer.token, true)
    expect(res.status).toBe(200)
    expect(res.body.data.secrets[0].value).toBe('x')
  })

  it('404s across orgs and 401s without auth', async () => {
    const e = await seedEnvironment(env, projectId, 'e')
    const stranger = await seedUser(env, { role: 'owner' })
    expect((await get(e, stranger.token, true)).status).toBe(404)
    expect((await call(env, 'GET', `/api/environments/${e}/resolved`)).status).toBe(401)
  })
})

describe('POST /api/environments', () => {
  const post = (token: string, json: unknown) => call(env, 'POST', '/api/environments', { token, json })

  it('creates an environment as admin and audits it', async () => {
    const admin = await seedUser(env, { role: 'admin', orgId: owner.orgId })
    const parent = await seedEnvironment(env, projectId, 'prod')
    const res = await post(admin.token, { projectId, name: 'Staging', parentEnvId: parent, color: '#abc' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ projectId, name: 'Staging', slug: 'staging', parentEnvId: parent, color: '#abc' })
    const rows = env.DB.sqlite.prepare("SELECT * FROM audit_log WHERE action = 'environment.create'").all() as any[]
    expect(rows).toHaveLength(1)
    expect(rows[0].resource_id).toBe(res.body.data.id)
  })

  it('403s for viewer and member', async () => {
    for (const role of ['viewer', 'member'] as const) {
      const u = await seedUser(env, { role, orgId: owner.orgId })
      const res = await post(u.token, { projectId, name: 'Nope' })
      expect(res.status).toBe(403)
      expect(res.body.error).toBe('FORBIDDEN')
    }
  })

  it('409s on duplicate slug', async () => {
    expect((await post(owner.token, { projectId, name: 'Staging' })).status).toBe(201)
    const dup = await post(owner.token, { projectId, name: 'staging' })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('CONFLICT')
  })

  it('maps a UNIQUE constraint race to 409', async () => {
    // Bypass the pre-check by making the existence lookup miss once.
    await seedEnvironment(env, projectId, 'race')
    const realPrepare = env.DB.prepare.bind(env.DB)
    let skipped = false
    env.DB.prepare = ((sql: string) => {
      if (!skipped && sql.startsWith('SELECT id FROM environments WHERE project_id = ? AND slug')) {
        skipped = true
        return { bind: () => ({ first: async () => null }) } as any
      }
      return realPrepare(sql)
    }) as any
    const res = await post(owner.token, { projectId, name: 'race' })
    expect(skipped).toBe(true)
    expect(res.status).toBe(409)
  })

  it('validates parent project and colour', async () => {
    const other = await seedProject(env, owner.orgId, 'Other')
    const foreign = await seedEnvironment(env, other, 'foreign')
    expect((await post(owner.token, { projectId, name: 'X1', parentEnvId: foreign })).status).toBe(400)
    expect((await post(owner.token, { projectId, name: 'X2', parentEnvId: 'env_missing' })).status).toBe(400)
    for (const color of ['red', '#12', '#12345g', '#1234567']) {
      expect((await post(owner.token, { projectId, name: 'X3', color })).status).toBe(400)
    }
    expect((await post(owner.token, { projectId, name: 'X4', color: '#A1B2C3' })).status).toBe(201)
  })

  it('404s for a project in another org', async () => {
    const stranger = await seedUser(env, { role: 'owner' })
    expect((await post(stranger.token, { projectId, name: 'Nope' })).status).toBe(404)
  })
})

// Issue #87: resolving an environment is the hot path for `hv run`, every CI pull and every
// sync run. KV's bulk read counts as one operation per chunk of 100 keys against the
// per-invocation limit, instead of one per secret.
describe('GET /api/environments/:id/resolved — KV operation count', () => {
  /** Count how the binding is read, keeping FakeKV as the actual store. */
  function instrumentKv(target: TestEnv, opts: { bulk: boolean }) {
    const store = target.SECRETS_KV.store
    const calls: { bulk: number; single: number; maxChunk: number } = { bulk: 0, single: 0, maxChunk: 0 }
    target.SECRETS_KV = {
      store,
      async get(key: string | string[]) {
        if (Array.isArray(key)) {
          calls.bulk += 1
          calls.maxChunk = Math.max(calls.maxChunk, key.length)
          // A binding without bulk read coerces the array to a key and misses.
          if (!opts.bulk) return null
          return new Map(key.map((k) => [k, store.get(k) ?? null]))
        }
        calls.single += 1
        return store.get(key) ?? null
      },
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    } as unknown as TestEnv['SECRETS_KV']
    return calls
  }

  it('reads 30 secrets in one bulk operation when the binding supports it', async () => {
    const e = await seedEnvironment(env, projectId, 'prod')
    const expected: Record<string, string> = {}
    for (let i = 0; i < 30; i += 1) {
      expected[`S_${i}`] = `value-${i}`
      await seedSecret(env, projectId, e, `S_${i}`, `value-${i}`)
    }
    const calls = instrumentKv(env, { bulk: true })

    const res = await get(e, owner.token, true)
    expect(res.status).toBe(200)
    expect(Object.fromEntries(res.body.data.secrets.map((s: any) => [s.name, s.value]))).toEqual(expected)
    expect(calls).toEqual({ bulk: 1, single: 0, maxChunk: 30 })
  })

  it('chunks to Cloudflare\'s documented maximum of 100 keys per call', async () => {
    const e = await seedEnvironment(env, projectId, 'prod')
    for (let i = 0; i < 150; i += 1) await seedSecret(env, projectId, e, `S_${i}`, `v-${i}`)
    const calls = instrumentKv(env, { bulk: true })

    expect((await get(e, owner.token, true)).status).toBe(200)
    expect(calls.bulk).toBe(2)
    expect(calls.single).toBe(0)
    expect(calls.maxChunk).toBe(100)
  })

  it('still resolves, via single reads, on a binding without bulk read', async () => {
    const e = await seedEnvironment(env, projectId, 'prod')
    await seedSecret(env, projectId, e, 'A', 'a')
    await seedSecret(env, projectId, e, 'B', 'b')
    const calls = instrumentKv(env, { bulk: false })

    const res = await get(e, owner.token, true)
    expect(res.status).toBe(200)
    expect(res.body.data.secrets.map((s: any) => s.value)).toEqual(['a', 'b'])
    expect(calls.single).toBe(2)
  })

  it('reads no blobs at all for a computed-only environment', async () => {
    const e = await seedEnvironment(env, projectId, 'prod')
    await seedComputed(env, projectId, e, 'C', 'static')
    const calls = instrumentKv(env, { bulk: true })

    expect((await get(e, owner.token, true)).status).toBe(200)
    expect(calls).toEqual({ bulk: 0, single: 0, maxChunk: 0 })
  })
})

describe('GET /api/environments', () => {
  it('lists snake_case rows for viewers', async () => {
    const viewer = await seedUser(env, { role: 'viewer', orgId: owner.orgId })
    const e = await seedEnvironment(env, projectId, 'prod')
    const res = await call(env, 'GET', `/api/environments?projectId=${projectId}`, { token: viewer.token })
    expect(res.status).toBe(200)
    expect(Object.keys(res.body.data[0]).sort()).toEqual(['color', 'created_at', 'id', 'name', 'parent_env_id', 'project_id', 'slug'])
    expect(res.body.data[0].id).toBe(e)
  })
})
