#!/usr/bin/env node
// Phase 5 (#100) client-zero onboarding script for HushVault secret sync.
//
// Scripts the full multi-provider onboarding (task 1): one connection per provider, then bulk-create every target
// mapping a repo / Worker / project to a HushVault environment, idempotently (the Phase 2 /targets/bulk endpoint,
// so re-running is safe), then optionally preview or run every target. It is the reusable tool behind the
// client-onboarding runbook (docs/ONBOARDING.md).
//
// It prints only providers, labels, resource names, counts, target ids and run statuses — NEVER a secret value or
// a credential/token.
//
// USAGE (from the repo root, on your machine):
//   node scripts/phase5-onboarding.mjs <config.json> [--preview] [--run]
//     --preview  after creating targets, preview each (names only; writes nothing)
//     --run      after creating targets, run each (pushes). --run wins if both are given.
//
// CONFIG (JSON) — see docs/ONBOARDING.md for the full schema and per-provider token scopes:
//   {
//     "api": "https://api-beta.hushvault.dev",
//     "login": { "email": "you@example.com", "password": "..." },   // OR  "token": "<HushVault admin JWT>"
//     "connections": [
//       { "provider": "cloudflare-workers", "label": "cf", "credential": "<token>", "config": { "accountId": "..." },
//         "targets": [ { "project": "<id or name>", "env": "production", "resource": { "scriptName": "w1" }, "onChange": true } ] },
//       { "provider": "gitlab", "label": "gl", "credential": "<token>", "config": {},
//         "targets": [ { "project": "web", "env": "production", "resource": { "projectId": "12345" } } ] },
//       { "provider": "github-actions", "label": "gh", "credential": "<token>", "config": {},
//         "targets": [ { "project": "web", "env": "production", "resource": { "owner": "acme", "repo": "web" } } ] }
//     ]
//   }
// Connections require an ADMIN who signed in with email/password or a JWT (API keys cannot create connections).

import { readFileSync } from 'node:fs'

const configPath = process.argv[2]
const DO_RUN = process.argv.includes('--run')
const DO_PREVIEW = process.argv.includes('--preview') && !DO_RUN
if (!configPath) {
  console.error('Usage: node scripts/phase5-onboarding.mjs <config.json> [--preview] [--run]')
  process.exit(1)
}

let config
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'))
} catch (e) {
  console.error(`Could not read/parse config ${configPath}: ${e.message}`)
  process.exit(1)
}
const API = String(config.api || '').replace(/\/$/, '')
if (!API) { console.error('config.api is required'); process.exit(1) }
if (!Array.isArray(config.connections) || config.connections.length === 0) { console.error('config.connections must be a non-empty array'); process.exit(1) }

const BULK_MAX = 50
let token = typeof config.token === 'string' ? config.token : ''
const out = []
const say = (line) => { console.log(line); out.push(line) }
let problems = 0

async function api(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-hushvault-client': 'phase5-onboarding' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n))

async function main() {
  say('==================== HushVault Phase 5 onboarding ====================')
  say(`api: ${API}   at: ${new Date().toISOString()}   mode: ${DO_RUN ? 'run' : DO_PREVIEW ? 'preview' : 'create-only'}`)

  // 1. Authenticate.
  if (!token) {
    if (!config.login?.email || !config.login?.password) { console.error('Provide config.token or config.login { email, password }'); process.exit(1) }
    const login = await api('POST', '/api/auth/login', { email: config.login.email, password: config.login.password })
    token = login.json?.data?.token
    if (!token) { console.error(`Login failed: HTTP ${login.status}`); process.exit(1) }
    say(`authenticated as ${config.login.email}`)
  } else {
    say('authenticated with supplied token')
  }

  // 2. Cache projects (resolve project names -> ids).
  const projResp = await api('GET', '/api/projects')
  const projects = Array.isArray(projResp.json?.data) ? projResp.json.data : []
  const projectIdByName = new Map(projects.map((p) => [p.name, p.id]))
  const projectIds = new Set(projects.map((p) => p.id))
  const envCache = new Map() // projectId -> Map(envName -> envId)

  async function resolveEnvId(projectId, envName) {
    if (!envCache.has(projectId)) {
      const r = await api('GET', `/api/environments?projectId=${encodeURIComponent(projectId)}`)
      const envs = Array.isArray(r.json?.data) ? r.json.data : []
      envCache.set(projectId, new Map(envs.map((e) => [e.name, e.id])))
    }
    return envCache.get(projectId).get(envName)
  }

  // 3. Per connection: connect (idempotent on label), resolve + bulk-create targets, optional preview/run.
  const allTargetIds = []
  for (const conn of config.connections) {
    say(`\n[connection] ${conn.provider} "${conn.label}"`)
    let connectionId
    const created = await api('POST', '/api/integrations/connections', { provider: conn.provider, label: conn.label, credential: conn.credential, config: conn.config ?? {} })
    if (created.status === 201) {
      connectionId = created.json?.data?.id
      say(`   connected (${connectionId})`)
    } else if (created.status === 409) {
      const list = await api('GET', '/api/integrations/connections')
      const existing = (list.json?.data ?? []).find((c) => c.provider === conn.provider && c.label === conn.label)
      connectionId = existing?.id
      say(`   reusing existing connection (${connectionId ?? 'NOT FOUND'})`)
    }
    if (!connectionId) { problems++; say(`   ERROR connect failed: HTTP ${created.status} ${created.json?.error ?? ''}`); continue }

    // Resolve each target's project/env to ids.
    const specs = []
    for (const t of conn.targets ?? []) {
      const projectId = projectIds.has(t.project) ? t.project : projectIdByName.get(t.project)
      if (!projectId) { problems++; say(`   ERROR target skipped: unknown project "${t.project}"`); continue }
      const envId = await resolveEnvId(projectId, t.env)
      if (!envId) { problems++; say(`   ERROR target skipped: unknown env "${t.env}" in project "${t.project}"`); continue }
      const autoSync = (t.onChange !== undefined || t.schedule !== undefined) ? { onChange: Boolean(t.onChange), scheduleMinutes: t.schedule ?? null } : undefined
      specs.push({ projectId, envId, connectionId, resource: t.resource, ...(t.nameFilter ? { nameFilter: t.nameFilter } : {}), deleteRemoved: Boolean(t.deleteRemoved), ...(autoSync ? { autoSync } : {}) })
    }
    if (specs.length === 0) { say('   no resolvable targets'); continue }

    let createdCount = 0, existingCount = 0
    for (const batch of chunk(specs, BULK_MAX)) {
      const r = await api('POST', '/api/integrations/targets/bulk', { targets: batch })
      if (r.status !== 200 || !r.json?.data) { problems++; say(`   ERROR bulk create: HTTP ${r.status} ${r.json?.error ?? ''}`); continue }
      const d = r.json.data
      createdCount += (d.created ?? []).length
      existingCount += (d.existing ?? []).length
      for (const tt of [...(d.created ?? []), ...(d.existing ?? [])]) allTargetIds.push(tt.id)
      for (const e of d.errors ?? []) { problems++; say(`   ERROR target[${e.index}] ${e.error}: ${e.message}`) }
    }
    say(`   targets: ${createdCount} created, ${existingCount} already existed`)
  }

  // 4. Optional preview / run of every target.
  if ((DO_RUN || DO_PREVIEW) && allTargetIds.length > 0) {
    say(`\n[${DO_RUN ? 'run' : 'preview'}] ${allTargetIds.length} targets`)
    for (const id of allTargetIds) {
      const r = await api('POST', `/api/integrations/targets/${id}/${DO_RUN ? 'run' : 'preview'}`)
      if (DO_RUN) {
        const d = r.json?.data
        const okStatus = r.status === 200 && (d?.status === 'succeeded' || d?.status === 'partial')
        if (!okStatus) problems++
        say(`   ${id}: ${r.status === 200 ? `${d?.status} ${JSON.stringify(d?.counts ?? {})}` : `HTTP ${r.status} ${r.json?.error ?? ''}`}`)
      } else {
        const p = r.json?.data
        say(`   ${id}: ${r.status === 200 ? `create ${p?.create?.length ?? 0}, update ${p?.update?.length ?? 0}, skip ${p?.skip?.length ?? 0}, conflict ${p?.conflict?.length ?? 0}, blockers ${(p?.blockers ?? []).map((b) => b.code).join('/') || 'none'}` : `HTTP ${r.status} ${r.json?.error ?? ''}`}`)
      }
    }
  }

  say(`\n==================== ${problems === 0 ? 'DONE' : `DONE WITH ${problems} PROBLEM(S)`} ====================`)
  process.exit(problems === 0 ? 0 : 1)
}

main().catch((e) => { console.error(`onboarding crashed: ${e?.message ?? e}`); process.exit(1) })
