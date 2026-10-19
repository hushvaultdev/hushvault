#!/usr/bin/env node
// Operator-run dogfood setup (#126 steps 5 and 7). Idempotently ensures a project,
// environment, canary secret and GitHub OIDC repo rule exist on the chosen HushVault
// deployment, then prints the non-secret values the self-test repo needs.
//
// Runs on the OPERATOR's machine so credentials never leave it. Login and all calls
// happen inside one process (session tokens live ~15 minutes). Rule creation is
// human-gated on the server (`requireHuman`), which is why this takes a password
// login and not an hv_live_* API key — by design, a leaked key cannot mint access.
//
// Usage:
//   HUSHVAULT_EMAIL=you@example.com HUSHVAULT_PASSWORD=... \
//     node scripts/dogfood-setup.mjs --target dev|production \
//       --repo owner/name --ref refs/heads/main [--org <slug>] [--rotate-canary]
//   node scripts/dogfood-setup.mjs --target dev --repo owner/name --ref refs/heads/main --status
//
// Set the password without shell echo:
//   PowerShell:  $env:HUSHVAULT_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
//                  [Runtime.InteropServices.Marshal]::SecureStringToBSTR((Read-Host -AsSecureString)))
//   bash:        read -rs HUSHVAULT_PASSWORD && export HUSHVAULT_PASSWORD
//
// Exit codes: 0 ok · 1 failure · 2 wrong credentials · 3 the deployment cannot verify
// a token it just issued (JWT secret inconsistency — stop and investigate).
//
// Prints names, ids, statuses and the canary value (non-secret by design). Never
// prints the password or the session token.
import { createInterface } from 'node:readline/promises'

const HOSTS = { dev: 'https://api-beta.hushvault.dev', production: 'https://api.hushvault.dev' }
const PROJECT_SLUG = 'dogfood'
const ENV_NAME = 'ci'
const CANARY_NAME = 'OIDC_SELFTEST_CANARY'

/**
 * Abort with a specific exit code. Thrown rather than `process.exit()`-ed: calling
 * process.exit() while fetch's keepalive sockets are still open crashes Node on
 * Windows with a libuv assertion, which would destroy the exit-code contract this
 * script exists to provide.
 */
class Abort extends Error {
  constructor(code, message) { super(message); this.code = code }
}

function parseArgs(argv) {
  const args = { target: 'dev', status: false, rotateCanary: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--target') args.target = argv[++i]
    else if (a === '--repo') args.repo = argv[++i]
    else if (a === '--ref') args.ref = argv[++i]
    else if (a === '--org') args.org = argv[++i]
    else if (a === '--status') args.status = true
    else if (a === '--rotate-canary') args.rotateCanary = true
    else throw new Abort(1, `Unknown argument: ${a}`)
  }
  if (!HOSTS[args.target]) throw new Abort(1, `--target must be dev or production (got: ${args.target})`)
  if (!args.repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(args.repo)) {
    throw new Abort(1, '--repo owner/name is required')
  }
  if (!args.ref || !/^refs\//.test(args.ref)) {
    throw new Abort(1, '--ref refs/... is required (e.g. refs/heads/main)')
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const BASE = HOSTS[args.target]

  const email = process.env.HUSHVAULT_EMAIL
  const password = process.env.HUSHVAULT_PASSWORD
  if (!email || !password) {
    throw new Abort(1, 'Set HUSHVAULT_EMAIL and HUSHVAULT_PASSWORD (see the header for no-echo instructions).')
  }

  /** Same shape as scripts/phase5-onboarding.mjs: returns {status, json}, never throws on HTTP errors. */
  async function api(method, path, { token, body } = {}, attempt = 0) {
    const headers = { 'x-hushvault-client': 'dogfood-setup' }
    if (token) headers['authorization'] = `Bearer ${token}`
    if (body !== undefined) headers['content-type'] = 'application/json'
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    })
    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(Number(res.headers.get('retry-after') ?? 60), 70)
      console.error(`  rate limited; waiting ${wait}s once...`)
      await new Promise((r) => setTimeout(r, wait * 1000))
      return api(method, path, { token, body }, 1)
    }
    let json = null
    try { json = await res.json() } catch { /* non-JSON body */ }
    return { status: res.status, json }
  }

  const fail = (step, r) => {
    throw new Abort(1, `FAIL at ${step}: HTTP ${r.status} ${JSON.stringify(r.json?.error ?? r.json)}`)
  }

  // ---- login + self-test -----------------------------------------------------------
  const login = await api('POST', '/api/auth/login', { body: { email, password } })
  if (login.status === 401) throw new Abort(2, 'Login rejected: wrong email or password.')
  if (login.status !== 200) fail('login', login)
  let token = login.json.data.token
  let orgId = login.json.data.orgId
  let role = login.json.data.role

  const selfTest = await api('GET', '/api/orgs', { token })
  if (selfTest.status === 401) {
    throw new Abort(3, [
      'Login succeeded but the deployment rejected its own token.',
      'This is a JWT secret inconsistency on the deployment. Stop and investigate.',
    ].join('\n'))
  }
  if (selfTest.status !== 200) fail('self-test', selfTest)

  // ---- org binding -----------------------------------------------------------------
  const orgs = selfTest.json.data
  if (args.org) {
    const wanted = orgs.find((o) => o.slug === args.org)
    if (!wanted) {
      throw new Abort(1, `--org ${args.org}: not a member. Orgs: ${orgs.map((o) => o.slug).join(', ')}`)
    }
    if (wanted.id !== orgId) {
      const sw = await api('POST', `/api/orgs/${wanted.id}/switch`, { token, body: {} })
      if (sw.status !== 200) fail('org switch', sw)
      token = sw.json.data.token
      orgId = sw.json.data.orgId
      role = sw.json.data.role
    }
  }
  const boundOrg = orgs.find((o) => o.id === orgId)
  const orgLabel = boundOrg?.slug ?? orgId
  console.log(`Acting as role=${role} in org "${orgLabel}" on ${BASE}`)
  if (role !== 'owner' && role !== 'admin') {
    throw new Abort(1, 'This script needs an admin or owner role in the target org.')
  }

  // ---- prod confirmation -----------------------------------------------------------
  if (args.target === 'production' && !args.status) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const answer = await rl.question(`Type the org slug ("${orgLabel}") to confirm PRODUCTION changes: `)
      if (answer.trim() !== orgLabel) throw new Abort(1, 'Confirmation did not match; nothing changed.')
    } finally {
      rl.close()
    }
  }

  // ---- resolve or create the fixture -----------------------------------------------
  async function ensureProject() {
    const list = await api('GET', '/api/projects', { token })
    if (list.status !== 200) fail('list projects', list)
    const existing = list.json.data.find((p) => p.slug === PROJECT_SLUG)
    if (existing) return { id: existing.id, state: 'existing' }
    const created = await api('POST', '/api/projects', { token, body: { name: 'Dogfood', slug: PROJECT_SLUG } })
    if (created.status === 409) return ensureProject() // benign race
    if (created.status !== 201 && created.status !== 200) fail('create project', created)
    return { id: created.json.data.id, state: 'created' }
  }

  async function ensureEnvironment(projectId) {
    const list = await api('GET', `/api/environments?projectId=${projectId}`, { token })
    if (list.status !== 200) fail('list environments', list)
    const existing = list.json.data.find((e) => e.name === ENV_NAME)
    if (existing) return { id: existing.id, state: 'existing' }
    const created = await api('POST', '/api/environments', { token, body: { projectId, name: ENV_NAME } })
    if (created.status === 409) return ensureEnvironment(projectId)
    if (created.status !== 201 && created.status !== 200) fail('create environment', created)
    return { id: created.json.data.id, state: 'created' }
  }

  async function ensureCanary(projectId, envId) {
    const read = await api('GET', `/api/secrets/${CANARY_NAME}?envId=${envId}`, { token })
    if (read.status === 200) {
      if (args.rotateCanary) {
        const next = crypto.randomUUID()
        const patch = await api('PATCH', `/api/secrets/${read.json.data.id}`, { token, body: { value: next } })
        if (patch.status !== 200) fail('rotate canary', patch)
        return { value: next, state: 'rotated' }
      }
      return { value: read.json.data.value, state: 'existing' }
    }
    if (read.status !== 404) fail('read canary', read)
    const value = crypto.randomUUID()
    const created = await api('POST', '/api/secrets', { token, body: { projectId, envId, name: CANARY_NAME, value } })
    if (created.status === 409) return ensureCanary(projectId, envId)
    if (created.status !== 201) fail('create canary', created)
    return { value, state: 'created' }
  }

  async function findRule(envId) {
    const list = await api('GET', '/api/ci-access/github/rules', { token })
    if (list.status !== 200) fail('list rules', list)
    return list.json.data.find(
      (r) => r.envId === envId && r.repository === args.repo.toLowerCase() && r.ref === args.ref,
    )
  }

  async function ensureRule(envId) {
    const existing = await findRule(envId)
    if (existing) return { id: existing.id, state: 'existing' }
    const created = await api('POST', '/api/ci-access/github/rules', {
      token,
      body: { envId, repository: args.repo, ref: args.ref },
    })
    if (created.status === 409) {
      const after = await findRule(envId)
      if (after) return { id: after.id, state: 'existing' }
      fail('create rule (409 but absent on re-list — rule cap reached?)', created)
    }
    if (created.status !== 201) fail('create rule', created)
    return { id: created.json.data.id, state: 'created' }
  }

  const project = await ensureProject()
  const environment = await ensureEnvironment(project.id)

  if (args.status) {
    const rule = await findRule(environment.id)
    const canary = await api('GET', `/api/secrets/${CANARY_NAME}?envId=${environment.id}`, { token })
    console.log(`project ${PROJECT_SLUG}: ${project.id}`)
    console.log(`environment ${ENV_NAME}: ${environment.id}`)
    console.log(`canary: ${canary.status === 200 ? 'present' : 'MISSING'}`)
    console.log(rule
      ? `rule ${rule.id}: lastUsedAt=${rule.lastUsedAt ?? 'never'}`
      : `rule for ${args.repo} @ ${args.ref}: MISSING`)
    return
  }

  const canary = await ensureCanary(project.id, environment.id)
  const rule = await ensureRule(environment.id)

  const suffix = args.target === 'production' ? '_PROD' : ''
  console.log('')
  console.log(`project ${PROJECT_SLUG}: ${project.id} (${project.state})`)
  console.log(`environment ${ENV_NAME}: ${environment.id} (${environment.state})`)
  console.log(`canary ${CANARY_NAME}: (${canary.state})`)
  console.log(`rule ${args.repo} @ ${args.ref}: ${rule.id} (${rule.state})`)
  console.log('')
  console.log('Set these in the self-test repo (values are non-secret by design):')
  console.log(`  gh variable set HUSHVAULT_SELFTEST_ENV_ID${suffix} --body "${environment.id}"`)
  console.log(`  gh variable set HUSHVAULT_SELFTEST_CANARY${suffix} --body "${canary.value}"`)
}

try {
  await main()
} catch (err) {
  if (err instanceof Abort) {
    console.error(err.message)
    process.exitCode = err.code
  } else {
    console.error(`Unexpected failure: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  }
}
