import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const require_ = createRequire(import.meta.url)
const action = require_('../src/index.js') as {
  mask: (v: string) => void
  appendFileCommand: (file: string, name: string, value: string) => void
  exportableName: (name: string) => boolean
  parseNames: (raw: string) => string[]
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
  function setup(opts: { exchangeStatus?: number; readStatus?: number; secrets?: unknown[]; prefix?: string } = {}) {
    process.env['INPUT_API-URL'] = 'https://api.test'
    process.env['INPUT_ENVIRONMENT-ID'] = 'env_1'
    process.env['INPUT_AUDIENCE'] = 'https://api.test'
    process.env['ACTIONS_ID_TOKEN_REQUEST_URL'] = 'https://ghtoken.test/req?x=1'
    process.env['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] = 'gh-request-token'
    process.env['INPUT_PREFIX'] = opts.prefix ?? 'APP_'
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
    expect(env).toContain('APP_DB_URL<<HV_')
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

  it('with an explicit names list, only those are exported and the backstop list does not block the author', async () => {
    setup({ secrets: [{ name: 'DB_URL', value: 'a' }, { name: 'API_KEY', value: 'b' }, { name: 'LD_PRELOAD', value: '/tmp/evil.so' }], prefix: '' })
    process.env['INPUT_NAMES'] = 'DB_URL, LD_PRELOAD'
    await action.main()
    const env = readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')
    expect(env).toContain('DB_URL<<HV_')
    expect(env).toContain('LD_PRELOAD<<HV_') // the workflow author asked for it explicitly
    expect(env).not.toContain('API_KEY')
    expect(readFileSync(process.env['GITHUB_OUTPUT'] as string, 'utf8')).toBe('names=["DB_URL","API_KEY","LD_PRELOAD"]\n')
    expect(env).toContain('LD_PRELOAD<<HV_')
  })

  it('fails when a requested name is not in the environment, rather than exporting nothing quietly', async () => {
    setup({ secrets: [{ name: 'DB_URL', value: 'a' }], prefix: '' })
    process.env['INPUT_NAMES'] = 'DB_URL MISSING_ONE'
    await expect(action.main()).rejects.toThrow('exit')
    expect(out.join('')).toContain('Not found in that environment: MISSING_ONE')
  })

  it('a prefix neutralises every dangerous name, including the ones a denylist missed', async () => {
    // CC, MAKE, MAKEFLAGS and CDPATH were all proven to give code execution; under a prefix none of them is the
    // variable the toolchain reads, which is why the prefix — not the list — is the control.
    setup({ secrets: [{ name: 'CC', value: 'x' }, { name: 'MAKE', value: 'x' }, { name: 'MAKEFLAGS', value: 'x' }, { name: 'CDPATH', value: 'x' }, { name: 'STATE_isPost', value: 'x' }] })
    await action.main()
    const env = readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')
    for (const name of ['CC', 'MAKE', 'MAKEFLAGS', 'CDPATH', 'STATE_isPost']) {
      expect(env).toContain(`APP_${name}<<HV_`)
      expect(env).not.toMatch(new RegExp(`^${name}<<`, 'm'))
    }
  })

  it('a prefix makes an otherwise unsafe name exportable, but a dangerous prefix is still caught', async () => {
    setup({ secrets: [{ name: 'PATH', value: '/tmp/evil' }] })
    await action.main()
    expect(readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')).toMatch(/^APP_PATH<<HV_/)

    setup({ secrets: [{ name: 'PRELOAD', value: '/tmp/evil.so' }], prefix: 'LD_' })
    await expect(action.main()).rejects.toThrow('exit')
    expect(out.join('')).toContain('Refusing to export LD_PRELOAD')
  })

  it('a truncated prefix cannot reassemble a build variable from a secret name', async () => {
    // prefix 'MAKE' + secret 'FLAGS' would be MAKEFLAGS; 'C' + 'C' would be CC; 'CD' + 'PATH' would be CDPATH.
    // Requiring the trailing underscore removes the whole shape instead of listing the combinations.
    for (const prefix of ['MAKE', 'C', 'CD', 'P']) {
      setup({ secrets: [{ name: 'FLAGS', value: 'x' }], prefix })
      await expect(action.main()).rejects.toThrow('exit')
      expect(out.join(''), prefix).toContain('must end with')
      expect(readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')).toBe('')
    }
  })

  it('export-env is case-insensitive about false', async () => {
    for (const value of ['false', 'FALSE', ' False ']) {
      setup({ secrets: [{ name: 'DB_URL', value: 'v' }], prefix: '' })
      process.env['INPUT_EXPORT-ENV'] = value
      await action.main()
      expect(readFileSync(process.env['GITHUB_ENV'] as string, 'utf8'), value).toBe('')
      expect(out.join('')).toContain('::add-mask::v')
    }
  })

  it('ATTACK: refuses to run at all when neither prefix nor names is set', async () => {
    // Otherwise a `member` picks the variable names, and CC / MAKE / CDPATH / LD_PRELOAD are code execution.
    setup({ secrets: [{ name: 'CC', value: 'touch /tmp/pwned; true' }], prefix: '' })
    await expect(action.main()).rejects.toThrow('exit')
    expect(exited).toBe(1)
    expect(out.join('')).toContain('Set "prefix"')
    expect(readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')).toBe('')
  })

  it('names alone is enough, and the names a denylist would have missed are the author\'s own choice', async () => {
    setup({ secrets: [{ name: 'CC', value: 'cc' }, { name: 'DB_URL', value: 'x' }], prefix: '' })
    process.env['INPUT_NAMES'] = 'DB_URL'
    await action.main()
    const env = readFileSync(process.env['GITHUB_ENV'] as string, 'utf8')
    expect(env).toContain('DB_URL<<HV_')
    expect(env).not.toContain('CC<<')
  })

  it('refuses to send a token to a host the audience was not minted for', async () => {
    setup()
    process.env['INPUT_AUDIENCE'] = 'https://api.hushvault.dev'
    process.env['INPUT_API-URL'] = 'https://attacker.example'
    await expect(action.main()).rejects.toThrow('exit')
    expect(out.join('')).toContain('audience must match api-url')
  })
})

describe('exportableName', () => {
  it('refuses loader, path, interpreter, build-tool and runner-credential names in any case, and odd shapes', () => {
    for (const name of ['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS',
      'GITHUB_TOKEN', 'GITHUB_ENV', 'RUNNER_TEMP', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'GIT_SSH_COMMAND', 'BASH_ENV',
      'PYTHONPATH', 'RUBYOPT', 'PERL5OPT', 'IFS', 'SHELLOPTS', 'INPUT_API-URL',
      // Every name a verification pass proved was exportable before this was made case-insensitive and widened.
      'ld_preload', 'Ld_Preload', 'lD_PRELOAD', 'path', 'Path', 'pAtH', 'github_token', 'Github_Token',
      'node_options', 'Node_Options', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS',
      'DOTNET_STARTUP_HOOKS', 'HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'NODE_EXTRA_CA_CERTS',
      'npm_config_script_shell', 'npm_config_registry', 'GRADLE_OPTS', 'MAVEN_OPTS', 'PYTHONHOME', 'RUBYLIB',
      'PERL5LIB', 'CLASSPATH', 'LESSOPEN', 'BUNDLE_GEMFILE', 'PIP_INDEX_URL', 'GOFLAGS', 'PROMPT_COMMAND',
      'TERMINFO', 'MANPAGER', 'EDITOR', 'GOFLAGS', 'GOPROXY', 'RUSTFLAGS', 'CARGO_HOME']) {
      expect(action.exportableName(name), name).toBe(false)
    }
    for (const name of ['', '1BAD', 'WITH-DASH', 'WITH SPACE', 'WITH=EQUALS', 'a\nb']) {
      expect(action.exportableName(name), JSON.stringify(name)).toBe(false)
    }
    // Not over-broad: ordinary names that merely start with a risky prefix stay exportable.
    for (const name of ['DB_URL', 'API_KEY', 'STRIPE_SECRET', '_PRIVATE', 'MY_GITHUB_TOKEN', 'SENTRY_DSN', 'GOOD', 'GOAL', 'ENVOY_KEY']) {
      expect(action.exportableName(name), name).toBe(true)
    }
  })
})

describe('names allowlist', () => {
  it('parses whitespace and comma separated lists', () => {
    expect(action.parseNames('')).toEqual([])
    expect(action.parseNames(' A_B, C_D\n E_F ')).toEqual(['A_B', 'C_D', 'E_F'])
  })
})

// action.yml used to name dist/index.js, which .gitignore excluded, so the entrypoint
// was never committed and the action failed to load for anyone using it from a ref.
// It now runs src/index.js, which is the file these tests exercise. Keep it that way:
// the action has no dependencies and needs no bundle, so a build step would only
// reintroduce a second copy that can drift or go missing.
describe('shipped entrypoint', () => {
  it('action.yml runs the file the tests exercise, and it is committed', () => {
    const yml = readFileSync(join(__dirname, '..', 'action.yml'), 'utf8')
    expect(yml).toContain('main: src/index.js')
    expect(yml).not.toContain('dist/')

    const tracked = execFileSync('git', ['ls-files', '--error-unmatch', 'apps/secrets-action/src/index.js'], {
      cwd: join(__dirname, '..', '..', '..'),
      encoding: 'utf8',
    })
    expect(tracked.trim()).toBe('apps/secrets-action/src/index.js')
  })

  it('needs no bundler: it requires only node builtins', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.js'), 'utf8')
    const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
    expect(required.length).toBeGreaterThan(0)
    for (const mod of required) expect(mod.startsWith('node:')).toBe(true)
  })
})
