import { Command } from 'commander'
import chalk from 'chalk'
import { ApiError, friendlyError, SYNC_SCHEDULE_OPTIONS, type ApiClient, type SyncAutoSync, type SyncPlan, type SyncRun, type SyncTarget } from '../api.js'
import { loadClient } from '../lib/context.js'
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
const DASHBOARD_HINT = 'Connections and targets are set up in the dashboard (Integrations).'

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
  .command('auto')
  .description('Change automatic syncing for a target (needs an admin login)')
  .argument('<target>', 'Target id or provider:scriptName')
  .option('--on-change', 'Sync automatically when a secret changes (within about 1-2 minutes)')
  .option('--no-on-change', 'Turn off syncing on change')
  .option('--schedule <minutes>', 'Also reconcile on a schedule: 15, 60, 360, 1440 or off')
  .option('--json', 'Machine-readable output')
  .action((t: string, o: AutoOptions) => exec(o, (c, out) => syncAutoAction(c, t, o, out)))
