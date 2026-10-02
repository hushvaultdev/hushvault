import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, friendlyError } from '../src/api.js'
import {
  EXIT_BLOCKED, EXIT_FAIL, EXIT_OK, reportSyncError, resolveTarget, syncListAction, syncPreviewAction, syncRunAction, syncStatusAction,
} from '../src/commands/sync.js'
import { FakeServer } from './fake-server.js'

let server: FakeServer
let lines: string[]
let errLines: string[]
const out = (l: string): void => { lines.push(l) }
const errOut = (l: string): void => { errLines.push(l) }
const client = (token = 'jwt-token'): ApiClient => new ApiClient({ apiUrl: 'https://api.test', token })
const text = (): string => lines.join('\n')

beforeEach(() => {
  server = new FakeServer()
  server.install()
  lines = []
  errLines = []
})
afterEach(() => vi.unstubAllGlobals())

describe('sync list', () => {
  it('prints labels, ids and status', async () => {
    expect(await syncListAction(client(), {}, out)).toBe(EXIT_OK)
    expect(text()).toContain('cloudflare-workers:api-worker')
    expect(text()).toContain('tgt_2')
    expect(text()).toContain('never run')
  })
  it('--json prints only known fields', async () => {
    await syncListAction(client(), { json: true }, out)
    const parsed = JSON.parse(text()) as Record<string, unknown>[]
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ id: 'tgt_1', label: 'cloudflare-workers:api-worker', status: 'active' })
    expect(Object.keys(parsed[0]!)).not.toContain('apiToken')
  })
  it('exits 2 when a target needs attention', async () => {
    server.targets[0]!['status'] = 'needs_attention'
    expect(await syncListAction(client(), {}, out)).toBe(EXIT_BLOCKED)
  })
  it('hints at the dashboard when empty', async () => {
    server.targets = []
    expect(await syncListAction(client(), {}, out)).toBe(EXIT_OK)
    expect(text()).toMatch(/dashboard/)
  })
})

describe('target resolution', () => {
  it('resolves by id and by label, case-insensitively', async () => {
    expect((await resolveTarget(client(), 'tgt_2')).id).toBe('tgt_2')
    expect((await resolveTarget(client(), 'Cloudflare-Workers:API-worker')).id).toBe('tgt_1')
  })
  it('rejects unknown and ambiguous targets', async () => {
    await expect(resolveTarget(client(), 'nope')).rejects.toThrow(/not found.*api-worker/)
    server.targets.push({ ...server.targets[0], id: 'tgt_3' })
    await expect(resolveTarget(client(), 'cloudflare-workers:api-worker')).rejects.toThrow(/ambiguous.*tgt_1, tgt_3/)
  })
})

describe('sync status', () => {
  it('shows target and latest run', async () => {
    expect(await syncStatusAction(client(), 'cloudflare-workers:api-worker', {}, out)).toBe(EXIT_OK)
    expect(text()).toContain('succeeded')
    expect(text()).toContain('1 created, 1 updated')
    expect(server.calls.some((c) => c.path === '/api/integrations/targets/tgt_1/runs')).toBe(true)
  })
  it('exits 2 for needs_attention or a failed latest run', async () => {
    server.targets[0]!['status'] = 'needs_attention'
    expect(await syncStatusAction(client(), 'tgt_1', {}, out)).toBe(EXIT_BLOCKED)
    server.targets[0]!['status'] = 'active'
    server.runResult['status'] = 'failed'
    server.runResult['errorCode'] = 'PROVIDER_AUTH'
    expect(await syncStatusAction(client(), 'tgt_1', {}, out)).toBe(EXIT_BLOCKED)
    expect(text()).toContain('PROVIDER_AUTH')
  })
  it('--json', async () => {
    await syncStatusAction(client(), 'tgt_1', { json: true }, out)
    const p = JSON.parse(text()) as { target: { id: string }; latestRun: { status: string } }
    expect(p.target.id).toBe('tgt_1')
    expect(p.latestRun.status).toBe('succeeded')
  })
})

describe('sync preview', () => {
  it('prints names and counts and changes nothing', async () => {
    expect(await syncPreviewAction(client(), 'tgt_1', {}, out)).toBe(EXIT_OK)
    expect(text()).toContain('1 create, 1 update, 0 delete')
    expect(text()).toContain('NEW_ONE')
    expect(text()).toContain('EXISTING')
    expect(server.calls.some((c) => c.path.endsWith('/run'))).toBe(false)
  })
  it('exits 2 when the plan has blockers', async () => {
    server.plan['blockers'] = [{ code: 'TOO_MANY_ITEMS', names: ['A', 'B'] }]
    expect(await syncPreviewAction(client(), 'tgt_1', {}, out)).toBe(EXIT_BLOCKED)
    expect(text()).toContain('TOO_MANY_ITEMS')
  })
  it('--json', async () => {
    await syncPreviewAction(client(), 'tgt_1', { json: true }, out)
    const p = JSON.parse(text()) as { plan: { create: string[] } }
    expect(p.plan.create).toEqual(['NEW_ONE'])
  })
})

describe('sync run', () => {
  it('prints the plan summary first, then the run result', async () => {
    expect(await syncRunAction(client(), 'tgt_1', {}, out)).toBe(EXIT_OK)
    expect(text().indexOf('Plan:')).toBeLessThan(text().indexOf('Run run_1'))
    expect(server.calls.filter((c) => c.method === 'POST').map((c) => c.path.split('/').pop())).toEqual(['preview', 'run'])
  })
  it('exits 1 for a failed or partial run', async () => {
    server.runResult['status'] = 'partial'
    expect(await syncRunAction(client(), 'tgt_1', {}, out)).toBe(EXIT_FAIL)
  })
  it('blocked plan exits 2 without running', async () => {
    server.plan['blockers'] = [{ code: 'NAME_INVALID', names: ['bad-name'] }]
    expect(await syncRunAction(client(), 'tgt_1', {}, out)).toBe(EXIT_BLOCKED)
    expect(server.calls.some((c) => c.path.endsWith('/run'))).toBe(false)
    expect(text()).toContain('bad-name')
  })
  it('SYNC_BLOCKED from the API exits 2 and prints the plan names', () => {
    const err = new ApiError(422, 'SYNC_BLOCKED', 'Plan has blockers', { blockers: [{ code: 'VALUE_TOO_LARGE', names: ['BIG'] }] })
    expect(reportSyncError(err, client(), {}, out, errOut)).toBe(EXIT_BLOCKED)
    expect(errLines.join('\n')).toContain('VALUE_TOO_LARGE')
    expect(errLines.join('\n')).toContain('BIG')
  })
  it('SYNC_BLOCKED over the wire carries the plan to the error', async () => {
    server.runBlockedPlan = { create: [], update: [], delete: [], skip: [], conflict: [], blockers: [{ code: 'TOO_MANY_ITEMS', names: ['X'] }] }
    const err = await client().runTarget('tgt_1').catch((e: unknown) => e)
    expect(reportSyncError(err, client(), { json: true }, out, errOut)).toBe(EXIT_BLOCKED)
    expect(JSON.parse(text())).toMatchObject({ run: null })
  })
  describe('deletes', () => {
    beforeEach(() => { server.plan['delete'] = ['OLD_NAME'] })
    it('non-interactive without --yes refuses and does not run', async () => {
      await expect(syncRunAction(client(), 'tgt_2', { interactive: false }, out)).rejects.toThrow(/--yes/)
      expect(server.calls.some((c) => c.path.endsWith('/run'))).toBe(false)
    })
    it('--json counts as non-interactive', async () => {
      await expect(syncRunAction(client(), 'tgt_2', { json: true }, out)).rejects.toThrow(/--yes/)
    })
    it('--yes runs', async () => {
      expect(await syncRunAction(client(), 'tgt_2', { yes: true, interactive: false }, out)).toBe(EXIT_OK)
      expect(text()).toContain('OLD_NAME')
    })
    it('interactive decline cancels with exit 1', async () => {
      const code = await syncRunAction(client(), 'tgt_2', { interactive: true, confirm: async () => false }, out)
      expect(code).toBe(EXIT_FAIL)
      expect(server.calls.some((c) => c.path.endsWith('/run'))).toBe(false)
    })
    it('interactive accept runs', async () => {
      expect(await syncRunAction(client(), 'tgt_2', { interactive: true, confirm: async () => true }, out)).toBe(EXIT_OK)
    })
  })
  it('--json prints plan and run', async () => {
    await syncRunAction(client(), 'tgt_1', { json: true }, out)
    const p = JSON.parse(text()) as { plan: { create: string[] }; run: { status: string } }
    expect(p.plan.create).toEqual(['NEW_ONE'])
    expect(p.run.status).toBe('succeeded')
  })
})

describe('errors', () => {
  it('API key 403 gives the interactive-login message and exit 1', async () => {
    const c = client('hv_live_abc')
    const err = await c.listTargets().catch((e: unknown) => e)
    expect(reportSyncError(err, c, {}, out, errOut)).toBe(EXIT_FAIL)
    expect(errLines.join('\n')).toContain('Sync management needs an interactive login, not an API key')
  })
  it('a role 403 with a JWT keeps the role message', async () => {
    server.role = 'viewer'
    const err = await client().listTargets().catch((e: unknown) => e)
    expect(reportSyncError(err, client(), {}, out, errOut)).toBe(EXIT_FAIL)
    expect(errLines.join('\n')).toMatch(/Permission denied/)
  })
  it('maps PLAN_LIMIT, 429 and SYNC_BLOCKED', () => {
    expect(friendlyError(new ApiError(409, 'PLAN_LIMIT', 'x'))).toMatch(/at most 2 sync targets/)
    expect(friendlyError(new ApiError(409, 'CONFLICT', 'dup'))).toBe('Conflict: dup')
    expect(friendlyError(new ApiError(429, 'RATE_LIMITED', 'x'))).toMatch(/Rate limited/)
    expect(friendlyError(new ApiError(422, 'SYNC_BLOCKED', 'x'))).toMatch(/Sync blocked/)
  })
})

describe('no secret-like output', () => {
  it('never prints leaked values, tokens or provider bodies in any mode', async () => {
    for (const json of [false, true]) {
      await syncListAction(client(), { json }, out)
      await syncStatusAction(client(), 'tgt_1', { json }, out)
      await syncPreviewAction(client(), 'tgt_1', { json }, out)
      await syncRunAction(client(), 'tgt_1', { json, yes: true }, out)
    }
    const all = text() + errLines.join('\n')
    expect(all).not.toMatch(/LEAK|cf-|jwt-token/)
  })
})
