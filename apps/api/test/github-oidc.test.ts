import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GITHUB_ISSUER, DEFAULT_GITHUB_JWKS_URL, ruleMatches } from '../src/integrations/github-oidc'
import { verifyCiToken } from '../src/lib/ci-tokens'
import { call, createTestEnv, seedEnvironment, seedProject, seedUser, type TestEnv } from './helpers/env'
import { seedSecret } from './helpers/env-secrets'

const AUDIENCE = 'https://api.hushvault.dev'
const b64url = (s: string) => Buffer.from(s).toString('base64url')

async function makeKey(kid = 'k1') {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
  )
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, unknown>
  return { pair, jwk: { kty: 'RSA', kid, alg: 'RS256', use: 'sig', n: jwk['n'], e: jwk['e'] } }
}

let key: Awaited<ReturnType<typeof makeKey>>
let env: TestEnv
let logged: string[]

async function githubToken(claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000)
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.jwk.kid }))
  const p = b64url(JSON.stringify({
    iss: DEFAULT_GITHUB_ISSUER, aud: AUDIENCE, iat: now, nbf: now, exp: now + 300,
    sub: 'repo:acme/app:ref:refs/heads/main', repository: 'acme/app', repository_id: '12345',
    repository_owner: 'acme', ref: 'refs/heads/main', event_name: 'push', ...claims,
  }))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.pair.privateKey, new TextEncoder().encode(`${h}.${p}`))
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
}

async function world() {
  const admin = await seedUser(env, { role: 'admin' })
  const projectId = await seedProject(env, admin.orgId)
  const envId = await seedEnvironment(env, projectId)
  await seedSecret(env, projectId, envId, 'DB_URL', 'value-CANARY-oidc')
  return { admin, projectId, envId }
}

const addRule = (token: string, json: Record<string, unknown>) => call(env, 'POST', '/api/ci-access/github/rules', { token, json })
const exchange = (json: unknown) => call(env, 'POST', '/api/auth/github-oidc', { json })

beforeEach(async () => {
  env = createTestEnv()
  key = await makeKey()
  logged = []
  for (const level of ['log', 'warn', 'error', 'info'] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) })
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
    if (String(url) === DEFAULT_GITHUB_JWKS_URL) return new Response(JSON.stringify({ keys: [key.jwk] }), { status: 200 })
    return new Response('not found', { status: 404 })
  }))
})
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('ruleMatches', () => {
  const base = { id: 'ocr_1', orgId: 'o', envId: 'e', repository: 'acme/app', repositoryId: null, ref: 'refs/heads/main', environment: null }
  const claims = { repository: 'acme/app', repository_id: '12345', ref: 'refs/heads/main' }

  it('matches exactly and never by prefix, case or a missing claim', () => {
    expect(ruleMatches(base, claims)).toBe(true)
    expect(ruleMatches(base, { ...claims, repository: 'Acme/App' })).toBe(true) // claim casing is normalised
    expect(ruleMatches(base, { ...claims, repository: 'acme/app-evil' })).toBe(false)
    expect(ruleMatches(base, { ...claims, repository: 'evil/acme/app' })).toBe(false)
    expect(ruleMatches(base, { ...claims, ref: 'refs/heads/main-evil' })).toBe(false)
    expect(ruleMatches(base, { ...claims, ref: undefined })).toBe(false)
    expect(ruleMatches(base, { ...claims, repository: undefined })).toBe(false)
    expect(ruleMatches({ ...base, ref: null, environment: null }, claims)).toBe(false) // a rule with no constraint matches nothing
  })

  it('never matches a pull request context, whose ref or environment looks trusted but is not', () => {
    for (const event_name of ['pull_request', 'pull_request_target']) {
      expect(ruleMatches(base, { ...claims, event_name })).toBe(false)
      expect(ruleMatches({ ...base, ref: null, environment: 'production' }, { ...claims, environment: 'production', event_name })).toBe(false)
    }
    expect(ruleMatches(base, { ...claims, event_name: 'push' })).toBe(true)
    expect(ruleMatches(base, { ...claims, event_name: 'workflow_dispatch' })).toBe(true)
  })

  it('honours a pinned repository id, so a rename or transfer cannot inherit the grant', () => {
    const pinned = { ...base, repositoryId: '12345' }
    expect(ruleMatches(pinned, claims)).toBe(true)
    expect(ruleMatches(pinned, { ...claims, repository_id: '999' })).toBe(false)
    expect(ruleMatches(pinned, { ...claims, repository_id: undefined })).toBe(false)
    expect(ruleMatches(pinned, { ...claims, repository_id: 12345 })).toBe(true) // numeric form tolerated
    expect(ruleMatches(pinned, { ...claims, repository_id: ['12345'] as never })).toBe(false)
  })

  it('an environment rule needs the environment claim and ignores the ref', () => {
    const envRule = { ...base, ref: null, environment: 'production' }
    expect(ruleMatches(envRule, { ...claims, environment: 'production' })).toBe(true)
    expect(ruleMatches(envRule, { ...claims, environment: 'staging' })).toBe(false)
    expect(ruleMatches(envRule, claims)).toBe(false)
  })
})

describe('POST /api/auth/github-oidc', () => {
  it('exchanges a valid token for a scoped read-only token that reads only its environment', async () => {
    const w = await world()
    const rule = await addRule(w.admin.token, { envId: w.envId, repository: 'acme/app', repositoryId: '12345', ref: 'refs/heads/main' })
    expect(rule.status).toBe(201)

    const res = await exchange({ token: await githubToken(), envId: w.envId })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ envId: w.envId, orgId: w.admin.orgId, expiresIn: 600 })
    expect(await verifyCiToken(res.body.data.token, env.JWT_SECRET)).toMatchObject({ envId: w.envId })

    const read = await call(env, 'GET', `/api/environments/${w.envId}/resolved?values=true`, { token: res.body.data.token })
    expect(read.status).toBe(200)
    expect(JSON.stringify(read.body)).toContain('value-CANARY-oidc')
    expect((await call(env, 'GET', '/api/projects', { token: res.body.data.token })).status).toBe(403)

    const audit = await env.DB.prepare("SELECT org_id, actor_id, actor_type, resource_id FROM audit_log WHERE action = 'auth.oidc.exchange'").first<{ org_id: string; actor_id: string | null; actor_type: string; resource_id: string }>()
    expect(audit).toMatchObject({ org_id: w.admin.orgId, actor_id: null, actor_type: 'system', resource_id: rule.body.data.id })
    const used = await env.DB.prepare('SELECT last_used_at FROM oidc_repo_rules WHERE id = ?').bind(rule.body.data.id).first<{ last_used_at: string | null }>()
    expect(used?.last_used_at).not.toBeNull()
  })

  it('refuses a workflow with no rule, a rule for another environment, and another branch', async () => {
    const w = await world()
    const other = await seedEnvironment(env, w.projectId, 'other')
    expect((await exchange({ token: await githubToken(), envId: w.envId })).status).toBe(403) // no rules at all

    await addRule(w.admin.token, { envId: w.envId, repository: 'acme/app', ref: 'refs/heads/main' })
    expect((await exchange({ token: await githubToken(), envId: other })).status).toBe(403) // rule is for another env
    expect((await exchange({ token: await githubToken({ ref: 'refs/heads/dev' }), envId: w.envId })).status).toBe(403)
    expect((await exchange({ token: await githubToken({ repository: 'acme/other' }), envId: w.envId })).status).toBe(403)
    // A pull_request ref is a different ref, so it does not inherit a branch rule.
    expect((await exchange({ token: await githubToken({ ref: 'refs/pull/7/merge', event_name: 'pull_request' }), envId: w.envId })).status).toBe(403)
    // ATTACK: pull_request_target runs in the BASE repo context, so its ref IS the trusted branch. Still refused.
    expect((await exchange({ token: await githubToken({ event_name: 'pull_request_target' }), envId: w.envId })).status).toBe(403)
  })

  it('ATTACK: a rule in one organisation cannot be used to read another organisation; cross-org env ids are refused', async () => {
    const a = await world()
    const b = await world()
    await addRule(a.admin.token, { envId: a.envId, repository: 'acme/app', ref: 'refs/heads/main' })
    // The same workflow asking for org B's environment finds no rule there.
    expect((await exchange({ token: await githubToken(), envId: b.envId })).status).toBe(403)
    const ok = await exchange({ token: await githubToken(), envId: a.envId })
    expect(ok.body.data.orgId).toBe(a.admin.orgId)
    // The issued token cannot read org B's environment even though it is a valid token.
    expect((await call(env, 'GET', `/api/environments/${b.envId}/resolved`, { token: ok.body.data.token })).status).toBe(403)
  })

  it('ATTACK: a token signed by someone else, for another audience, or from another issuer is rejected with one opaque error', async () => {
    const w = await world()
    await addRule(w.admin.token, { envId: w.envId, repository: 'acme/app', ref: 'refs/heads/main' })
    const evil = await makeKey('k1')
    const forge = async (claims: Record<string, unknown> = {}, signer = evil) => {
      const now = Math.floor(Date.now() / 1000)
      const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }))
      const p = b64url(JSON.stringify({ iss: DEFAULT_GITHUB_ISSUER, aud: AUDIENCE, iat: now, exp: now + 300, repository: 'acme/app', ref: 'refs/heads/main', ...claims }))
      const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.pair.privateKey, new TextEncoder().encode(`${h}.${p}`))
      return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`
    }
    const bodies = new Set<string>()
    for (const token of [await forge(), await githubToken({ aud: 'https://someone-else.example' }), await githubToken({ iss: 'https://evil.example' }), 'a.b.c' + 'x'.repeat(40)]) {
      const res = await exchange({ token, envId: w.envId })
      expect(res.status).toBe(401)
      bodies.add(JSON.stringify(res.body))
    }
    expect(bodies.size).toBe(1) // identical response for every rejection
    expect(logged.join('\n')).not.toContain('eyJ') // the token itself is never logged
  })

  it('returns 503 (not 401) when the key set cannot be fetched, so a GitHub outage is not mistaken for a bad token', async () => {
    const w = await world()
    await addRule(w.admin.token, { envId: w.envId, repository: 'acme/app', ref: 'refs/heads/main' })
    const token = await githubToken()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    expect((await exchange({ token, envId: w.envId })).status).toBe(503)
  })

  it('validates its own input and is rate limited per IP', async () => {
    const w = await world()
    expect((await exchange({ envId: w.envId })).status).toBe(400)
    expect((await exchange({ token: 'short', envId: w.envId })).status).toBe(400)
    expect((await exchange({ token: 'x'.repeat(100), envId: w.envId, extra: 1 })).status).toBe(400)
    let limited = false
    for (let i = 0; i < 40; i += 1) {
      if ((await exchange({ token: 'x'.repeat(100), envId: w.envId })).status === 429) { limited = true; break }
    }
    expect(limited).toBe(true)
  })
})
