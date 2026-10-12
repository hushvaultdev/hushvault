import { Command } from 'commander'
import chalk from 'chalk'
import { ApiError, friendlyError, SYNC_SCHEDULE_OPTIONS, type ApiClient, type CreateTargetInput, type SyncAutoSync, type SyncPlan, type SyncRun, type SyncTarget } from '../api.js'
import { loadClient, loadProjectContext, pickEnvInput, resolveEnvironment } from '../lib/context.js'
import { prompt } from '../lib/prompt.js'

/**
 * `hushvault sync ...`: read and trigger one-way HushVault -> target syncs.
 * Output is names and counts only. Responses are re-built field by field, so even if the API
 * ever returned extra fields (values, credentials, provider bodies) they could not be printed.
 * Exit codes: 0 success, 1 failure, 2 blocked / needs attention.
 */

export const EXIT_OK = 0
export const EXIT_FAIL = 1
export const EXIT_BLOCKED = 2

const MAX_NAMES = 20
const DASHBOARD_HINT = 'Connections are set up in the dashboard (Integrations); targets can be added with `sync add`.'

export type Out = (line: string) => void

export interface SyncOptions {
  json?: boolean | undefined
  yes?: boolean | undefined
  /** Whether prompting is possible. Defaults to a TTY on stdin and stdout, and no --json. */
  interactive?: boolean | undefined
  confirm?: ((question: string) => Promise<boolean>) | undefined
}

/** Strip control characters from names that came over the wire. */
function safe(s: unknown): string {
  return String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 200)
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(safe) : []
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/** Human label for a target: `provider:scriptName` (or the first resource value). */
export function targetLabel(t: SyncTarget): string {
  const res = t.resource ?? {}
  const name = res['scriptName'] ?? res['name'] ?? Object.values(res)[0]
  return name ? `${safe(t.provider)}:${safe(name)}` : safe(t.provider)
}

interface TargetView {
  id: string
  label: string
  provider: string
  projectId: string
  envId: string
  status: string
  deleteRemoved: boolean
  autoSync: SyncAutoSync
  lastRunAt: string | null
  lastRunStatus: string | null
}

function viewAutoSync(a: unknown): SyncAutoSync {
  const o = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>
  const m = o['scheduleMinutes']
  return { onChange: o['onChange'] === true, scheduleMinutes: typeof m === 'number' && Number.isFinite(m) ? m : null }
}

export function scheduleText(minutes: number | null): string {
  if (minutes === null) return 'off'
  if (minutes === 60) return 'hourly'
  if (minutes === 1440) return 'daily'
  if (minutes % 60 === 0) return `every ${minutes / 60} hours`
  return `every ${minutes} minutes`
}

export function autoSyncText(a: SyncAutoSync): string {
  return `on change ${a.onChange ? 'on' : 'off'}, schedule ${scheduleText(a.scheduleMinutes)}`
}

function viewTarget(t: SyncTarget): TargetView {
  return {
    id: safe(t.id),
    label: targetLabel(t),
    provider: safe(t.provider),
    projectId: safe(t.projectId),
    envId: safe(t.envId),
    status: safe(t.status),
    deleteRemoved: t.deleteRemoved === true,
    autoSync: viewAutoSync(t.autoSync),
    lastRunAt: t.lastRunAt ? safe(t.lastRunAt) : null,
    lastRunStatus: t.lastRunStatus ? safe(t.lastRunStatus) : null,
  }
}

function viewPlan(p: unknown): SyncPlan {
  const o = (typeof p === 'object' && p !== null ? p : {}) as Record<string, unknown>
  const blockers = Array.isArray(o['blockers']) ? o['blockers'] : []
  return {
    create: strings(o['create']),
    update: strings(o['update']),
    delete: strings(o['delete']),
    skip: strings(o['skip']),
    conflict: strings(o['conflict']),
    blockers: blockers.map((b) => {
      const bo = (typeof b === 'object' && b !== null ? b : {}) as Record<string, unknown>
      return { code: safe(bo['code']), names: strings(bo['names']) }
    }),
  }
}

function viewRun(r: SyncRun): SyncRun {
  const c = (r.counts ?? {}) as Record<string, unknown>
  return {
    id: safe(r.id),
    targetId: safe(r.targetId),
    trigger: safe(r.trigger),
    status: safe(r.status) as SyncRun['status'],
    attempt: num(r.attempt),
    counts: { created: num(c['created']), updated: num(c['updated']), deleted: num(c['deleted']), skipped: num(c['skipped']), failed: num(c['failed']) },
    errorCode: r.errorCode ? safe(r.errorCode) : null,
    startedAt: safe(r.startedAt),
    finishedAt: r.finishedAt ? safe(r.finishedAt) : null,
    nextRetryAt: r.nextRetryAt ? safe(r.nextRetryAt) : null,
  }
}

/** Resolve an id, or a unique `provider:scriptName` label (case-insensitive), via GET /targets. */
export async function resolveTarget(client: ApiClient, input: string): Promise<SyncTarget> {
  const targets = await client.listTargets()
  const byId = targets.find((t) => t.id === input)
  if (byId) return byId
  const lower = input.toLowerCase()
  const matches = targets.filter((t) => targetLabel(t).toLowerCase() === lower)
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) {
    throw new Error(`Target "${safe(input)}" is ambiguous; use one of these ids: ${matches.map((t) => safe(t.id)).join(', ')}`)
  }
  const labels = targets.map(targetLabel).join(', ') || '(none)'
  throw new Error(`Sync target "${safe(input)}" not found. Known targets: ${labels}. ${DASHBOARD_HINT}`)
}

function listNames(label: string, names: string[], out: Out): void {
  if (names.length === 0) return
  const shown = names.slice(0, MAX_NAMES).join(', ')
  const more = names.length > MAX_NAMES ? ` (+${names.length - MAX_NAMES} more)` : ''
  out(`  ${label} (${names.length}): ${shown}${more}`)
}

export function printPlan(plan: SyncPlan, out: Out): void {
  out(
    `Plan: ${plan.create.length} create, ${plan.update.length} update, ${plan.delete.length} delete, ` +
      `${plan.skip.length} skip, ${plan.conflict.length} conflict`,
  )
  listNames('create', plan.create, out)
  listNames('update', plan.update, out)
  listNames('delete', plan.delete, out)
  listNames('conflict (exists on target, not created by HushVault; left untouched)', plan.conflict, out)
  for (const b of plan.blockers) listNames(`blocked: ${b.code}`, b.names, out)
  if (plan.blockers.length > 0 && plan.blockers.every((b) => b.names.length === 0)) {
    out(`  blocked: ${plan.blockers.map((b) => b.code).join(', ')}`)
  }
}

function printRun(run: SyncRun, out: Out): void {
  const c = run.counts
  out(`Run ${run.id}: ${run.status}${run.errorCode ? ` (${run.errorCode})` : ''}`)
  out(`  ${c.created} created, ${c.updated} updated, ${c.deleted} deleted, ${c.skipped} skipped, ${c.failed} failed`)
  if (run.nextRetryAt) out(`  next retry: ${run.nextRetryAt}`)
}

function runExit(run: SyncRun): number {
  return run.status === 'failed' || run.status === 'partial' ? EXIT_FAIL : EXIT_OK
}

const dump = (v: unknown, out: Out): void => out(JSON.stringify(v, null, 2))

export async function syncListAction(client: ApiClient, opts: SyncOptions, out: Out): Promise<number> {
  const targets = (await client.listTargets()).map(viewTarget)
  if (opts.json) {
    dump(targets, out)
  } else if (targets.length === 0) {
    out(`No sync targets. ${DASHBOARD_HINT}`)
  } else {
    for (const t of targets) {
      const last = t.lastRunStatus ? `last run ${t.lastRunStatus}${t.lastRunAt ? ` at ${t.lastRunAt}` : ''}` : 'never run'
      out(`${t.label}  ${t.id}  ${t.status}  ${last}${t.deleteRemoved ? '  deletes on' : ''}  auto-sync: ${autoSyncText(t.autoSync)}`)
    }
  }
  return targets.some((t) => t.status === 'needs_attention') ? EXIT_BLOCKED : EXIT_OK
}

export async function syncStatusAction(client: ApiClient, input: string, opts: SyncOptions, out: Out): Promise<number> {
  const target = await resolveTarget(client, input)
  const runs = (await client.listRuns(target.id)).map(viewRun)
  const view = viewTarget(target)
  const latest = runs[0]
  if (opts.json) {
    dump({ target: view, latestRun: latest ?? null }, out)
  } else {
    out(`${view.label}  ${view.id}`)
    out(`  status: ${view.status}${view.status === 'needs_attention' ? ' (in the dashboard, rotate the connection credential or edit the target, then run again)' : ''}`)
    out(`  auto-sync: ${autoSyncText(view.autoSync)}`)
    out(`  deletes on target: ${view.deleteRemoved ? 'on' : 'off'}`)
    if (latest) printRun(latest, out)
    else out('  no runs yet')
  }
  const bad = view.status === 'needs_attention' || latest?.status === 'failed' || latest?.status === 'partial'
  return bad ? EXIT_BLOCKED : EXIT_OK
}

export interface AutoOptions extends SyncOptions {
  onChange?: boolean | undefined
  schedule?: string | undefined
}

/** '15' | '60' | '360' | '1440' -> minutes, 'off' -> null. Throws on anything else. */
export function parseSchedule(input: string): number | null {
  const v = input.trim().toLowerCase()
  if (v === 'off') return null
  const n = Number(v)
  if ((SYNC_SCHEDULE_OPTIONS as readonly number[]).includes(n)) return n
  throw new Error(`Invalid --schedule "${safe(input)}". Use one of ${SYNC_SCHEDULE_OPTIONS.join(', ')} (minutes) or off.`)
}

export async function syncAutoAction(client: ApiClient, input: string, opts: AutoOptions, out: Out): Promise<number> {
  if (opts.onChange === undefined && opts.schedule === undefined) {
    throw new Error('Nothing to change. Pass --on-change or --no-on-change, and/or --schedule <15|60|360|1440|off>.')
  }
  const schedule = opts.schedule === undefined ? undefined : parseSchedule(opts.schedule)
  const target = await resolveTarget(client, input)
  const current = viewAutoSync(target.autoSync)
  const next: SyncAutoSync = {
    onChange: opts.onChange ?? current.onChange,
    scheduleMinutes: schedule === undefined ? current.scheduleMinutes : schedule,
  }
  const updated = viewTarget(await client.updateTargetAutoSync(target.id, next))
  if (opts.json) dump({ target: updated }, out)
  else out(`${updated.label}  auto-sync: ${autoSyncText(updated.autoSync)}`)
  return EXIT_OK
}

export async function syncPreviewAction(client: ApiClient, input: string, opts: SyncOptions, out: Out): Promise<number> {
  const target = await resolveTarget(client, input)
  const plan = viewPlan(await client.previewTarget(target.id))
  if (opts.json) dump({ target: targetLabel(target), plan }, out)
  else {
    out(`Preview for ${targetLabel(target)} (nothing was changed)`)
    printPlan(plan, out)
  }
  return plan.blockers.length > 0 ? EXIT_BLOCKED : EXIT_OK
}

export async function syncRunAction(client: ApiClient, input: string, opts: SyncOptions, out: Out): Promise<number> {
  const target = await resolveTarget(client, input)
  const label = targetLabel(target)
  const plan = viewPlan(await client.previewTarget(target.id))
  if (!opts.json) {
    out(`Sync ${label}`)
    printPlan(plan, out)
  }
  if (plan.blockers.length > 0) {
    if (opts.json) dump({ target: label, plan, run: null }, out)
    else out('Blocked: nothing was synced.')
    return EXIT_BLOCKED
  }
  if (plan.delete.length > 0 && !opts.yes) {
    const interactive = opts.interactive ?? (!opts.json && process.stdin.isTTY === true && process.stdout.isTTY === true)
    if (!interactive) {
      throw new Error(`This plan deletes ${plan.delete.length} name(s) on the target. Re-run with --yes to confirm (non-interactive mode).`)
    }
    const ask = opts.confirm ?? (async (q: string) => /^y(es)?$/i.test((await prompt(q)).trim()))
    if (!(await ask(`Delete ${plan.delete.length} name(s) on ${label}? [y/N] `))) {
      out('Cancelled: nothing was synced.')
      return EXIT_FAIL
    }
  }
  const run = viewRun(await client.runTarget(target.id))
  if (opts.json) dump({ target: label, plan, run }, out)
  else printRun(run, out)
  return runExit(run)
}

/** Print an error (stderr) and return the exit code. SYNC_BLOCKED is 2, everything else 1. */
export function reportSyncError(err: unknown, client: ApiClient | undefined, opts: SyncOptions, out: Out, errOut: Out): number {
  if (err instanceof ApiError) {
    if (err.status === 403 && (client?.usesApiKey === true || err.code === 'API_KEY_NOT_ALLOWED')) {
      errOut(chalk.red('✗ Sync management needs an interactive login, not an API key. Run `hushvault login` and unset HUSHVAULT_TOKEN.'))
      return EXIT_FAIL
    }
    if (err.status === 422 && err.code === 'SYNC_BLOCKED') {
      const plan = viewPlan(err.details)
      if (opts.json) dump({ plan, run: null }, out)
      else {
        errOut(chalk.red('✗ ' + friendlyError(err, 'Sync')))
        printPlan(plan, errOut)
      }
      return EXIT_BLOCKED
    }
  }
  errOut(chalk.red('✗ ' + friendlyError(err, 'Sync management')))
  return EXIT_FAIL
}

export interface AddOptions extends SyncOptions {
  connection?: string | undefined
  env?: string | undefined
  onChange?: boolean | undefined
  schedule?: string | undefined
  deleteRemoved?: boolean | undefined
  /** GitLab: treat the positional id as a group id (default: a project id). */
  gitlabGroup?: boolean | undefined
  /** GitLab: environment_scope for the variables (default `*`). */
  scope?: string | undefined
  /** GitLab: create the variables as masked / protected. */
  masked?: boolean | undefined
  protected?: boolean | undefined
}

/**
 * `hushvault sync add <script>`: create (idempotently) one sync target binding the current project's
 * environment to a provider resource. Uses the bulk endpoint for a single item, so re-running is safe —
 * an exact duplicate is reported as already existing, not an error. Connection setup (which carries the
 * provider credential) stays in the dashboard; this only maps an existing connection to an environment.
 */
export async function syncAddAction(script: string, opts: AddOptions, out: Out, errOut: Out): Promise<number> {
  if (!opts.connection) {
    errOut(chalk.red('✗ --connection <id> is required (run `hushvault sync list` or the dashboard to find it)'))
    return EXIT_FAIL
  }
  const ctx = await loadProjectContext()
  const env = await resolveEnvironment(ctx.client, ctx.config.projectId, pickEnvInput(opts.env, ctx.config))
  const connection = (await ctx.client.listConnections()).find((c) => c.id === opts.connection)
  if (!connection) {
    errOut(chalk.red(`✗ No connection ${safe(opts.connection)} in this organisation`))
    return EXIT_FAIL
  }
  // Build the provider resource from the positional id and the connection's provider.
  //  - Cloudflare Workers: keyed by (accountId, scriptName); the account must match the connection's, so take it
  //    from there rather than asking for it twice. <id> is the Worker script name.
  //  - GitLab: <id> is the numeric project id (or group id with --gitlab-group); optional scope and flags.
  const resource: Record<string, string | boolean> = {}
  if (connection.provider === 'cloudflare-workers') {
    resource['scriptName'] = script
    const accountId = connection.config['accountId']
    if (!accountId) {
      errOut(chalk.red('✗ The connection has no accountId configured'))
      return EXIT_FAIL
    }
    resource['accountId'] = accountId
  } else if (connection.provider === 'gitlab') {
    if (!/^[1-9][0-9]*$/.test(script)) {
      errOut(chalk.red('✗ For GitLab, the positional argument must be the numeric project id (or group id with --gitlab-group)'))
      return EXIT_FAIL
    }
    resource[opts.gitlabGroup ? 'groupId' : 'projectId'] = script
    if (opts.scope) resource['environmentScope'] = opts.scope
    if (opts.masked) resource['masked'] = true
    if (opts.protected) resource['protected'] = true
  } else {
    resource['scriptName'] = script
  }
  let autoSync: SyncAutoSync | undefined
  if (opts.onChange !== undefined || opts.schedule !== undefined) {
    autoSync = { onChange: opts.onChange ?? false, scheduleMinutes: opts.schedule !== undefined ? parseSchedule(opts.schedule) : null }
  }
  const spec: CreateTargetInput = { projectId: ctx.config.projectId, envId: env.id, connectionId: connection.id, resource, deleteRemoved: opts.deleteRemoved ?? false, ...(autoSync ? { autoSync } : {}) }
  const result = await ctx.client.bulkCreateTargets([spec])
  if (opts.json) {
    out(JSON.stringify(result))
  } else if (result.created.length > 0) {
    out(chalk.green(`✓ Created sync target ${targetLabel(result.created[0]!)} (${result.created[0]!.id})`))
  } else if (result.existing.length > 0) {
    out(chalk.gray(`• Already exists: ${targetLabel(result.existing[0]!)} (${result.existing[0]!.id})`))
  } else {
    const err = result.errors[0]
    errOut(chalk.red(`✗ ${safe(err?.error)}: ${safe(err?.message)}`))
    return EXIT_FAIL
  }
  return EXIT_OK
}

async function exec(
  opts: SyncOptions,
  fn: (client: ApiClient, out: Out) => Promise<number>,
): Promise<void> {
  const out: Out = (l) => console.log(l)
  const errOut: Out = (l) => console.error(l)
  let client: ApiClient | undefined
  let code: number
  try {
    client = await loadClient()
    code = await fn(client, out)
  } catch (err) {
    code = reportSyncError(err, client, opts, out, errOut)
  }
  process.exit(code)
}

export const syncCommand = new Command('sync')
  .description(`Inspect and run syncs to external targets (names and counts only). ${DASHBOARD_HINT}`)
  .addHelpText('after', '\nExit codes: 0 success, 1 failure, 2 blocked / needs attention.\nRequires an interactive login (not HUSHVAULT_TOKEN with an API key).')

syncCommand
  .command('list')
  .description('List sync targets')
  .option('--json', 'Machine-readable output')
  .action((o: SyncOptions) => exec(o, (c, out) => syncListAction(c, o, out)))

syncCommand
  .command('status')
  .description('Show a target and its latest run')
  .argument('<target>', 'Target id or provider:scriptName')
  .option('--json', 'Machine-readable output')
  .action((t: string, o: SyncOptions) => exec(o, (c, out) => syncStatusAction(c, t, o, out)))

syncCommand
  .command('preview')
  .description('Show what a run would create, update and delete (changes nothing)')
  .argument('<target>', 'Target id or provider:scriptName')
  .option('--json', 'Machine-readable output')
  .action((t: string, o: SyncOptions) => exec(o, (c, out) => syncPreviewAction(c, t, o, out)))

syncCommand
  .command('run')
  .description('Run a sync now. Prints the plan first; deletes need confirmation or --yes')
  .argument('<target>', 'Target id or provider:scriptName')
  .option('--json', 'Machine-readable output')
  .option('-y, --yes', 'Confirm deletes without prompting (required when non-interactive)')
  .action((t: string, o: SyncOptions) => exec(o, (c, out) => syncRunAction(c, t, o, out)))

syncCommand
  .command('add')
  .description('Create (idempotently) a sync target: map this project\'s environment to a connection\'s resource')
  .argument('<resource>', 'Cloudflare Workers: the Worker script name. GitLab: the numeric project id (or group id with --gitlab-group)')
  .requiredOption('--connection <id>', 'Connection id (set up in the dashboard; see `sync list`)')
  .option('--env <env>', 'Environment slug or id (defaults to the project\'s default)')
  .option('--gitlab-group', 'GitLab only: the id is a group id, not a project id')
  .option('--scope <scope>', 'GitLab only: environment_scope for the variables (default *)')
  .option('--masked', 'GitLab only: create the variables as masked')
  .option('--protected', 'GitLab only: create the variables as protected')
  .option('--on-change', 'Sync automatically when a secret changes')
  .option('--schedule <minutes>', 'Also reconcile on a schedule: 15, 60, 360, 1440 or off')
  .option('--delete-removed', 'Delete names on the target when removed from the environment')
  .option('--json', 'Machine-readable output')
  .action(async (script: string, o: AddOptions) => {
    const out: Out = (l) => console.log(l)
    const errOut: Out = (l) => console.error(l)
    let code: number
    try {
      code = await syncAddAction(script, o, out, errOut)
    } catch (err) {
      code = reportSyncError(err, undefined, o, out, errOut)
    }
    process.exit(code)
  })

syncCommand
  .command('auto')
  .description('Change automatic syncing for a target (needs an admin login)')
  .argument('<target>', 'Target id or provider:scriptName')
  .option('--on-change', 'Sync automatically when a secret changes (within about 1-2 minutes)')
  .option('--no-on-change', 'Turn off syncing on change')
  .option('--schedule <minutes>', 'Also reconcile on a schedule: 15, 60, 360, 1440 or off')
  .option('--json', 'Machine-readable output')
  .action((t: string, o: AutoOptions) => exec(o, (c, out) => syncAutoAction(c, t, o, out)))
