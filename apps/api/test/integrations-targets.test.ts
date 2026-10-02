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
    for (const scriptName of ['hushvault-api', 'hushvault-api-dev', 'hushvault-web', 'hushvault-web-dev', 'hushvault-web-local', 'HushVault-API']) {
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

// ---------------------------------------------------------------------------------------------
// Review fixes (issue #41 follow-ups)
// ---------------------------------------------------------------------------------------------

describe('run endpoint: one plan, one read', () => {
  it('a blocked plan costs a single plan: one list call, one bulk-read audit row, no run row', async () => {
    const w = await setupSyncWorld(env, { secrets: { BLANK: '', OK: 'v' } })
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(422)
    expect(res.body).toMatchObject({ error: 'SYNC_BLOCKED', plan: { blockers: [{ code: 'EMPTY_VALUE', names: ['BLANK'] }], create: ['OK'] } })
    expect(fake.listCalls).toBe(1)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.read_bulk'").first<{ n: number }>())?.n).toBe(1)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_runs').first<{ n: number }>())?.n).toBe(0)
  })

  it('a successful run also plans once', async () => {
    const w = await setupSyncWorld(env)
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(200)
    expect(fake.listCalls).toBe(1)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.read_bulk'").first<{ n: number }>())?.n).toBe(1)
  })

  it('an active run answers 200 with that run before anything is planned', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, lease_until) VALUES ('isr_live', ?, 'manual', 'running', 1, ?, '2999-01-01T00:00:00.000Z')").bind(w.targetId, new Date().toISOString()).run()
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: 'isr_live', status: 'running' })
    expect(fake.listCalls).toBe(0)
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'secret.read_bulk'").first<{ n: number }>())?.n).toBe(0)
  })

  it('a failure before anything is sent is a mapped HTTP error AND a recorded failed run that flags the target', async () => {
    const w = await setupSyncWorld(env, { secrets: { GOOD: 'g' } })
    await seedComputed(env, w.projectId, w.envId, 'BROKEN', '${DOES_NOT_EXIST}')
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('COMPUTED_ERROR')
    const runs = (await call(env, 'GET', `/api/integrations/targets/${w.targetId}/runs`, { token: w.token })).body.data
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'failed', errorCode: 'COMPUTED_ERROR', nextRetryAt: null })
    const target = (await call(env, 'GET', '/api/integrations/targets', { token: w.token })).body.data[0]
    expect(target.status).toBe('needs_attention')
  })

  it('an undecryptable secret is reported as DECRYPTION_FAILED, distinct from a computed-secret error', async () => {
    const w = await setupSyncWorld(env, { secrets: { GOOD: 'g' } })
    const row = await env.DB.prepare("SELECT id FROM secrets WHERE name = 'GOOD'").first<{ id: string }>()
    await env.SECRETS_KV.delete(`secret:${row!.id}`)
    const res = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(res.status).toBe(422)
    expect(res.body.error).toBe('DECRYPTION_FAILED')
    const preview = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/preview`, { token: w.token })
    expect(preview.body.error).toBe('DECRYPTION_FAILED')
  })

  it('audits the run and the bulk read with the caller\'s ip and user agent', async () => {
    const w = await setupSyncWorld(env)
    await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token, headers: { 'cf-connecting-ip': '198.51.100.7', 'user-agent': 'dash/9' } })
    const rows = (await env.DB.prepare("SELECT action, ip, user_agent FROM audit_log WHERE action LIKE 'sync.run.%' OR action = 'secret.read_bulk'").all<Record<string, string>>()).results
    expect(rows.length).toBe(3)
    for (const r of rows) expect([r['ip'], r['user_agent']], r['action']).toEqual(['198.51.100.7', 'dash/9'])
  })
})

describe('preview and run rate limits are per organisation', () => {
  const run = (w: { targetId: string; token: string }, ip: string, action = 'run') =>
    call(env, 'POST', `/api/integrations/targets/${w.targetId}/${action}`, { token: w.token, headers: { 'cf-connecting-ip': ip } })

  it('one organisation cannot dodge the run limit by changing IP, and another organisation is not affected', async () => {
    const a = await setupSyncWorld(env)
    const b = await setupSyncWorld(env)
    for (let i = 0; i < 6; i++) expect((await run(a, `203.0.113.${i + 1}`)).status).toBe(200)
    expect((await run(a, '203.0.113.200')).status).toBe(429)
    expect((await run(a, '203.0.113.1')).status).toBe(429)
    // org B from the very same IPs is untouched
    expect((await run(b, '203.0.113.1')).status).toBe(200)
  })

  it('same for preview (12 per minute)', async () => {
    const a = await setupSyncWorld(env)
    const b = await setupSyncWorld(env)
    for (let i = 0; i < 12; i++) expect((await run(a, `198.51.100.${i + 1}`, 'preview')).status).toBe(200)
    expect((await run(a, '198.51.100.99', 'preview')).status).toBe(429)
    expect((await run(b, '198.51.100.1', 'preview')).status).toBe(200)
  })
})

describe('PATCH while a run is active', () => {
  const activeRun = (targetId: string, lease = '2999-01-01T00:00:00.000Z') =>
    env.DB.prepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, lease_until) VALUES (?, ?, 'manual', 'running', 1, ?, ?)").bind(`isr_${Math.random().toString(36).slice(2, 10)}`, targetId, new Date().toISOString(), lease).run()
  const patch = (w: { token: string }, id: string, json: unknown) => call(env, 'PATCH', `/api/integrations/targets/${id}`, { token: w.token, json })

  it('refuses a resource or filter change with 409 BUSY and changes nothing (ledger included)', async () => {
    const w = await setupSyncWorld(env)
    await env.DB.prepare('INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) VALUES (?, ?, ?, ?)').bind(w.targetId, 'KEEP', 'fp', new Date().toISOString()).run()
    await activeRun(w.targetId)
    for (const json of [{ resource: { scriptName: 'worker-z' } }, { nameFilter: { prefix: 'X_' } }, { nameFilter: { deny: ['A'] } }]) {
      const res = await patch(w, w.targetId, json)
      expect(res.status, JSON.stringify(json)).toBe(409)
      expect(res.body.error).toBe('BUSY')
    }
    const row = await env.DB.prepare('SELECT resource_json, name_filter_json FROM sync_targets WHERE id = ?').bind(w.targetId).first<Record<string, string>>()
    expect(row).toEqual({ resource_json: '{"scriptName":"worker-a"}', name_filter_json: '{}' })
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_items WHERE target_id = ?').bind(w.targetId).first<{ n: number }>())?.n).toBe(1)
  })

  it('still allows changes that do not alter what is synced (deleteRemoved, or an identical filter/resource)', async () => {
    const w = await setupSyncWorld(env)
    await activeRun(w.targetId)
    expect((await patch(w, w.targetId, { deleteRemoved: true })).status).toBe(200)
    expect((await patch(w, w.targetId, { nameFilter: {}, resource: { scriptName: 'worker-a' } })).status).toBe(200)
  })

  it('works again once the run finished, and a crashed run (expired lease) does not block', async () => {
    const w = await setupSyncWorld(env)
    await activeRun(w.targetId, '2000-01-01T00:00:00.000Z')
    expect((await patch(w, w.targetId, { nameFilter: { prefix: 'X_' } })).status).toBe(200)
    await env.DB.prepare("UPDATE sync_runs SET status = 'failed'").run()
    await activeRun(w.targetId)
    await env.DB.prepare("UPDATE sync_runs SET status = 'succeeded' WHERE lease_until = '2999-01-01T00:00:00.000Z'").run()
    expect((await patch(w, w.targetId, { resource: { scriptName: 'worker-q' } })).status).toBe(200)
  })

  it('the UPDATE itself is guarded: a run that starts between the check and the write still wins', async () => {
    const w = await setupSyncWorld(env)
    const realPrepare = env.DB.prepare.bind(env.DB)
    let injected = false
    env.DB.prepare = ((sql: string) => {
      // Right after the route's pre-check query, a run starts.
      if (!injected && sql.startsWith('UPDATE sync_targets SET resource_json')) {
        injected = true
        void env.DB.prepare('SELECT 1').first()
        realPrepare("INSERT INTO sync_runs (id, target_id, trigger, status, attempt, started_at, lease_until) VALUES ('isr_race', ?, 'manual', 'running', 1, ?, '2999-01-01T00:00:00.000Z')").bind(w.targetId, new Date().toISOString()).runSync()
      }
      return realPrepare(sql)
    }) as typeof env.DB.prepare
    const res = await patch(w, w.targetId, { nameFilter: { prefix: 'X_' } })
    env.DB.prepare = realPrepare
    expect(injected).toBe(true)
    expect(res.status).toBe(409)
    expect((await env.DB.prepare('SELECT name_filter_json FROM sync_targets WHERE id = ?').bind(w.targetId).first<{ name_filter_json: string }>())?.name_filter_json).toBe('{}')
  })
})

describe('soft delete clears scheduled retries', () => {
  it('DELETE nulls next_retry_at on the target\'s runs', async () => {
    const w = await setupSyncWorld(env)
    fake.script.push(() => ({ ok: false, code: 'PROVIDER_ERROR' }))
    const failed = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect(failed.body.data.nextRetryAt).not.toBeNull()
    expect((await call(env, 'DELETE', `/api/integrations/targets/${w.targetId}`, { token: w.token })).status).toBe(200)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM sync_runs WHERE next_retry_at IS NOT NULL').first<{ n: number }>())?.n).toBe(0)
  })
})

describe('account denylist (HUSHVAULT_SYNC_DENY_ACCOUNT_IDS)', () => {
  it('refuses targets in a denied account (resource or the connection\'s account) and connections for it', async () => {
    const w = await setupOrg()
    env['HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'] = ` ${'d'.repeat(32)} , ACC1`
    // fixture connection config is { accountId: 'acc1' }: denied through the connection
    const viaConnection = await createTarget(w.token, createBody(w))
    expect(viaConnection.status).toBe(422)
    expect(viaConnection.body.error).toBe('TARGET_NOT_ALLOWED')
    // denied through the resource itself
    env['HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'] = 'D'.repeat(32)
    await env.DB.prepare('UPDATE integration_connections SET config_json = ? WHERE id = ?').bind(JSON.stringify({ accountId: 'd'.repeat(32) }), w.connectionId).run()
    const viaResource = await createTarget(w.token, createBody(w, 'worker-a', { resource: { scriptName: 'worker-a', accountId: 'd'.repeat(32) } }))
    expect(viaResource.status).toBe(422)
    // a new connection for a denied account is refused too
    const conn = await call(env, 'POST', '/api/integrations/connections', { token: w.token, json: { provider: 'fake-sync', label: 'bad', credential: 'long-enough-credential', config: { accountId: 'd'.repeat(32) } } })
    expect(conn.status).toBe(422)
    expect(conn.body.error).toBe('TARGET_NOT_ALLOWED')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM integration_connections WHERE label = ?').bind('bad').first<{ n: number }>())?.n).toBe(0)
    // other accounts still work
    env['HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'] = 'e'.repeat(32)
    expect((await createTarget(w.token, createBody(w))).status).toBe(201)
  })

  it('a var added after the target exists is enforced by preview and run (engine), nothing reaches the provider', async () => {
    const w = await setupSyncWorld(env)
    env['HUSHVAULT_SYNC_DENY_ACCOUNT_IDS'] = 'acc1'
    const preview = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/preview`, { token: w.token })
    expect([preview.status, preview.body.error]).toEqual([422, 'TARGET_NOT_ALLOWED'])
    const run = await call(env, 'POST', `/api/integrations/targets/${w.targetId}/run`, { token: w.token })
    expect([run.status, run.body.error]).toEqual([422, 'TARGET_NOT_ALLOWED'])
    expect(fake.listCalls).toBe(0)
    expect(fake.pushCalls).toHaveLength(0)
    const target = (await call(env, 'GET', '/api/integrations/targets', { token: w.token })).body.data[0]
    expect(target.status).toBe('needs_attention')
  })

  it('hushvault-web-local is denied by default', async () => {
    const w = await setupOrg()
    const res = await createTarget(w.token, createBody(w, 'hushvault-web-local'))
    expect([res.status, res.body.error]).toEqual([422, 'TARGET_NOT_ALLOWED'])
  })
})
