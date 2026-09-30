import { describe, expect, it } from 'vitest'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser, type Role } from './helpers/env'
import { auditActions, seedSecretWithHistory } from './helpers/projects-seed'

async function setup() {
  const env = createTestEnv()
  const owner = await seedUser(env, { role: 'owner' })
  const users: Record<Role, { token: string }> = { owner, admin: owner, member: owner, viewer: owner }
  for (const role of ['admin', 'member', 'viewer'] as const) {
    users[role] = await seedUser(env, { role, orgId: owner.orgId })
  }
  return { env, owner, users }
}

describe('projects role matrix', () => {
  it.each([
    ['viewer', 403],
    ['member', 403],
    ['admin', 201],
    ['owner', 201],
  ] as const)('POST as %s -> %i', async (role, status) => {
    const { env, users } = await setup()
    const res = await call(env, 'POST', '/api/projects', { token: users[role].token, json: { name: 'Alpha' } })
    expect(res.status).toBe(status)
    if (status === 403) expect(res.body.error).toBe('FORBIDDEN')
  })

  it.each([
    ['viewer', 403],
    ['member', 403],
    ['admin', 200],
    ['owner', 200],
  ] as const)('PATCH as %s -> %i', async (role, status) => {
    const { env, owner, users } = await setup()
    const id = await seedProject(env, owner.orgId)
    const res = await call(env, 'PATCH', `/api/projects/${id}`, { token: users[role].token, json: { name: 'Renamed' } })
    expect(res.status).toBe(status)
  })

  it.each([
    ['viewer', 403],
    ['member', 403],
    ['admin', 200],
    ['owner', 200],
  ] as const)('DELETE as %s -> %i', async (role, status) => {
    const { env, owner, users } = await setup()
    const id = await seedProject(env, owner.orgId)
    const res = await call(env, 'DELETE', `/api/projects/${id}`, { token: users[role].token })
    expect(res.status).toBe(status)
    const row = await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(id).first()
    expect(row === null).toBe(status === 200)
  })

  it('viewer can GET list and project', async () => {
    const { env, owner, users } = await setup()
    const id = await seedProject(env, owner.orgId)
    expect((await call(env, 'GET', '/api/projects', { token: users.viewer.token })).status).toBe(200)
    expect((await call(env, 'GET', `/api/projects/${id}`, { token: users.viewer.token })).status).toBe(200)
  })
})

describe('project create', () => {
  it('returns {id,name,slug,description:null} with 201 and audits', async () => {
    const { env, owner } = await setup()
    const res = await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'My Cool App!' } })
    expect(res.status).toBe(201)
    expect(res.body.data).toEqual({ id: expect.any(String), name: 'My Cool App!', slug: 'my-cool-app', description: null })
    expect(await auditActions(env, owner.orgId, res.body.data.id)).toEqual(['project.create'])
  })

  it('409 on slug collision in same org, allowed in another org', async () => {
    const { env, owner } = await setup()
    const other = await seedUser(env, { role: 'owner' })
    expect((await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'Dup' } })).status).toBe(201)
    const dup = await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'Other', slug: 'dup' } })
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('CONFLICT')
    expect((await call(env, 'POST', '/api/projects', { token: other.token, json: { name: 'Dup' } })).status).toBe(201)
  })

  it('maps a UNIQUE violation raised by the insert itself to 409 (race)', async () => {
    const { env, owner } = await setup()
    // Make the pre-check miss: stub first() for the slug lookup only.
    const realPrepare = env.DB.prepare.bind(env.DB)
    await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'Race' } })
    env.DB.prepare = (sql: string) => {
      const stmt = realPrepare(sql)
      if (sql.startsWith('SELECT id FROM projects WHERE org_id = ? AND slug = ?')) {
        return { bind: () => ({ first: async () => null }) } as unknown as ReturnType<typeof realPrepare>
      }
      return stmt
    }
    const res = await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'Race' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('CONFLICT')
  })
})

describe('project patch', () => {
  it('updates, clears description with null, leaves it when omitted, audits', async () => {
    const { env, owner } = await setup()
    const created = await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'Alpha', description: 'desc' } })
    const id = created.body.data.id
    const a = await call(env, 'PATCH', `/api/projects/${id}`, { token: owner.token, json: { name: 'Alpha 2' } })
    expect(a.body.data).toEqual({ id, name: 'Alpha 2', slug: 'alpha', description: 'desc' })
    const b = await call(env, 'PATCH', `/api/projects/${id}`, { token: owner.token, json: { description: null } })
    expect(b.body.data.description).toBeNull()
    const c = await call(env, 'PATCH', `/api/projects/${id}`, { token: owner.token, json: { slug: 'New Slug' } })
    expect(c.body.data.slug).toBe('new-slug')
    expect(await auditActions(env, owner.orgId, id)).toEqual(['project.create', 'project.update', 'project.update', 'project.update'])
  })

  it('409 when slug collides with another project; same slug on itself is fine', async () => {
    const { env, owner } = await setup()
    await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'One' } })
    const two = await call(env, 'POST', '/api/projects', { token: owner.token, json: { name: 'Two' } })
    const id = two.body.data.id
    const res = await call(env, 'PATCH', `/api/projects/${id}`, { token: owner.token, json: { slug: 'one' } })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('CONFLICT')
    expect((await call(env, 'PATCH', `/api/projects/${id}`, { token: owner.token, json: { slug: 'two' } })).status).toBe(200)
  })
})

describe('project delete', () => {
  it('removes D1 rows and all KV blobs, leaves other orgs untouched, audits', async () => {
    const { env, owner } = await setup()
    const other = await seedUser(env, { role: 'owner' })

    const projectId = await seedProject(env, owner.orgId, 'Doomed')
    const envId = await seedEnvironment(env, projectId)
    const a = await seedSecretWithHistory(env, projectId, envId)
    const b = await seedSecretWithHistory(env, projectId, envId)

    const otherProject = await seedProject(env, other.orgId, 'Safe')
    const otherEnv = await seedEnvironment(env, otherProject)
    const keep = await seedSecretWithHistory(env, otherProject, otherEnv)

    const res = await call(env, 'DELETE', `/api/projects/${projectId}`, { token: owner.token })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ data: { deleted: true } })

    for (const k of [a.secretKey, a.historyKey, b.secretKey, b.historyKey]) {
      expect(env.SECRETS_KV.store.has(k)).toBe(false)
    }
    expect(env.SECRETS_KV.store.has(keep.secretKey)).toBe(true)
    expect(env.SECRETS_KV.store.has(keep.historyKey)).toBe(true)

    const count = async (sql: string, ...p: string[]) =>
      (await env.DB.prepare(sql).bind(...p).first<{ n: number }>())!.n
    expect(await count('SELECT COUNT(*) AS n FROM secrets WHERE project_id = ?', projectId)).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM environments WHERE project_id = ?', projectId)).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM secret_history WHERE secret_id IN (?, ?)', a.secretId, b.secretId)).toBe(0)
    expect(await count('SELECT COUNT(*) AS n FROM secrets WHERE project_id = ?', otherProject)).toBe(1)

    expect(await auditActions(env, owner.orgId, projectId)).toEqual(['project.delete'])
  })

  it('succeeds even if a KV delete throws, D1 row is gone', async () => {
    const { env, owner } = await setup()
    const projectId = await seedProject(env, owner.orgId)
    const envId = await seedEnvironment(env, projectId)
    await seedSecretWithHistory(env, projectId, envId)
    env.SECRETS_KV.delete = async () => { throw new Error('kv down') }
    const res = await call(env, 'DELETE', `/api/projects/${projectId}`, { token: owner.token })
    expect(res.status).toBe(200)
    expect(await env.DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first()).toBeNull()
  })

  it('does not touch KV when the project is in another org (404)', async () => {
    const { env, owner } = await setup()
    const other = await seedUser(env, { role: 'owner' })
    const projectId = await seedProject(env, other.orgId)
    const envId = await seedEnvironment(env, projectId)
    const s = await seedSecretWithHistory(env, projectId, envId)
    const res = await call(env, 'DELETE', `/api/projects/${projectId}`, { token: owner.token })
    expect(res.status).toBe(404)
    expect(env.SECRETS_KV.store.has(s.secretKey)).toBe(true)
    expect(env.SECRETS_KV.store.has(s.historyKey)).toBe(true)
  })
})

describe('cross-org isolation', () => {
  it('GET/PATCH/DELETE on another org project -> 404', async () => {
    const { env, owner } = await setup()
    const other = await seedUser(env, { role: 'owner' })
    const id = await seedProject(env, other.orgId)
    expect((await call(env, 'GET', `/api/projects/${id}`, { token: owner.token })).status).toBe(404)
    expect((await call(env, 'PATCH', `/api/projects/${id}`, { token: owner.token, json: { name: 'Hacked' } })).status).toBe(404)
    expect((await call(env, 'DELETE', `/api/projects/${id}`, { token: owner.token })).status).toBe(404)
    const row = await env.DB.prepare('SELECT name FROM projects WHERE id = ?').bind(id).first<{ name: string }>()
    expect(row?.name).toBe('Proj')
  })
})
