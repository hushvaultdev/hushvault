#!/usr/bin/env node
// Phase 1 (#41) live end-to-end drill for HushVault Cloudflare Workers sync.
//
// WHAT IT PROVES, against the real deployed dev API + a real Cloudflare Worker:
//   register -> project -> environment -> secrets -> connect (CF token) -> target
//   -> preview -> run (create) -> change a secret -> run (update) -> delete a secret
//   -> run (delete on target) -> failure path (bad resource) -> confirm on the Worker.
//
// It reads the Worker's actual secret *names* straight from the Cloudflare API between
// steps, so every HushVault push is verified against ground truth, not just the API's
// own run status.
//
// WHY YOU RUN IT (not the agent): the agent's container network policy blocks
// api-beta.hushvault.dev, and the Cloudflare token must stay on your machine.
//
// USAGE (from the repo root, on your machine):
//   export HV_API=https://api-beta.hushvault.dev          # dev API base, no trailing slash
//   export CF_API_TOKEN=<token: Workers Scripts:Edit, scoped to ONE account>
//   export CF_ACCOUNT_ID=<the account id that token is scoped to>
//   export CF_SCRIPT=hv-e2e-sync-target                   # a throwaway Worker that already exists
//   node scripts/phase1-e2e-drill.mjs
//
// The Worker named in CF_SCRIPT must already be deployed (it only needs a trivial
// fetch handler). Nothing here is destructive beyond that throwaway Worker's own
// secrets and a brand-new throwaway HushVault org.
//
// Paste the whole TRANSCRIPT block it prints back into the chat / issue #41.
// No secret values or tokens are printed — only names, counts, statuses, HTTP codes.

const HV_API = (process.env.HV_API || '').replace(/\/$/, '')
const CF_API_TOKEN = process.env.CF_API_TOKEN || ''
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID || ''
const CF_SCRIPT = process.env.CF_SCRIPT || 'hv-e2e-sync-target'
const CF_BASE = 'https://api.cloudflare.com/client/v4'

const missing = Object.entries({ HV_API, CF_API_TOKEN, CF_ACCOUNT_ID, CF_SCRIPT })
  .filter(([, v]) => !v).map(([k]) => k)
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

const rnd = Math.random().toString(36).slice(2, 8)
let jwt = ''

async function hv(method, path, body) {
  const res = await fetch(`${HV_API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
      'x-hushvault-client': 'phase1-drill',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  })
  let json = null
  try { json = await res.json() } catch {}
  return { status: res.status, json }
}

// Ground truth: the Worker's real secret names, read straight from Cloudflare.
async function workerSecretNames() {
  const res = await fetch(`${CF_BASE}/accounts/${CF_ACCOUNT_ID}/workers/scripts/${CF_SCRIPT}/secrets`, {
    headers: { authorization: `Bearer ${CF_API_TOKEN}` },
    signal: AbortSignal.timeout(30000),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok || !json?.success) throw new Error(`CF secrets list failed: HTTP ${res.status} ${JSON.stringify(json?.errors ?? [])}`)
  return (json.result ?? []).map((s) => s.name).sort()
}

const sameSet = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

// Reset the throwaway Worker to zero secrets so pre-existing names can't be misread as conflicts.
async function resetWorkerSecrets() {
  const names = await workerSecretNames()
  if (names.length === 0) return []
  const secrets = Object.fromEntries(names.map((n) => [n, null]))
  const res = await fetch(`${CF_BASE}/accounts/${CF_ACCOUNT_ID}/workers/scripts/${CF_SCRIPT}/secrets-bulk`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${CF_API_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ secrets }),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) throw new Error(`reset failed: HTTP ${res.status}`)
  return names
}

const runCounts = (r) => `status=${r.json?.data?.status} code=${r.json?.data?.errorCode ?? 'none'} ${JSON.stringify(r.json?.data?.counts ?? {})}`

async function main() {
  say('==================== HushVault Phase 1 live E2E drill ====================')
  say(`API: ${HV_API}   Worker: ${CF_SCRIPT}   account: ${CF_ACCOUNT_ID.slice(0, 6)}…`)
  say(`run id: ${rnd}   at: ${new Date().toISOString()}`)

  // Pre-flight: the Cloudflare token can read AND reset the Worker's secrets, so the drill starts
  // from a known-empty state (otherwise pre-existing names are correctly treated as conflicts and
  // mask the create path).
  step(0, 'Pre-flight: read + reset the target Worker to zero secrets')
  let before
  try {
    const cleared = await resetWorkerSecrets()
    before = await workerSecretNames()
    check('CF token reads + resets Worker secrets', before.length === 0, `cleared [${cleared.join(', ') || 'none'}], now [${before.join(', ') || 'empty'}]`)
  } catch (e) {
    check('CF token reads + resets Worker secrets', false, String(e.message))
    return finish()
  }

  // 1. Register a throwaway org (owner JWT).
  step(1, 'Register throwaway org + owner')
  const email = `e2e-${rnd}@hushvault-e2e.test`
  const reg = await hv('POST', '/api/auth/register', {
    email, password: `E2e-pw-${rnd}-longenough`, organisationName: `E2E ${rnd}`,
  })
  if (!check('register 201', reg.status === 201, `HTTP ${reg.status}`)) return finish()
  jwt = reg.json?.data?.token
  check('got owner JWT', Boolean(jwt))

  // 2. Project + environment.
  step(2, 'Create project + environment')
  const proj = await hv('POST', '/api/projects', { name: `proj-${rnd}` })
  const projectId = proj.json?.data?.id ?? proj.json?.data?.project?.id
  if (!check('project created', proj.status === 201 && Boolean(projectId), `HTTP ${proj.status} id=${projectId}`)) return finish()
  const envRes = await hv('POST', '/api/environments', { projectId, name: 'production' })
  const envId = envRes.json?.data?.id ?? envRes.json?.data?.environment?.id
  if (!check('environment created', envRes.status === 201 && Boolean(envId), `HTTP ${envRes.status} id=${envId}`)) return finish()

  // 3. Seed secrets. Names chosen to avoid any reserved-name skip (see sync-engine RESERVED_NAME).
  step(3, 'Seed three secrets in the environment')
  const seed = { E2E_ALPHA: 'alpha-1', E2E_BETA: 'beta-1', E2E_GAMMA: 'gamma-1' }
  const secretIds = {}
  for (const [name, value] of Object.entries(seed)) {
    const r = await hv('POST', '/api/secrets', { projectId, envId, name, value })
    secretIds[name] = r.json?.data?.id
    if (!check(`secret ${name} created`, r.status === 201 && Boolean(secretIds[name]), `HTTP ${r.status} id=${secretIds[name]}`)) return finish()
  }

  // 4. Connect the Cloudflare account (stores the token encrypted; returns metadata only).
  step(4, 'Create Cloudflare connection (token stored encrypted)')
  const conn = await hv('POST', '/api/integrations/connections', {
    provider: 'cloudflare-workers', label: `e2e-${rnd}`, credential: CF_API_TOKEN,
    config: { accountId: CF_ACCOUNT_ID },
  })
  const connectionId = conn.json?.data?.id
  if (!check('connection created + verified', conn.status === 201 && Boolean(connectionId), `HTTP ${conn.status} ${conn.json?.error ?? ''}`)) return finish()
  check('connection response carries NO credential', !JSON.stringify(conn.json).toLowerCase().includes(CF_API_TOKEN.toLowerCase()))

  // 5. Target binding env -> Worker.
  step(5, 'Create sync target (env -> Worker)')
  const tgt = await hv('POST', '/api/integrations/targets', {
    projectId, envId, connectionId, resource: { accountId: CF_ACCOUNT_ID, scriptName: CF_SCRIPT },
  })
  const targetId = tgt.json?.data?.id
  if (!check('target created', tgt.status === 201 && Boolean(targetId), `HTTP ${tgt.status} ${tgt.json?.error ?? ''}`)) return finish()

  // 6. Preview: should plan to CREATE the three names, touch nothing yet.
  step(6, 'Preview (dry run)')
  const prev = await hv('POST', `/api/integrations/targets/${targetId}/preview`)
  const plan = prev.json?.data
  check('preview 200', prev.status === 200, `HTTP ${prev.status}`)
  check('preview plans 3 creates', (plan?.create?.length ?? 0) === 3, `create=[${(plan?.create ?? []).join(', ')}]`)
  check('preview wrote nothing to the Worker yet', sameSet(await workerSecretNames(), before))

  // 7. Run: push creates.
  step(7, 'Run — push creates')
  const run1 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('run 200', run1.status === 200, `HTTP ${run1.status} ${runCounts(run1)}`)
  check('run status succeeded', run1.json?.data?.status === 'succeeded', runCounts(run1))
  check('run created 3', (run1.json?.data?.counts?.created ?? 0) === 3, runCounts(run1))
  const afterCreate = await workerSecretNames()
  const expectCreate = ['E2E_ALPHA', 'E2E_BETA', 'E2E_GAMMA'].sort()
  check('Worker now has exactly the 3 pushed names (ground truth)', sameSet(afterCreate, expectCreate), `[${afterCreate.join(', ')}]`)

  // 8. Change a value, run again: update, name set unchanged.
  step(8, 'Change one secret value, run — push update')
  const upd = await hv('PATCH', `/api/secrets/${secretIds.E2E_ALPHA}`, { value: 'alpha-2' })
  check('secret value updated', upd.status === 200, `HTTP ${upd.status}`)
  const run2 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('update run succeeded', run2.json?.data?.status === 'succeeded', runCounts(run2))
  check('update run updated 1', (run2.json?.data?.counts?.updated ?? 0) === 1, runCounts(run2))
  check('Worker name set unchanged after update', sameSet(await workerSecretNames(), expectCreate))

  // 9. Delete a secret in HushVault, run: with deleteRemoved default off, the name should remain.
  step(9, 'Delete a secret in HushVault, run (deleteRemoved OFF by default)')
  const del = await hv('DELETE', `/api/secrets/${secretIds.E2E_GAMMA}`)
  check('secret deleted in HushVault', del.status === 200 || del.status === 204, `HTTP ${del.status}`)
  const run3 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('run after delete succeeded', run3.json?.data?.status === 'succeeded', runCounts(run3))
  const afterForget = await workerSecretNames()
  check('forgotten name is NOT deleted on Worker (deleteRemoved off)', afterForget.includes('E2E_GAMMA'), `[${afterForget.join(', ')}]`)

  // 10. Turn deleteRemoved on, run: now the name should be pruned.
  step(10, 'Enable deleteRemoved, run — prune the removed name')
  const patch = await hv('PATCH', `/api/integrations/targets/${targetId}`, { deleteRemoved: true })
  check('target patched deleteRemoved=true', patch.status === 200, `HTTP ${patch.status}`)
  const run4 = await hv('POST', `/api/integrations/targets/${targetId}/run`)
  check('prune run succeeded', run4.json?.data?.status === 'succeeded', runCounts(run4))
  check('prune run deleted 1', (run4.json?.data?.counts?.deleted ?? 0) === 1, runCounts(run4))
  const afterPrune = await workerSecretNames()
  check('E2E_GAMMA now removed from Worker (ground truth)', !afterPrune.includes('E2E_GAMMA'), `[${afterPrune.join(', ')}]`)
  check('E2E_ALPHA + E2E_BETA still present', afterPrune.includes('E2E_ALPHA') && afterPrune.includes('E2E_BETA'))

  // 11. Failure path: point a new target at a nonexistent Worker, run should fail cleanly.
  step(11, 'Failure path — target a nonexistent Worker')
  const badTgt = await hv('POST', '/api/integrations/targets', {
    projectId, envId, connectionId,
    resource: { accountId: CF_ACCOUNT_ID, scriptName: `does-not-exist-${rnd}` },
  })
  if (badTgt.status === 201) {
    const badRun = await hv('POST', `/api/integrations/targets/${badTgt.json.data.id}/run`)
    check('bad-worker run does not succeed', badRun.json?.data?.status !== 'succeeded', `status=${badRun.json?.data?.status} code=${badRun.json?.data?.errorCode}`)
  } else {
    check('bad-worker target refused at create (also acceptable)', true, `HTTP ${badTgt.status}`)
  }

  finish()
}

function finish() {
  say(`\n==================== RESULT: ${pass} passed, ${fail} failed ====================`)
  say('Paste everything from the first ==== line to here into issue #41.')
  process.exit(fail > 0 ? 1 : 0)
}

main().catch((e) => { say(`\nDRILL CRASHED: ${e.stack || e.message}`); finish() })
