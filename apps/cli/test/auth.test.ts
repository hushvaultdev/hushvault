import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-auth-'))
  vi.stubEnv('HUSHVAULT_CONFIG_DIR', tmp)
  vi.stubEnv('HUSHVAULT_TOKEN', '')
  vi.stubEnv('HUSHVAULT_API_URL', '')
  store.map.clear()
  store.fail = false
  new FakeServer().install()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('login', () => {
  it('reads {data:{token}}, stores in keychain with hidden password, never on disk', async () => {
    const { loginAction } = await import('../src/commands/login.js')
    const { getAuthToken } = await import('../src/config/auth.js')
    const asked: Array<[string, boolean]> = []
    const res = await loginAction({
      apiUrl: 'https://api.test',
      ask: async (q, hidden) => { asked.push([q, hidden]); return q.startsWith('Email') ? 'a@b.co' : 'pw' },
    })
    expect(res.email).toBe('a@b.co')
    expect(asked).toEqual([['Email: ', false], ['Password: ', true]])
    expect(store.map.get('hushvault/a@b.co')).toBe('jwt-token')
    expect(await getAuthToken()).toBe('jwt-token')
    const onDisk = fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')
    expect(onDisk).not.toContain('jwt-token')
    expect(JSON.parse(onDisk).apiUrl).toBe('https://api.test')
  })

  it('uses the API message on failure', async () => {
    const { loginAction } = await import('../src/commands/login.js')
    await expect(loginAction({ apiUrl: 'https://api.test', email: 'a@b.co', ask: async () => 'wrong' })).rejects.toThrow(/Invalid credentials/)
    expect(store.map.size).toBe(0)
  })

  it('falls back with a HUSHVAULT_TOKEN hint when the keychain fails, writing no token', async () => {
    store.fail = true
    const { loginAction } = await import('../src/commands/login.js')
    await expect(loginAction({ apiUrl: 'https://api.test', email: 'a@b.co', ask: async () => 'pw' })).rejects.toThrow(/HUSHVAULT_TOKEN/)
    const files = fs.readdirSync(tmp)
    for (const f of files) expect(fs.readFileSync(path.join(tmp, f), 'utf8')).not.toContain('jwt-token')
  })
})

describe('getAuthToken', () => {
  it('HUSHVAULT_TOKEN takes precedence over keychain', async () => {
    const { storeToken, getAuthToken } = await import('../src/config/auth.js')
    await storeToken('a@b.co', 'keychain-token')
    expect(await getAuthToken()).toBe('keychain-token')
    vi.stubEnv('HUSHVAULT_TOKEN', 'hv_live_ci')
    expect(await getAuthToken()).toBe('hv_live_ci')
  })
  it('errors when nothing is configured', async () => {
    const { getAuthToken } = await import('../src/config/auth.js')
    await expect(getAuthToken()).rejects.toThrow(/Not logged in/)
  })
})

describe('keytar failing to load', () => {
  it('getAuthToken still works via env var and storeToken explains', async () => {
    vi.resetModules()
    vi.doMock('keytar', () => { throw new Error('cannot load native module') })
    const { storeToken, getAuthToken, KeychainUnavailableError } = await import('../src/config/auth.js')
    await expect(storeToken('a@b.co', 't')).rejects.toBeInstanceOf(KeychainUnavailableError)
    vi.stubEnv('HUSHVAULT_TOKEN', 'ci')
    expect(await getAuthToken()).toBe('ci')
    vi.doUnmock('keytar')
  })
})
