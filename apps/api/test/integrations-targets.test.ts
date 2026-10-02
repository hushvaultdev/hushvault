import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FREE_PLAN_MAX_SYNC_TARGETS } from '@hushvault/shared/integrations'
import { call, createTestEnv, seedApiKey, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { CREDENTIAL, installFakeProvider, seedComputed, seedConnection, seedTarget, setupSyncWorld, type FakeProvider } from './helpers/sync-fixture'

const VALUE_CANARY = 'VALUE-CANARY-3b7f20'
const ACCOUNT = 'b'.repeat(32)

let env: TestEnv
let fake: FakeProvider
let logged: string[]

beforeEach(() => {
  env = createTestEnv()
  fake = installFakeProvider()
  logged = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')) })
  }
})
afterEach(() => vi.restoreAllMocks())

/** An org with an admin, a project, an environment and a connection (no target yet). */
async function setupOrg(opts: { plan?: string } = {}) {
  const admin = await seedUser(env, { role: 'admin' })
  if (opts.plan) await env.DB.prepare('UPDATE organisations SET plan = ? WHERE id = ?').bind(opts.plan, admin.orgId).run()
  const projectId = await seedProject(env, admin.orgId)
  const envId = await seedEnvironment(env, projectId)
  const connectionId = await seedConnection(env, admin.orgId, admin.userId)
  return { ...admin, projectId, envId, connectionId }
}

const createBody = (w: { projectId: string; envId: string; connectionId: string }, scriptName = 'worker-a', extra: Record<string, unknown> = {}) =>
  ({ projectId: w.projectId, envId: w.envId, connectionId: w.connectionId, resource: { scriptName }, ...extra })

const createTarget = (token: string, body: unknown) => call(env, 'POST', '/api/integrations/targets', { token, json: body })

describe('auth matrix', () => {
  it('only a human admin/owner with a current admin membership may use any target endpoint', async () => {
    const w = await setupSyncWorld(env)
    const member = await seedUser(env, { role: 'member', orgId: w.orgId })
    const viewer = await seedUser(env, { role: 'viewer', orgId: w.orgId })
    const key = await seedApiKey(env, w.userId)
    const demoted = await seedUser(env, { role: 'admin', orgId: w.orgId })
    await env.DB.prepare("UPDATE members SET role = 'member' WHERE user_id = ?").bind(demoted.userId).run()

    const endpoints: Array<[string, string, unknown?]> = [
      ['POST', '/api/integrations/targets', createBody(w)],
      ['GET', '/api/integrations/targets'],
      ['PATCH', `/api/integrations/targets/${w.targetId}`, { deleteRemoved: true }],
      ['DELETE', `/api/integrations/targets/${w.targetId}`],
      ['POST', `/api/integrations/targets/${w.targetId}/preview`],
      ['POST', `/api/integrations/targets/${w.targetId}/run`],
      ['GET', `/api/integrations/targets/${w.targetId}/runs`],
      ['GET', '/api/integrations/runs/isr_whatever'],
    ]
    for (const [method, path, json] of endpoints) {
      expect((await call(env, method, path, { json })).status, `anon ${method} ${path}`).toBe(401)
      for (const [who, token] of [['api key', key.rawKey], ['member', member.token], ['viewer', viewer.token], ['demoted admin', demoted.token]] as const) {
        expect((await call(env, method, path, { token, json })).status, `${who} ${method} ${path}`).toBe(403)
      }
    }
    expect(fake.listCalls).toBe(0)
    expect((await call(env, 'GET', '/api/integrations/targets', { token: w.token })).status).toBe(200)
  })
})

describe('create / list / patch / delete', () => {
  it('creates a target as a DTO with defaults, audits it, and never exposes salt or credentials', async () => {
    const w = await setupOrg()
    const res = await createTarget(w.token, createBody(w, 'worker-a', { nameFilter: { prefix: 'APP_', deny: ['APP_LOCAL'] } }))
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({
      projectId: w.projectId, envId: w.envId, connectionId: w.connectionId, provider: 'fake-sync', resource: { scriptName: 'worker-a' },
      nameFilter: { prefix: 'APP_', deny: ['APP_LOCAL'] }, deleteRemoved: false, status: 'active', lastRunAt: null, lastRunStatus: null,
    })
    expect(res.body.data.id).toMatch(/^ist_/)
    expect(JSON.stringify(res.body)).not.toMatch(/salt|CANARY|encrypted|wrapped/i)

    const list = await call(env, 'GET', '/api/integrations/targets', { token: w.token })
    expect(list.body.data).toHaveLength(1)
    const audits = await env.DB.prepare("SELECT action, resource_id, resource_type FROM audit_log WHERE action LIKE 'sync.target.%'").all<{ action: string; resource_id: string; resource_type: string }>()
    expect(audits.results).toEqual([{ action: 'sync.target.create', resource_id: res.body.data.id, resource_type: 'sync_target' }])
  })

  it('validates the body strictly', async () => {
    const w = await setupOrg()
    for (const bad of [
      { ...createBody(w), extra: 1 },
      { ...createBody(w), deleteRemoved: 'yes' },
      { ...createBody(w), nameFilter: { prefix: 'a b' } },
      { ...createBody(w), nameFilter: { deny: ['bad name'] } },
      { ...createBody(w), resource: 'x' },
      { projectId: w.projectId },
    ]) {
      expect((await createTarget(w.token, bad)).status).toBe(400)
    }
    expect((await call(env, 'GET', '/api/integrations/targets', { token: w.token })).body.data).toHaveLength(0)
  })

  it('rejects a duplicate resource on the same connection', async () => {
    const w = await setupOrg({ plan: 'pro' })
    expect((await createTarget(w.token, createBody(w))).status).toBe(201)
    const dup = await createTarget(w.token, createBody(w))
    expect(dup.status).toBe(409)
    expect(dup.body.error).toBe('CONFLICT')
    expect((await createTarget(w.token, createBody(w, 'worker-b'))).status).toBe(201)
  })

  it('refuses another organisation\'s project, environment and connection (IDOR)', async () => {
    const a = await setupOrg()
    const b = await setupOrg()
    expect((await createTarget(a.token, { ...createBody(a), connectionId: b.connectionId })).status).toBe(404)
    expect((await createTarget(a.token, { ...createBody(a), projectId: b.projectId, envId: b.envId })).status).toBe(404)
    // own project, foreign environment
    expect((await createTarget(a.token, { ...createBody(a), envId: b.envId })).status).toBe(404)
    // own project with an environment of another project in the same org
    const otherProject = await seedProject(env, a.orgId, 'Other')
    const otherEnv = await seedEnvironment(env, otherProject)
    expect((await createTarget(a.token, { ...createBody(a), envId: otherEnv })).status).toBe(404)

    const target = await createTarget(b.token, createBody(b))
    expect(target.status).toBe(201)
    const id = target.body.data.id
    expect((await call(env, 'GET', '/api/integrations/targets', { token: a.token })).body.data).toEqual([])
    for (const [method, path, json] of [
      ['PATCH', `/api/integrations/targets/${id}`, { deleteRemoved: true }],
      ['DELETE', `/api/integrations/targets/${id}`, undefined],
      ['POST', `/api/integrations/targets/${id}/preview`, undefined],
      ['POST', `/api/integrations/targets/${id}/run`, undefined],
      ['GET', `/api/integrations/targets/${id}/runs`, undefined],
    ] as const) {
      expect((await call(env, method, path, { token: a.token, json })).status, `${method} ${path}`).toBe(404)
    }
    expect(fake.listCalls).toBe(0)
    expect(fake.pushCalls).toHaveLength(0)
    expect((await call(env, 'GET', '/api/integrations/targets', { token: b.token })).body.data).toHaveLength(1)
  })

  it('PATCH updates settings, refuses a connection change, and a new resource resets the ledger', async () => {
    const w = await setupOrg()
    const created = await createTarget(w.token, createBody(w))
    const id: string = created.body.data.id
    await env.DB.prepare('INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) VALUES (?, ?, ?, ?)').bind(id, 'OLD_NAME', 'fp', new Date().toISOString()).run()

    const patched = await call(env, 'PATCH', `/api/integrations/targets/${id}`, { token: w.token, json: { deleteRemoved: true, nameFilter: { prefix: 'X_' } } })
    expect(patched.status).toBe(200)
    expect(patched.body.data).toMatchObject({ deleteRemoved: true, nameFilter: { prefix: 'X_' }, resource: { scriptName: 'worker-a' } })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_items WHERE target_id = ?').bind(id).first<{ n: number }>())?.n).toBe(1)

    const other = await seedConnection(env, w.orgId, w.userId)
    expect((await call(env, 'PATCH', `/api/integrations/targets/${id}`, { token: w.token, json: { connectionId: other } })).status).toBe(400)

    const moved = await call(env, 'PATCH', `/api/integrations/targets/${id}`, { token: w.token, json: { resource: { scriptName: 'worker-b' } } })
    expect(moved.status).toBe(200)
    expect(moved.body.data.resource).toEqual({ scriptName: 'worker-b' })
    // The ledger named things HushVault wrote to the old Worker: it must not authorise deletes on the new one.
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_items WHERE target_id = ?').bind(id).first<{ n: number }>())?.n).toBe(0)
    const audits = await env.DB.prepare("SELECT action FROM audit_log WHERE action = 'sync.target.update'").all()
    expect(audits.results).toHaveLength(2)
  })

  it('DELETE removes the target from lists, frees the plan slot, and 404s afterwards', async () => {
    const w = await setupOrg()
    const ids: string[] = []
    for (const name of ['w1', 'w2']) ids.push((await createTarget(w.token, createBody(w, name))).body.data.id)
    expect((await createTarget(w.token, createBody(w, 'w3'))).status).toBe(409)
    expect((await call(env, 'DELETE', `/api/integrations/targets/${ids[0]}`, { token: w.token })).body).toEqual({ data: { deleted: true } })
    expect((await call(env, 'DELETE', `/api/integrations/targets/${ids[0]}`, { token: w.token })).status).toBe(404)
    expect((await call(env, 'GET', '/api/integrations/targets', { token: w.token })).body.data).toHaveLength(1)
    expect((await createTarget(w.token, createBody(w, 'w3'))).status).toBe(201)
    expect((await call(env, 'POST', `/api/integrations/targets/${ids[0]}/run`, { token: w.token })).status).toBe(404)
    const audits = await env.DB.prepare("SELECT resource_id FROM audit_log WHERE action = 'sync.target.delete'").all<{ resource_id: string }>()
    expect(audits.results.map((a) => a.resource_id)).toEqual([ids[0]])
  })
})

describe('free plan cap', () => {
  it('allows exactly FREE_PLAN_MAX_SYNC_TARGETS targets, even under concurrency; paid plans are unlimited', async () => {
    expect(FREE_PLAN_MAX_SYNC_TARGETS).toBe(2)
    const w = await setupOrg()
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((n) => createTarget(w.token, createBody(w, `worker-${n}`))))
    expect(results.filter((r) => r.status === 201)).toHaveLength(2)
    const refused = results.filter((r) => r.status === 409)
    expect(refused).toHaveLength(2)
    expect(refused[0]?.body.error).toBe('PLAN_LIMIT')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_targets WHERE org_id = ?').bind(w.orgId).first<{ n: number }>())?.n).toBe(2)

    await env.DB.prepare("UPDATE organisations SET plan = 'pro' WHERE id = ?").bind(w.orgId).run()
    expect((await createTarget(w.token, createBody(w, 'worker-e'))).status).toBe(201)
    expect((await createTarget(w.token, createBody(w, 'worker-f'))).status).toBe(201)
  })

  it('counts per organisation', async () => {
    const a = await setupOrg()
    const b = await setupOrg()
    for (const n of ['a', 'b']) expect((await createTarget(a.token, createBody(a, n))).status).toBe(201)
    expect((await createTarget(b.token, createBody(b, 'a'))).status).toBe(201)
  })
})

describe('own-worker denylist and the real Cloudflare provider', () => {
  async function cloudflareOrg() {
    const w = await setupOrg()
    await env.DB.prepare("UPDATE integration_connections SET provider = 'cloudflare-workers', config_json = ? WHERE id = ?").bind(JSON.stringify({ accountId: ACCOUNT }), w.connectionId).run()
    return w
  }
  const cfBody = (w: { projectId: string; envId: string; connectionId: string }, resource: unknown) => ({ projectId: w.projectId, envId: w.envId, connectionId: w.connectionId, resource })

  it('refuses HushVault\'s own Workers and anything in HUSHVAULT_SYNC_DENY_SCRIPTS', async () => {
    const w = await cloudflareOrg()
    for (const scriptName of ['hushvault-api', 'hushvault-api-dev', 'hushvault-web', 'hushvault-web-dev', 'HushVault-API']) {
      const res = await createTarget(w.token, cfBody(w, { accountId: ACCOUNT, scriptName }))
      expect(res.status, scriptName).toBe(422)
      expect(res.body.error).toBe('TARGET_NOT_ALLOWED')
    }
    env['HUSHVAULT_SYNC_DENY_SCRIPTS'] = 'billing-edge'
    expect((await createTarget(w.token, cfBody(w, { accountId: ACCOUNT, scriptName: 'billing-edge' }))).status).toBe(422)
    expect((await createTarget(w.token, cfBody(w, { accountId: ACCOUNT, scriptName: 'customer-app' }))).status).toBe(201)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_targets').first<{ n: number }>())?.n).toBe(1)
  })

  it('rejects malformed resources and an account that differs from the connection', async () => {
    const w = await cloudflareOrg()
    for (const resource of [
      { accountId: ACCOUNT, scriptName: '../../x' },
      { accountId: ACCOUNT, scriptName: 'a/b' },
      { accountId: 'https://evil.test', scriptName: 'w' },
      { accountId: ACCOUNT, scriptName: 'w', host: 'evil.test' },
      { scriptName: 'w' },
      { accountId: 'c'.repeat(32), scriptName: 'w' },
    ]) {
      expect((await createTarget(w.token, cfBody(w, resource))).status, JSON.stringify(resource)).toBe(400)
    }
  })

  it('re-checks the denylist when previewing or running an existing target (nothing reaches the provider)', async () => {
    const w = await setupSyncWorld(env)
    const denied = await seedTarget(env, { orgId: w.orgId, projectId: w.projectId, envId: w.envId, connectionId: w.connectionId, resource: { scriptName: 'hushvault-api' } })
    for (const action of ['preview', 'run']) {
      const res = await call(env, 'POST', `/api/integrations/targets/${denied}/${action}`, { token: w.token })
      expect(res.status, action).toBe(422)
      expect(res.body.error).toBe('TARGET_NOT_ALLOWED')
    }
    expect(fake.listCalls).toBe(0)
    expect(fake.pushCalls).toHaveLength(0)
  })
})

describe('preview and run end to end', () => {
  it('previews names only, runs, records history, then reports nothing to do', async () => {
    const w = await setupSyncWorld(env, { secrets: { API_KEY: VALUE_CANARY, DB_URL: `postgres://${VALUE_CANARY}`, JWT_SECRET: VALUE_CANARY } })
    const responses: unknown[] = []

    const preview = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/preview`, { token: w.token })
    responses.push(preview.body)
    expect(preview.status).toBe(200)
    expect(preview.body.data).toEqual({ create: ['API_KEY', 'DB_URL'], update: [], delete: [], skip: ['JWT_SECRET'], conflict: [], blockers: [] })
    expect(fake.pushCalls).toHaveLength(0)

    const run = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    responses.push(run.body)
    expect(run.status).toBe(200)
    expect(run.body.data).toMatchObject({ targetId: w.targetId, trigger: 'manual', status: 'succeeded', errorCode: null, counts: { created: 2, updated: 0, deleted: 0, failed: 0 } })
    expect(run.body.data.id).toMatch(/^isr_/)
    expect([...fake.remote.keys()].sort()).toEqual(['API_KEY', 'DB_URL'])
    expect(fake.remote.get('API_KEY')).toBe(VALUE_CANARY)
    expect(fake.credentialsSeen.every((c) => c === CREDENTIAL)).toBe(true)

    const again = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    responses.push(again.body)
    expect(again.body.data).toMatchObject({ status: 'succeeded', counts: { created: 0, updated: 0, skipped: 3 } })

    const runs = await call(env, 'GET', `/api/integrations/targets/${w.targetId}/runs`, { token: w.token })
    responses.push(runs.body)
    expect(runs.body.data.map((r: { id: string }) => r.id)).toEqual([again.body.data.id, run.body.data.id])
    const one = await call(env, 'GET', `/api/integrations/runs/${run.body.data.id}`, { token: w.token })
    responses.push(one.body)
    expect(one.body.data).toEqual(run.body.data)

    const list = await call(env, 'GET', '/api/integrations/targets', { token: w.token })
    responses.push(list.body)
    expect(list.body.data[0]).toMatchObject({ lastRunStatus: 'succeeded' })

    // Another organisation sees none of it.
    const outsider = await seedUser(env, { role: 'admin' })
    expect((await call(env, 'GET', `/api/integrations/runs/${run.body.data.id}`, { token: outsider.token })).status).toBe(404)

    // Canary sweep: no value or credential in any response, log or stored sync/audit row.
    const dump = JSON.stringify(await Promise.all(['sync_targets', 'sync_items', 'sync_runs', 'audit_log'].map(async (t) => (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results)))
    for (const text of [JSON.stringify(responses), dump, logged.join('\n')]) {
      expect(text).not.toContain('CANARY')
    }
    const audits = await env.DB.prepare("SELECT action FROM audit_log WHERE action LIKE 'sync.run.%' OR action = 'secret.read_bulk'").all<{ action: string }>()
    expect(audits.results.map((a) => a.action)).toContain('sync.run.succeeded')
    expect(audits.results.map((a) => a.action)).toContain('secret.read_bulk')
  })

  it('refuses a blocked plan with 422 SYNC_BLOCKED carrying names only, and records no run', async () => {
    fake = installFakeProvider({ maxValueBytes: 4 })
    const w = await setupSyncWorld(env, { secrets: { BIG: VALUE_CANARY, OK: 'ab' } })
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('SYNC_BLOCKED')
    expect(res.body.plan.blockers).toEqual([{ code: 'VALUE_TOO_LARGE', names: ['BIG'] }])
    expect(JSON.stringify(res.body)).not.toContain('CANARY')
    expect(fake.pushCalls).toHaveLength(0)
    expect((await call(env, 'GET', `/api/integrations/targets/${w.targetId}/runs`, { token: w.token })).body.data).toEqual([])
  })

  it('maps provider and credential failures to fixed errors without provider detail', async () => {
    const w = await setupSyncWorld(env)
    fake.listError = 'PROVIDER_AUTH'
    const auth = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/preview`, { token: w.token })
    expect(auth.status).toBe(422)
    expect(auth.body.error).toBe('PROVIDER_AUTH')
    fake.listError = 'PROVIDER_RATE_LIMIT'
    expect((await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })).status).toBe(429)
    fake.listError = null

    // A failed push is a recorded run, not an HTTP error; the error code is a fixed enum value.
    fake.script.push(() => ({ ok: false, code: 'PROVIDER_ERROR' }))
    const failed = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(failed.status).toBe(200)
    expect(failed.body.data).toMatchObject({ status: 'failed', errorCode: 'PROVIDER_ERROR' })
    expect(failed.body.data.nextRetryAt).not.toBeNull()
    expect(JSON.stringify(failed.body)).not.toContain(CREDENTIAL)
  })

  it('a deleted connection removes its targets (cascade, audited) so nothing can run afterwards', async () => {
    const w = await setupSyncWorld(env)
    const revoked = await call(env, 'DELETE', `/api/integrations/connections/${w.connectionId}`, { token: w.token })
    expect(revoked.body).toEqual({ data: { revoked: true } })
    expect((await call(env, 'GET', '/api/integrations/targets', { token: w.token })).body.data).toEqual([])
    expect((await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })).status).toBe(404)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_targets').first<{ n: number }>())?.n).toBe(0)
    const audits = await env.DB.prepare("SELECT resource_id FROM audit_log WHERE action = 'sync.target.delete'").all<{ resource_id: string }>()
    expect(audits.results.map((a) => a.resource_id)).toEqual([w.targetId])
  })

  it('rate limits runs (6 per minute)', async () => {
    const w = await setupSyncWorld(env)
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })).status)
    expect(statuses.slice(0, 6).every((s) => s === 200)).toBe(true)
    expect(statuses[6]).toBe(429)
  })

  it('a computed-secret failure fails closed with a fixed error and no provider call', async () => {
    const w = await setupSyncWorld(env)
    await seedComputed(env, w.projectId, w.envId, 'BROKEN', '${DOES_NOT_EXIST}')
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('COMPUTED_ERROR')
    expect(fake.listCalls).toBe(0)
    expect(fake.pushCalls).toHaveLength(0)
  })
})
