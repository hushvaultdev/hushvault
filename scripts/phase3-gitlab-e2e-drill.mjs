#!/usr/bin/env node
// Phase 3 (#99) live end-to-end drill for HushVault -> GitLab CI/CD variables sync.
//
// WHAT IT PROVES, against the real deployed dev API + a real gitlab.com project:
//   register -> project -> environment -> secrets -> connect (GitLab token) -> target
//   -> preview -> run (create) -> change a secret -> run (update)
//   -> delete a secret with deleteRemoved OFF (name stays) -> ON (name pruned)
//   -> masked variable (valid + invalid value) -> failure path (bad project id)
//   -> confirm every state against GitLab's own variables API (ground truth).
//
// It reads the project's real variable *keys* (scoped to the drill's environment_scope)
// straight from GitLab between steps, so every HushVault push is checked against ground
// truth, not just the API's own run status. It is the live check the GitLab provider's
// unit tests (mocked fetch) cannot be: it will expose any real-API mismatch, including
// GitLab's actual masked-value rules.
//
// WHY YOU RUN IT (not the agent): the agent's container blocks api-beta.hushvault.dev,
// and the GitLab token must stay on your machine.
//
// USAGE (from the repo root, on your machine):
//   export HV_API=https://api-beta.hushvault.dev     # dev API base, no trailing slash
//   export GL_TOKEN=<project or group access token: Maintainer role, api scope>
//   export GL_PROJECT_ID=<numeric project id of a THROWAWAY gitlab.com project>
//   export GL_SCOPE=e2e                              # a dedicated environment_scope (NOT '*')
//   node scripts/phase3-gitlab-e2e-drill.mjs
//
// Only variables in GL_SCOPE on that project are touched; using a dedicated scope (not '*')
// keeps the project's real variables untouched. Nothing else is destructive beyond that
// scope's variables and a brand-new throwaway HushVault org.
//
// Paste the whole TRANSCRIPT block it prints back into the chat / issue #99. No secret
// values or tokens are printed — only keys, counts, statuses and HTTP codes. When it passes,
// promote `gitlab` to `beta` in packages/shared/src/integrations.ts and record this transcript.

const HV_API = (process.env.HV_API || '').replace(/\/$/, '')
const GL_TOKEN = process.env.GL_TOKEN || ''
const GL_PROJECT_ID = process.env.GL_PROJECT_ID || ''
const GL_SCOPE = process.env.GL_SCOPE || 'e2e'
const GL_BASE = 'https://gitlab.com/api/v4'

const missing = Object.entries({ HV_API, GL_TOKEN, GL_PROJECT_ID }).filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. See the header of this file.`)
  process.exit(1)
}
if (!/^[1-9][0-9]*$/.test(GL_PROJECT_ID)) {
  console.error('GL_PROJECT_ID must be the numeric project id (not the group/project path).')
  process.exit(1)
}
if (GL_SCOPE === '*') {
  console.error('Refusing to run against environment_scope "*": set GL_SCOPE to a dedicated scope like "e2e".')
  process.exit(1)
}

const log = []
const say = (line) => { console.log(line); log.push(line) }
const step = (n, title) => say(`\n[${n}] ${title}`)
let pass = 0, fail = 0
const check = (label, ok, detail = '') => {
  if (ok) { pass++; say(`   PASS  ${label}${detail ? ' — ' + detail : ''}`) }
  else { fail++; say(`   FAIL  ${label}${detail ? ' — ' + detail : ''}`) }
  return ok
}
const finish = () => {
  say(`\n==================== ${fail === 0 ? 'ALL PASS' : 'FAILURES'} : ${pass} passed, ${fail} failed ====================`)
  process.exit(fail === 0 ? 0 : 1)
}

const rnd = Math.random().toString(36).slice(2, 8)
let jwt = ''

async function hv(method, path, body) {
  const res = await fetch(`${HV_API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      'x-hushvault-client': 'phase3-gitlab-drill',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function gl(method, path, body) {
  const res = await fetch(`${GL_BASE}${path}`, {
    method,
    headers: { 'PRIVATE-TOKEN': GL_TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json, headers: res.headers }
}

const scopeQ = `filter%5Benvironment_scope%5D=${encodeURIComponent(GL_SCOPE)}`

// Ground truth: all variables on the project (paging), then only those in GL_SCOPE.
async function glVarsInScope() {
  const out = []
  for (let page = 1; page <= 50; page++) {
    const r = await gl('GET', `/projects/${GL_PROJECT_ID}/variables?per_page=100&page=${page}`)
    if (r.status !== 200 || !Array.isArray(r.json)) throw new Error(`GitLab list failed: HTTP ${r.status}`)
    for (const v of r.json) if (v && v.environment_scope === GL_SCOPE) out.push({ key: v.key, masked: v.masked === true, raw: v.raw })
    const next = r.headers.get('x-next-page')
    if (!next) break
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
const keysInScope = async () => (await glVarsInScope()).map((v) => v.key)

// Reset the drill scope to empty so pre-existing keys can't be misread as conflicts.
async function resetScope() {
  const keys = await keysInScope()
  for (const key of keys) await gl('DELETE', `/projects/${GL_PROJECT_ID}/variables/${encodeURIComponent(key)}?${scopeQ}`)
  return keys
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const runCounts = (r) => `status=${r.json?.data?.status} code=${r.json?.data?.errorCode ?? 'none'} ${JSON.stringify(r.json?.data?.counts ?? {})}`

async function main() {
  say('==================== HushVault Phase 3 GitLab live E2E drill ====================')
  say(`API: ${HV_API}   project: ${GL_PROJECT_ID}   scope: ${GL_SCOPE}`)
  say(`run id: ${rnd}   at: ${new Date().toISOString()}`)

  step(0, 'Pre-flight: the token reads + clears the drill scope')
  let before
  try {
    const cleared = await resetScope()
    before = await keysInScope()
    check('token lists + clears project variables in the scope', before.length === 0, `cleared [${cleared.join(', ') || 'none'}], now [${before.join(', ') || 'empty'}]`)
  } catch (e) {
    check('token lists + clears project variables in the scope', false, String(e.message))
    return finish()
  }

  step(1, 'Register throwaway org + owner')
  const reg = await hv('POST', '/api/auth/register', { email: `e2e-gl-${rnd}@hushvault-e2e.test`, password: `E2e-pw-${rnd}-longenough`, organisationName: `E2E GL ${rnd}` })
  if (!check('register 201', reg.status === 201, `HTTP ${reg.status}`)) return finish()
  jwt = reg.json?.data?.token
  check('got owner JWT', Boolean(jwt))

  step(2, 'Create project + environment')
  const proj = await hv('POST', '/api/projects', { name: `proj-${rnd}` })
  const projectId = proj.json?.data?.id ?? proj.json?.data?.project?.id
  if (!check('project created', proj.status === 201 && Boolean(projectId), `HTTP ${proj.status}`)) return finish()
  const envRes = await hv('POST', '/api/environments', { projectId, name: 'production' })
  const envId = envRes.json?.data?.id ?? envRes.json?.data?.environment?.id
  if (!check('environment created', envRes.status === 201 && Boolean(envId), `HTTP ${envRes.status}`)) return finish()

  step(3, 'Seed three secrets (valid GitLab keys)')
  const seed = { E2E_ALPHA: 'alpha-1', E2E_BETA: 'beta-1', E2E_GAMMA: 'gamma-1' }
  const secretIds = {}
  for (const [name, value] of Object.entries(seed)) {
    const r = await hv('POST', '/api/secrets', { projectId, envId, name, value })
    secretIds[name] = r.json?.data?.id
    if (!check(`secret ${name} created`, r.status === 201 && Boolean(secretIds[name]), `HTTP ${r.status}`)) return finish()
  }

  step(4, 'Create GitLab connection (token stored encrypted; verified)')
  const conn = await hv('POST', '/api/integrations/connections', { provider: 'gitlab', label: `e2e-${rnd}`, credential: GL_TOKEN, config: {} })
  const connectionId = conn.json?.data?.id
  if (!check('connection created + verified', conn.status === 201 && Boolean(connectionId), `HTTP ${conn.status} ${conn.json?.error ?? ''}`)) return finish()
  check('connection response carries NO credential', !JSON.stringify(conn.json).includes(GL_TOKEN))

  step(5, 'Create sync target (env -> project, scoped)')
  const tgt = await hv('POST', '/api/integrations/targets', { projectId, envId, connectionId, resource: { projectId: GL_PROJECT_ID, environmentScope: GL_SCOPE } })
  const targetId = tgt.json?.data?.id
  if (!check('target created', tgt.status === 201 && Boolean(targetId), `HTTP ${tgt.status} ${tgt.json?.error ?? ''}`)) return finish()

  step(6, 'Preview (dry run): 3 creates, nothing written')
  const prev = await hv('POST', `/api/integrations/targets/${targetId}/preview`)
  const plan = prev.json?.data
  check('preview 200', prev.status === 200, `HTTP ${prev.status}`)
  check('preview plans 3 creates', (plan?.create?.length ?? 0) === 3, `create=[${(plan?.create ?? []).join(', ')}]`)
  check('preview wrote nothing yet (ground truth)', sameSet(await keysInScope(), before))

  step(7, 'Run — push creates')
  const run1 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('run succeeded', run1.json?.data?.status === 'succeeded', runCounts(run1))
  check('run created 3', (run1.json?.data?.counts?.created ?? 0) === 3, runCounts(run1))
  const expect = ['E2E_ALPHA', 'E2E_BETA', 'E2E_GAMMA'].sort()
  check('project scope now has exactly the 3 keys (ground truth)', sameSet(await keysInScope(), expect))
  const alpha = (await glVarsInScope()).find((v) => v.key === 'E2E_ALPHA')
  check('pushed variable has raw=true (no $-expansion)', alpha?.raw === true, `raw=${alpha?.raw}`)

  step(8, 'Change one value, run — update; key set unchanged')
  await hv('PATCH', `/api/secrets/${secretIds.E2E_ALPHA}`, { value: 'alpha-2' })
  const run2 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('update run succeeded', run2.json?.data?.status === 'succeeded', runCounts(run2))
  check('update run updated 1', (run2.json?.data?.counts?.updated ?? 0) === 1, runCounts(run2))
  check('key set unchanged after update', sameSet(await keysInScope(), expect))

  step(9, 'Delete a secret in HushVault, run (deleteRemoved OFF): key stays')
  await hv('DELETE', `/api/secrets/${secretIds.E2E_GAMMA}`)
  const run3 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('run after delete succeeded', run3.json?.data?.status === 'succeeded', runCounts(run3))
  check('forgotten key NOT deleted (deleteRemoved off)', (await keysInScope()).includes('E2E_GAMMA'))

  step(10, 'Enable deleteRemoved, run — prune the removed key')
  await hv('PATCH', `/api/integrations/targets/${targetId}`, { deleteRemoved: true })
  const run4 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('prune run succeeded', run4.json?.data?.status === 'succeeded', runCounts(run4))
  check('prune run deleted 1', (run4.json?.data?.counts?.deleted ?? 0) === 1, runCounts(run4))
  const afterPrune = await keysInScope()
  check('E2E_GAMMA removed (ground truth)', !afterPrune.includes('E2E_GAMMA'), `[${afterPrune.join(', ')}]`)
  check('E2E_ALPHA + E2E_BETA still present', afterPrune.includes('E2E_ALPHA') && afterPrune.includes('E2E_BETA'))

  step(11, 'Masked variable: a masked target in a separate scope')
  const maskedScope = `${GL_SCOPE}-masked`
  // A GitLab-valid masked value (single line, >=8 chars, base64-ish). The invalid one has a space.
  const sMaskOk = await hv('POST', '/api/secrets', { projectId, envId, name: 'E2E_MASK_OK', value: 'Masked12345678' })
  const sMaskBad = await hv('POST', '/api/secrets', { projectId, envId, name: 'E2E_MASK_BAD', value: 'has a space' })
  const mtgt = await hv('POST', '/api/integrations/targets', {
    projectId, envId, connectionId,
    resource: { projectId: GL_PROJECT_ID, environmentScope: maskedScope, masked: true },
    nameFilter: { prefix: 'E2E_MASK_' },
  })
  if (sMaskOk.status === 201 && sMaskBad.status === 201 && mtgt.status === 201) {
    const mrun = await hv('POST', `/api/integrations/targets/${mtgt.json.data.id}/run`)
    say(`   INFO  masked run: ${runCounts(mrun)} (plan may report the invalid value as a blocker)`)
    const r = await gl('GET', `/projects/${GL_PROJECT_ID}/variables?per_page=100`)
    const inMasked = Array.isArray(r.json) ? r.json.filter((v) => v.environment_scope === maskedScope) : []
    const okVar = inMasked.find((v) => v.key === 'E2E_MASK_OK')
    check('masked-valid value landed with masked=true', okVar?.masked === true, `found=${Boolean(okVar)} masked=${okVar?.masked}`)
    say(`   INFO  masked scope keys on GitLab: [${inMasked.map((v) => v.key).join(', ')}] (E2E_MASK_BAD expected absent if GitLab rejected it)`)
    // Cleanup masked scope.
    for (const v of inMasked) await gl('DELETE', `/projects/${GL_PROJECT_ID}/variables/${encodeURIComponent(v.key)}?filter%5Benvironment_scope%5D=${encodeURIComponent(maskedScope)}`)
  } else {
    check('masked sub-test set up', false, `secretOk=${sMaskOk.status} secretBad=${sMaskBad.status} target=${mtgt.status}`)
  }

  step(12, 'Failure path — target a nonexistent project id')
  const badTgt = await hv('POST', '/api/integrations/targets', { projectId, envId, connectionId, resource: { projectId: '999999999', environmentScope: GL_SCOPE } })
  if (badTgt.status === 201) {
    const badRun = await hv('POST', `/api/integrations/targets/${badTgt.json.data.id}/run`)
    check('bad-project run does not succeed', badRun.json?.data?.status !== 'succeeded' || badRun.status >= 400, `HTTP ${badRun.status} status=${badRun.json?.data?.status ?? badRun.json?.error} code=${badRun.json?.data?.errorCode ?? ''}`)
  } else {
    check('bad-project target refused at create (also acceptable)', true, `HTTP ${badTgt.status}`)
  }

  step(13, 'Cleanup — clear the drill scope')
  const leftover = await resetScope()
  check('drill scope cleared', (await keysInScope()).length === 0, `removed [${leftover.join(', ') || 'none'}]`)

  finish()
}

main().catch((e) => { check('drill crashed', false, String(e?.message ?? e)); finish() })
