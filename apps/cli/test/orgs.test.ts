import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, type OrgRow } from '../src/api.js'
import { FakeServer } from './fake-server.js'

const store = vi.hoisted(() => ({ map: new Map<string, string>(), fail: false }))
vi.mock('keytar', () => ({
  default: {
    setPassword: async (s: string, a: string, p: string) => {
      if (store.fail) throw new Error('libsecret missing')
      store.map.set(`${s}/${a}`, p)
    },
    getPassword: async (s: string, a: string) => store.map.get(`${s}/${a}`) ?? null,
    deletePassword: async (s: string, a: string) => store.map.delete(`${s}/${a}`),
  },
}))

const client = () => new ApiClient({ apiUrl: 'https://api.test', token: 'jwt-token' })
const collect = () => {
  const lines: string[] = []
  return { out: (l: string) => lines.push(l), lines }
}

let server: FakeServer
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-orgs-'))
  vi.stubEnv('HUSHVAULT_CONFIG_DIR', tmp)
  vi.stubEnv('HUSHVAULT_TOKEN', '')
  vi.stubEnv('HUSHVAULT_API_URL', '')
  store.map.clear()
  store.fail = false
  server = new FakeServer()
  server.install()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const rows: OrgRow[] = [
  { id: 'org_1', name: 'Acme Inc', slug: 'acme', plan: 'pro', role: 'admin', current: true },
  { id: 'org_2', name: 'Side Project', slug: 'side', plan: 'free', role: 'member', current: false },
]

describe('resolveOrg (slug -> id)', () => {
  it('matches id, slug and name case-insensitively', async () => {
    const { resolveOrg } = await import('../src/commands/orgs.js')
    expect(resolveOrg(rows, 'org_2').id).toBe('org_2')
    expect(resolveOrg(rows, 'SIDE').id).toBe('org_2')
    expect(resolveOrg(rows, 'Side Project').id).toBe('org_2')
    expect(resolveOrg(rows, 'acme').id).toBe('org_1')
  })
  it('throws a plain "not a member" error listing the known slugs', async () => {
    const { resolveOrg } = await import('../src/commands/orgs.js')
    expect(() => resolveOrg(rows, 'zzz')).toThrow(/not a member of the organisation "zzz"/)
    expect(() => resolveOrg(rows, 'zzz')).toThrow(/acme, side/)
  })
})

describe('orgs list', () => {
  it('marks the current org in the human table', async () => {
    const { orgsListAction } = await import('../src/commands/orgs.js')
    const { out, lines } = collect()
    await orgsListAction(client(), {}, out)
    const acme = lines.find((l) => l.includes('Acme Inc'))!
    const side = lines.find((l) => l.includes('Side Project'))!
    expect(acme).toContain('[current]')
    expect(side).not.toContain('[current]')
  })
  it('--json emits every org with a current flag', async () => {
    const { orgsListAction } = await import('../src/commands/orgs.js')
    const { out, lines } = collect()
    await orgsListAction(client(), { json: true }, out)
    const parsed = JSON.parse(lines.join('\n')) as OrgRow[]
    expect(parsed.map((o) => o.id)).toEqual(['org_1', 'org_2'])
    expect(parsed.find((o) => o.current)?.id).toBe('org_1')
  })
})

describe('orgs use', () => {
  async function seedSession(access = 'old-access', refresh: string | null = 'old-refresh') {
    const { storeToken, storeRefreshToken } = await import('../src/config/auth.js')
    await storeToken('a@b.co', access) // also records currentUser in the global config
    if (refresh) await storeRefreshToken('a@b.co', refresh)
  }

  it('overwrites the keychain with the new session as the LAST step', async () => {
    await seedSession()
    const { orgsUseAction } = await import('../src/commands/orgs.js')
    const { out } = collect()
    await orgsUseAction(client(), 'side', {}, out)

    // Server rotated to org_2 and the keychain now holds the NEW access + refresh tokens.
    expect(server.currentOrgId).toBe('org_2')
    expect(store.map.get('hushvault/a@b.co')).toBe('access-org_2-1')
    expect(store.map.get('hushvault/a@b.co#refresh')).toBe('refresh-org_2-1')
    // The stored refresh token was sent in the switch body (not the access token).
    const sw = server.calls.find((c) => c.path === '/api/orgs/org_2/switch')!
    expect((sw.body as { refreshToken: string }).refreshToken).toBe('old-refresh')
    // currentOrg label is recorded for 404 diagnostics.
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).currentOrg).toBe('Side Project')
  })

  it('does nothing and writes no new token when already in the target org', async () => {
    await seedSession()
    const { orgsUseAction } = await import('../src/commands/orgs.js')
    const { out, lines } = collect()
    await orgsUseAction(client(), 'acme', {}, out)
    expect(server.switchCount).toBe(0)
    expect(store.map.get('hushvault/a@b.co')).toBe('old-access')
    expect(lines.join('\n')).toMatch(/Already acting in Acme Inc/)
  })

  it('refuses to switch without an interactive session (no refresh token stored)', async () => {
    await seedSession('old-access', null) // access only, no refresh entry (e.g. API-key / CI user)
    const { orgsUseAction } = await import('../src/commands/orgs.js')
    await expect(orgsUseAction(client(), 'side', {}, () => {})).rejects.toThrow(/interactive login/)
    expect(server.switchCount).toBe(0) // never touched the server
  })

  it('tells the user to log in again if the keychain write fails AFTER the server rotated the family', async () => {
    await seedSession()
    const { orgsUseAction } = await import('../src/commands/orgs.js')
    store.fail = true // every keychain write now throws
    await expect(orgsUseAction(client(), 'side', {}, () => {})).rejects.toThrow(/log in again|login.*again/i)
    // The server switch already happened — the old stored family is dead, which is exactly why the
    // message must point at `hushvault login`.
    expect(server.switchCount).toBe(1)
    expect(server.currentOrgId).toBe('org_2')
  })

  it('surfaces a server 403 NOT_A_MEMBER as a plain message, not a stack trace', async () => {
    await seedSession()
    server.rejectSwitch = true
    const { orgsUseAction, reportOrgsError } = await import('../src/commands/orgs.js')
    const err = await orgsUseAction(client(), 'side', {}, () => {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('NOT_A_MEMBER')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      reportOrgsError(err)
      expect(spy.mock.calls.flat().join(' ')).toMatch(/not a member of that organisation/)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('login --org', () => {
  it('switches into the named org before storing, and stores the rotated session', async () => {
    const { loginAction } = await import('../src/commands/login.js')
    const res = await loginAction({ apiUrl: 'https://api.test', email: 'a@b.co', org: 'side', ask: async () => 'pw' })
    expect(res.switched).toBe(true)
    expect(res.orgId).toBe('org_2')
    expect(store.map.get('hushvault/a@b.co')).toBe('access-org_2-1')
    expect(store.map.get('hushvault/a@b.co#refresh')).toBe('refresh-org_2-1')
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).currentOrg).toBe('Side Project')
  })

  it('does not switch when --org names the org the login already landed in', async () => {
    const { loginAction } = await import('../src/commands/login.js')
    const res = await loginAction({ apiUrl: 'https://api.test', email: 'a@b.co', org: 'acme', ask: async () => 'pw' })
    expect(res.switched).toBe(false)
    expect(res.orgId).toBe('org_1')
    expect(store.map.get('hushvault/a@b.co')).toBe('jwt-token')
    expect(server.switchCount).toBe(0)
  })

  it('fails clearly when --org names an org the user is not in', async () => {
    const { loginAction } = await import('../src/commands/login.js')
    await expect(
      loginAction({ apiUrl: 'https://api.test', email: 'a@b.co', org: 'nope', ask: async () => 'pw' }),
    ).rejects.toThrow(/not a member/)
    expect(store.map.get('hushvault/a@b.co')).toBeUndefined() // nothing stored on failure
  })

  it('without --org, reports the membership count so the command can hint', async () => {
    const { loginAction } = await import('../src/commands/login.js')
    const res = await loginAction({ apiUrl: 'https://api.test', email: 'a@b.co', ask: async () => 'pw' })
    expect(res.switched).toBe(false)
    expect(res.orgCount).toBe(2)
    expect(store.map.get('hushvault/a@b.co')).toBe('jwt-token')
  })
})

describe('404 names the current organisation', () => {
  it('appends the org label from the client to a 404 so the "wrong org" case is diagnosable', async () => {
    const c = new ApiClient({ apiUrl: 'https://api.test', token: 'jwt-token', orgLabel: 'Acme Inc' })
    // A secret id that does not exist returns 404 from the fake server.
    const err = (await c.updateSecret('sec_missing', { value: 'x' }).catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(404)
    expect(err.message).toMatch(/current organisation: Acme Inc/)
    expect(err.message).toMatch(/orgs use/)
  })
  it('leaves the 404 untouched when the client has no org label', async () => {
    const c = new ApiClient({ apiUrl: 'https://api.test', token: 'jwt-token' })
    const err = (await c.updateSecret('sec_missing', { value: 'x' }).catch((e: unknown) => e)) as ApiError
    expect(err.status).toBe(404)
    expect(err.message).not.toMatch(/current organisation/)
  })
})
