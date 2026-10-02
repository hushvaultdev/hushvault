import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClient, ApiError, friendlyError } from '../src/api.js'
import { getAction } from '../src/commands/get.js'
import { runAction } from '../src/commands/run.js'
import { setAction, readValue } from '../src/commands/set.js'
import { initAction } from '../src/commands/init.js'
import { shareAction } from '../src/commands/share.js'
import { resolveEnvironment, type ProjectContext } from '../src/lib/context.js'
import { FakeServer } from './fake-server.js'
import { Readable } from 'stream'

let server: FakeServer
let tmp: string

function ctx(defaultEnv = 'development'): ProjectContext {
  return {
    config: { apiUrl: 'https://api.test', projectId: 'prj_1', defaultEnv },
    client: new ApiClient({ apiUrl: 'https://api.test', token: 'tkn' }),
  }
}

beforeEach(() => {
  server = new FakeServer()
  server.install()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hv-cli-'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('resolveEnvironment', () => {
  it('matches id, slug and name case-insensitively', async () => {
    const c = ctx().client
    expect((await resolveEnvironment(c, 'prj_1', 'env_stg')).id).toBe('env_stg')
    expect((await resolveEnvironment(c, 'prj_1', 'STAGING')).id).toBe('env_stg')
    expect((await resolveEnvironment(c, 'prj_1', 'development')).id).toBe('env_dev')
  })
  it('lists valid slugs when not found', async () => {
    await expect(resolveEnvironment(ctx().client, 'prj_1', 'prod')).rejects.toThrow(/development, staging/)
  })
})

describe('get', () => {
  it('--raw prints only the value, no newline, with inheritance', async () => {
    let out = ''
    const v = await getAction(ctx('staging'), 'BASE', { raw: true }, (s) => { out += s })
    expect(v).toBe('base-val')
    expect(out).toBe('base-val')
    expect(server.calls.some((c) => c.path === '/api/environments/env_stg/resolved' && c.query['values'] === 'true')).toBe(true)
  })
  it('errors clearly when missing', async () => {
    await expect(getAction(ctx(), 'NOPE', {}, () => {})).rejects.toThrow(/Secret "NOPE" not found/)
  })
  it('--env overrides default', async () => {
    let out = ''
    await getAction(ctx(), 'OWN', { env: 'Staging', raw: true }, (s) => { out += s })
    expect(out).toBe('own-val')
  })
})

describe('run', () => {
  const writer = (file: string) => ['-e', `require('fs').writeFileSync(process.argv[1], [process.env.BASE, process.env.OWN, process.env.KEEP].join('|'))`, file]

  it('injects inherited secrets, merges process env', async () => {
    vi.stubEnv('KEEP', 'kept')
    const out = path.join(tmp, 'o.txt')
    const code = await runAction(ctx('staging'), process.execPath, writer(out), {})
    expect(code).toBe(0)
    expect(fs.readFileSync(out, 'utf8')).toBe('base-val|own-val|kept')
  })
  it('--no-inherit drops process env', async () => {
    vi.stubEnv('KEEP', 'kept')
    const out = path.join(tmp, 'o.txt')
    await runAction(ctx('staging'), process.execPath, writer(out), { inherit: false })
    expect(fs.readFileSync(out, 'utf8')).toBe('base-val|own-val|undefined'.replace('undefined', ''))
  })
  it('propagates exit code and works with zero secrets', async () => {
    server.secrets = []
    const code = await runAction(ctx(), process.execPath, ['-e', 'process.exit(3)'], {})
    expect(code).toBe(3)
  })
  it('never logs values', async () => {
    const logs: string[] = []
    await runAction(ctx(), process.execPath, ['-e', '0'], {}, (m) => logs.push(m))
    expect(logs.join('')).not.toContain('base-val')
    expect(logs[0]).toMatch(/Injecting 1 secrets from development/)
  })
  it('reports spawn failure', async () => {
    await expect(runAction(ctx(), 'definitely-not-a-command-xyz', [], {})).rejects.toThrow(/Failed to start/)
  })
})

describe('set', () => {
  it('PATCHes when the name exists in that env', async () => {
    const r = await setAction(ctx(), 'BASE', 'new', {})
    expect(r.created).toBe(false)
    const call = server.calls.find((c) => c.method === 'PATCH')
    expect(call?.path).toBe('/api/secrets/sec_1')
    expect(call?.body).toEqual({ value: 'new' })
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false)
  })
  it('POSTs when the name is new (inherited names are overridden, not patched)', async () => {
    const r = await setAction(ctx('staging'), 'BASE', 'override', {})
    expect(r.created).toBe(true)
    const call = server.calls.find((c) => c.method === 'POST')
    expect(call?.body).toEqual({ projectId: 'prj_1', envId: 'env_stg', name: 'BASE', value: 'override' })
  })
  it('403 for viewers surfaces a friendly message', async () => {
    server.role = 'viewer'
    const err = await setAction(ctx(), 'NEW_ONE', 'v', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(friendlyError(err, 'Writing secrets')).toMatch(/Permission denied/)
  })
  it('409 race surfaces conflict message', () => {
    expect(friendlyError(new ApiError(409, 'CONFLICT', 'Secret already exists'))).toMatch(/Conflict/)
  })
  it('rejects invalid names client-side', async () => {
    await expect(setAction(ctx(), '1BAD', 'v', {})).rejects.toThrow(/Invalid secret name/)
    expect(server.calls.length).toBe(0)
  })
  it('reads value from stdin when omitted or "-"', async () => {
    const mk = () => Object.assign(Readable.from(['pa', 'ss\n']), { isTTY: false })
    expect(await readValue(undefined, mk())).toBe('pass')
    expect(await readValue('-', mk())).toBe('pass')
    expect(await readValue('direct', mk())).toBe('direct')
  })
})

describe('init', () => {
  it('creates project + env when missing and writes config without secrets', async () => {
    const dir = path.join(tmp, 'brand-new')
    fs.mkdirSync(dir)
    const cfg = await initAction(new ApiClient({ apiUrl: 'https://api.test', token: 't' }), 'https://api.test', { env: 'production' }, dir)
    expect(cfg.defaultEnv).toBe('production')
    expect(server.calls.some((c) => c.method === 'POST' && c.path === '/api/projects')).toBe(true)
    const written = JSON.parse(fs.readFileSync(path.join(dir, '.hushvault.json'), 'utf8'))
    expect(written.projectId).toMatch(/^prj_/)
    expect(written.apiUrl).toBe('https://api.test')
  })
  it('selects an existing project by slug and env by name', async () => {
    const cfg = await initAction(new ApiClient({ apiUrl: 'https://api.test', token: 't' }), 'https://api.test', { project: 'demo-app', env: 'Staging' }, tmp)
    expect(cfg.projectId).toBe('prj_1')
    expect(cfg.defaultEnv).toBe('staging')
    expect(server.calls.some((c) => c.method === 'POST')).toBe(false)
  })
  it('errors on unknown --project and 403 on create', async () => {
    const client = new ApiClient({ apiUrl: 'https://api.test', token: 't' })
    await expect(initAction(client, 'https://api.test', { project: 'zzz', env: 'development' }, tmp)).rejects.toThrow(/demo-app/)
    server.role = 'member'
    const err = await initAction(client, 'https://api.test', { env: 'development' }, path.join(tmp, 'x')).catch((e: unknown) => e)
    expect((err as ApiError).status).toBe(403)
  })
})

describe('share', () => {
  it('encrypts client-side and keeps the key out of the request', async () => {
    const link = await shareAction(new ApiClient({ apiUrl: 'https://api.test', token: 't' }), 'hunter2', { views: '2', hours: '1' }, () => 0)
    const [url, key] = link.split('#')
    expect(url).toBe('https://hushvault.dev/share/tok_1')
    expect(key).toBeTruthy()
    const call = server.calls.find((c) => c.path === '/api/share')!
    const body = call.body as { encryptedPayload: string; maxViews: number; expiresAt: string }
    expect(body.maxViews).toBe(2)
    expect(body.expiresAt).toBe('1970-01-01T01:00:00.000Z')
    expect(JSON.stringify(call)).not.toContain(key!)
    expect(JSON.stringify(call)).not.toContain('hunter2')
    // round-trip decrypt
    const raw = Buffer.from(body.encryptedPayload, 'base64url')
    const k = await crypto.subtle.importKey('raw', Buffer.from(key!, 'base64url'), 'AES-GCM', false, ['decrypt'])
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, k, raw.subarray(12))
    expect(new TextDecoder().decode(pt)).toBe('hunter2')
  })
  it('validates views', async () => {
    await expect(shareAction(ctx().client, 'x', { views: '0' })).rejects.toThrow(/--views/)
  })
})

describe('credential origin pinning', () => {
  it('refuses a project apiUrl whose origin differs from the signed-in server, before any request', async () => {
    const { resolveApiUrl } = await import('../src/lib/context.js')
    process.env['HUSHVAULT_API_URL'] = 'https://api.hushvault.dev'
    try {
      await expect(resolveApiUrl(undefined, 'https://evil.example')).rejects.toThrow(/never sent to a server chosen by a repository file/)
      await expect(resolveApiUrl(undefined, 'https://api.hushvault.dev.evil.example')).rejects.toThrow()
      await expect(resolveApiUrl(undefined, 'https://api.hushvault.dev/')).resolves.toBe('https://api.hushvault.dev')
      await expect(resolveApiUrl(undefined, undefined)).resolves.toBe('https://api.hushvault.dev')
    } finally {
      delete process.env['HUSHVAULT_API_URL']
    }
  })

  it('does not pass HUSHVAULT_* variables to the child process', async () => {
    const { buildChildEnv } = await import('../src/commands/run.js')
    process.env['HUSHVAULT_TOKEN'] = 'hv_live_secret'
    try {
      const env = buildChildEnv({ DB: 'x' }, true)
      expect(env['HUSHVAULT_TOKEN']).toBeUndefined()
      expect(env['DB']).toBe('x')
    } finally {
      delete process.env['HUSHVAULT_TOKEN']
    }
  })
})
