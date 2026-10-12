#!/usr/bin/env node
// Phase 4 (#44) live end-to-end drill for HushVault -> GitHub Actions repository secrets sync.
//
// WHAT IT PROVES, against the real deployed dev API + a real GitHub repository:
//   register -> project -> environment -> secrets -> connect (GitHub token) -> target
//   -> preview -> run (create) -> change a secret -> run (update)
//   -> delete a secret with deleteRemoved OFF (name stays) -> ON (name pruned)
//   -> a GitHub-invalid name surfaces a rename suggestion -> failure path (bad repo)
//   -> confirm every state against GitHub's Actions-secrets API (names are ground truth; values are never
//      readable back, by design — GitHub only exposes secret NAMES).
//
// SAFETY: it only ever creates/deletes the test names E2E_ALPHA / E2E_BETA / E2E_GAMMA (and reads the list).
// It never deletes any other secret in the repo. Use a throwaway repo anyway.
//
// WHY YOU RUN IT (not the agent): the agent's container blocks api-beta.hushvault.dev, and the GitHub token
// must stay on your machine.
//
// USAGE (from the repo root, on your machine):
//   export HV_API=https://api-beta.hushvault.dev     # dev API base, no trailing slash
//   export GH_TOKEN=<fine-grained PAT: repository "Secrets" read+write on the target repo>
//   export GH_OWNER=<repo owner, e.g. your username or org>
//   export GH_REPO=<throwaway repo name>
//   node scripts/phase4-github-e2e-drill.mjs
//
// Paste the whole TRANSCRIPT back into chat / issue #44. No secret values or tokens are printed — only secret
// names, counts, statuses and HTTP codes. On a clean pass, promote `github-actions` to beta and record this.

const HV_API = (process.env.HV_API || '').replace(/\/$/, '')
const GH_TOKEN = process.env.GH_TOKEN || ''
const GH_OWNER = process.env.GH_OWNER || ''
const GH_REPO = process.env.GH_REPO || ''
const GH_BASE = 'https://api.github.com'
const TEST_NAMES = ['E2E_ALPHA', 'E2E_BETA', 'E2E_GAMMA']

const missing = Object.entries({ HV_API, GH_TOKEN, GH_OWNER, GH_REPO }).filter(([, v]) => !v).map(([k]) => k)
if (missing.length) {
  console.error(`Missing env vars: ${missing.join(', ')}. See the header of this file.`)
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
      'x-hushvault-client': 'phase4-github-drill',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

async function gh(method, path) {
  const res = await fetch(`${GH_BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${GH_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'hushvault-phase4-drill' },
    signal: AbortSignal.timeout(60000),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

// Ground truth: the repo's Actions secret names (GitHub never returns values).
async function repoSecretNames() {
  const r = await gh('GET', `/repos/${GH_OWNER}/${GH_REPO}/actions/secrets?per_page=100`)
  if (r.status !== 200 || !Array.isArray(r.json?.secrets)) throw new Error(`GitHub list failed: HTTP ${r.status}`)
  return r.json.secrets.map((s) => s.name).sort()
}
const testNamesPresent = async () => (await repoSecretNames()).filter((n) => TEST_NAMES.includes(n))

// Delete ONLY our test names, so the drill starts clean and leaves nothing behind.
async function clearTestNames() {
  const present = await testNamesPresent()
  for (const name of present) await gh('DELETE', `/repos/${GH_OWNER}/${GH_REPO}/actions/secrets/${encodeURIComponent(name)}`)
  return present
}

const runCounts = (r) => `status=${r.json?.data?.status} code=${r.json?.data?.errorCode ?? 'none'} ${JSON.stringify(r.json?.data?.counts ?? {})}`
const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

async function main() {
  say('==================== HushVault Phase 4 GitHub live E2E drill ====================')
  say(`API: ${HV_API}   repo: ${GH_OWNER}/${GH_REPO}`)
  say(`run id: ${rnd}   at: ${new Date().toISOString()}`)

  step(0, 'Pre-flight: token lists the repo Actions secrets; clear our test names')
  try {
    const cleared = await clearTestNames()
    check('token lists + can delete repo Actions secrets', (await testNamesPresent()).length === 0, `cleared [${cleared.join(', ') || 'none'}]`)
  } catch (e) {
    check('token lists + can delete repo Actions secrets', false, String(e.message))
    return finish()
  }

  step(1, 'Register throwaway org + owner')
  const reg = await hv('POST', '/api/auth/register', { email: `e2e-gh-${rnd}@hushvault-e2e.test`, password: `E2e-pw-${rnd}-longenough`, organisationName: `E2E GH ${rnd}` })
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

  step(3, 'Seed three secrets (valid GitHub names) + one GitHub-invalid name')
  const seed = { E2E_ALPHA: 'alpha-1', E2E_BETA: 'beta-1', E2E_GAMMA: 'gamma-1' }
  const secretIds = {}
  for (const [name, value] of Object.entries(seed)) {
    const r = await hv('POST', '/api/secrets', { projectId, envId, name, value })
    secretIds[name] = r.json?.data?.id
    if (!check(`secret ${name} created`, r.status === 201 && Boolean(secretIds[name]), `HTTP ${r.status}`)) return finish()
  }
  // A name GitHub rejects (dash) to exercise the NAME_INVALID blocker + rename suggestion. It is filtered out of the
  // target below with a deny list so it never blocks the main run.
  const invalid = await hv('POST', '/api/secrets', { projectId, envId, name: 'bad-name', value: 'x' })
  check('invalid-name secret seeded', invalid.status === 201, `HTTP ${invalid.status}`)

  step(4, 'Create GitHub connection (token stored encrypted; verified)')
  const conn = await hv('POST', '/api/integrations/connections', { provider: 'github-actions', label: `e2e-${rnd}`, credential: GH_TOKEN, config: {} })
  const connectionId = conn.json?.data?.id
  if (!check('connection created + verified', conn.status === 201 && Boolean(connectionId), `HTTP ${conn.status} ${conn.json?.error ?? ''}`)) return finish()
  check('connection response carries NO credential', !JSON.stringify(conn.json).includes(GH_TOKEN))

  step(5, 'Create sync target (env -> repo), denying the invalid name')
  const tgt = await hv('POST', '/api/integrations/targets', { projectId, envId, connectionId, resource: { owner: GH_OWNER, repo: GH_REPO }, nameFilter: { deny: ['bad-name'] } })
  const targetId = tgt.json?.data?.id
  if (!check('target created', tgt.status === 201 && Boolean(targetId), `HTTP ${tgt.status} ${tgt.json?.error ?? ''}`)) return finish()

  step(6, 'Preview: 3 creates, nothing written')
  const prev = await hv('POST', `/api/integrations/targets/${targetId}/preview`)
  check('preview 200', prev.status === 200, `HTTP ${prev.status}`)
  check('preview plans 3 creates', (prev.json?.data?.create?.length ?? 0) === 3, `create=[${(prev.json?.data?.create ?? []).join(', ')}]`)
  check('preview wrote nothing yet (ground truth)', (await testNamesPresent()).length === 0)

  step(7, 'Run — push creates (values sealed with the repo public key)')
  const run1 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('run succeeded', run1.json?.data?.status === 'succeeded', runCounts(run1))
  check('run created 3', (run1.json?.data?.counts?.created ?? 0) === 3, runCounts(run1))
  check('repo now has the 3 secret names (ground truth)', sameSet(await testNamesPresent(), TEST_NAMES.slice().sort()))

  step(8, 'Change one value, run — update; name set unchanged')
  await hv('PATCH', `/api/secrets/${secretIds.E2E_ALPHA}`, { value: 'alpha-2' })
  const run2 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('update run succeeded', run2.json?.data?.status === 'succeeded', runCounts(run2))
  check('update run updated 1', (run2.json?.data?.counts?.updated ?? 0) === 1, runCounts(run2))

  step(9, 'Delete a secret in HushVault, run (deleteRemoved OFF): name stays')
  await hv('DELETE', `/api/secrets/${secretIds.E2E_GAMMA}`)
  const run3 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('run after delete succeeded', run3.json?.data?.status === 'succeeded', runCounts(run3))
  check('forgotten name NOT deleted (deleteRemoved off)', (await testNamesPresent()).includes('E2E_GAMMA'))

  step(10, 'Enable deleteRemoved, run — prune the removed name')
  await hv('PATCH', `/api/integrations/targets/${targetId}`, { deleteRemoved: true })
  const run4 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('prune run succeeded', run4.json?.data?.status === 'succeeded', runCounts(run4))
  check('prune run deleted 1', (run4.json?.data?.counts?.deleted ?? 0) === 1, runCounts(run4))
  const afterPrune = await testNamesPresent()
  check('E2E_GAMMA removed (ground truth)', !afterPrune.includes('E2E_GAMMA'), `[${afterPrune.join(', ')}]`)

  step(11, 'Rename suggestion: a GitHub-invalid name is a blocker with a suggested rename')
  const t2 = await hv('POST', '/api/integrations/targets', { projectId, envId, connectionId, resource: { owner: GH_OWNER, repo: GH_REPO }, nameFilter: { prefix: 'bad-' } })
  if (t2.status === 201) {
    const prev2 = await hv('POST', `/api/integrations/targets/${t2.json.data.id}/preview`)
    const nameInvalid = (prev2.json?.data?.blockers ?? []).find((b) => b.code === 'NAME_INVALID')
    say(`   INFO  blocker: ${JSON.stringify(nameInvalid ?? null)}`)
    check('bad-name is NAME_INVALID with suggestion bad-name -> BAD_NAME', nameInvalid?.suggestions?.['bad-name'] === 'BAD_NAME')
    await hv('DELETE', `/api/integrations/targets/${t2.json.data.id}`)
  } else {
    check('second target created for suggestion test', false, `HTTP ${t2.status}`)
  }

  step(12, 'Failure path — a nonexistent repo')
  const badTgt = await hv('POST', '/api/integrations/targets', { projectId, envId, connectionId, resource: { owner: GH_OWNER, repo: `no-such-repo-${rnd}` } })
  if (badTgt.status === 201) {
    const badRun = await hv('POST', `/api/integrations/targets/${badTgt.json.data.id}/run`)
    check('bad-repo run does not succeed', badRun.json?.data?.status !== 'succeeded' || badRun.status >= 400, `HTTP ${badRun.status} status=${badRun.json?.data?.status ?? badRun.json?.error} code=${badRun.json?.data?.errorCode ?? ''}`)
  } else {
    check('bad-repo target refused at create (also acceptable)', true, `HTTP ${badTgt.status}`)
  }

  step(13, 'Cleanup — remove our test names from the repo')
  const left = await clearTestNames()
  check('test names cleared', (await testNamesPresent()).length === 0, `removed [${left.join(', ') || 'none'}]`)

  finish()
}

main().catch((e) => { check('drill crashed', false, String(e?.message ?? e)); finish() })
