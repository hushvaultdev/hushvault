import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require_ = createRequire(import.meta.url)
const action = require_('../src/index.js') as {
  mask: (v: string) => void
  appendFileCommand: (file: string, name: string, value: string) => void
  main: () => Promise<void>
}

const SECRET = 'pa55-CANARY-line1\nCANARY-line2'
let out: string[]
let dir: string
let exited: number | null

beforeEach(() => {
  out = []
  exited = null
  dir = mkdtempSync(join(tmpdir(), 'hv-action-'))
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => { out.push(String(chunk)); return true }) as never)
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { exited = code ?? 0; throw new Error('exit') }) as never)
})
afterEach(() => { vi.restoreAllMocks(); for (const k of Object.keys(process.env)) if (k.startsWith('INPUT_')) delete process.env[k] })

describe('mask', () => {
  it('masks every line of a multi-line value and skips empty lines', () => {
    action.mask(SECRET)
    expect(out).toEqual(['::add-mask::pa55-CANARY-line1\n', '::add-mask::CANARY-line2\n'])
    out.length = 0
    action.mask('a\n\nb')
    expect(out).toEqual(['::add-mask::a\n', '::add-mask::b\n'])
  })
})

describe('appendFileCommand', () => {
  it('writes a heredoc with a random delimiter so a multi-line value cannot break out', () => {
    const file = join(dir, 'env')
    writeFileSync(file, '')
    action.appendFileCommand(file, 'DB_URL', SECRET)
    const written = readFileSync(file, 'utf8')
    expect(written).toMatch(/^DB_URL<<HV_[0-9a-f]{32}\n/)
    expect(written).toContain(SECRET)
    // Two writes use different delimiters: a value copied from one cannot terminate the other.
    action.appendFileCommand(file, 'OTHER', 'x')
    const delimiters = [...readFileSync(file, 'utf8').matchAll(/<<(HV_[0-9a-f]{32})/g)].map((m) => m[1])
    expect(new Set(delimiters).size).toBe(2)
  })
})

describe('main', () => {
  function setup(opts: { exchangeStatus?: number; readStatus?: number; secrets?: unknown[] } = {}) {
    process.env['INPUT_API-URL'] = 'https://api.test'
    process.env['INPUT_ENVIRONMENT-ID'] = 'env_1'
    process.env['INPUT_AUDIENCE'] = 'https://api.test'
    process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'https://ghtoken.test/req?x=1'
    process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'gh-request-token'
    process.env['GITHUB_ENV'] = join(dir, 'github_env')
    process.env['GITHUB_OUTPUT'] = join(dir, 'github_output')
    writeFileSync(process.env['GITHUB_ENV'], '')
    writeFileSync(process.env['GITHUB_OUTPUT'], '')
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url))
      if (String(url).startsWith('https://ghtoken.test/')) {
        return new Response(JSON.stringify({ value: 'gh.oidc.token' }), { status: 200 })
      }
      if (String(url).endsWith('/api/auth/github-oidc')) {
        expect(String((init?.headers as Record<string, string>)['content-type'])).toBe('application/json')
        return new Response(JSON.stringify({ data: { token: 'hv-ci-token-CANARY', expiresIn: 600 } }), { status: opts.exchangeStatus ?? 200 })
      }
      return new Response(JSON.stringify({ data: { secrets: opts.secrets ?? [{ name: 'DB_URL', value: SECRET }, { name: 'PLAIN', value: 'simple' }] } }), { status: opts.readStatus ?? 200 })
    }))
    return calls
  }

  afterEach(() => vi.unstubAllGlobals())

  it('requests the audience, masks every value before exporting, and never prints a value', async () => {
    const calls = setup()
    await action.main()
    expect(calls[0]).toBe('https://ghtoken.test/req?x=1&audience=https%3A%2F%2Fapi.test')
    const printed = out.join('')
    // Masks come first, and the only lines containing the secret are the mask commands themselves.
    expect(printed).toContain('::add-mask::pa55-CANARY-line1')
    expect(printed).toContain('::add-mask::CANARY-line2')
    expect(printed).toContain('::add-mask::hv-ci-token-CANARY')
    for (const line of printed.split('\n').filter((l) => l.includes('CANARY'))) {
      expect(line.startsWith('::add-mask::')).toBe(true)
    }
    expect(printed).toContain('Loaded 2 secrets from HushVault.')

    const env = readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')
    expect(env).toContain('DB_URL<<HV_')
    expect(env).toContain(SECRET)
    // The output carries names only.
    const output = readFileSync(process.env['GITHUB_OUTPUT'] as string, 'utf8')
    expect(output).toBe('names=["DB_URL","PLAIN"]\n')
    expect(output).not.toContain('CANARY')
  })

  it('fails without id-token permission, on a refused exchange, and on a non-https api url', async () => {
    setup()
    delete process.env['ACTIONS_ID_TOKEN_REQUEST_URL']
    await expect(action.main()).rejects.toThrow('exit')
    expect(exited).toBe(1)
    expect(out.join('')).toContain('permissions: id-token: write')

    setup({ exchangeStatus: 403 })
    await expect(action.main()).rejects.toThrow('exit')
    expect(out.join('')).toContain('refused the OIDC exchange')

    setup()
    process.env['INPUT_API-URL'] = 'http://evil.example'
    await expect(action.main()).rejects.toThrow('exit')
    expect(out.join('')).toContain('must use https')
  })

  it('skips malformed entries rather than exporting them', async () => {
    setup({ secrets: [{ name: 'GOOD', value: 'v' }, { name: 'NO_VALUE' }, { value: 'no-name' }, null] })
    await action.main()
    expect(readFileSync(process.env['GITHUB_OUTPUT'] as string, 'utf8')).toBe('names=["GOOD"]\n')
  })
})
