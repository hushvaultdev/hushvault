// Sync engine (issue #40): pushes one environment's resolved secrets to a provider target, one way
// (HushVault -> target). Provider-agnostic: providers implement SyncProvider (sync-types.ts).
//
// Invariants
//  - Values exist only in memory inside planSync/runSync. They are never written to sync_items, sync_runs,
//    the audit log or logs, and never appear in a SyncPlanDto (names only). Planned ops carry the value in a
//    NON-enumerable property so a stray JSON.stringify / spread / console output cannot leak it.
//  - Only names listed in the ledger (sync_items = confirmed pushed by HushVault) are ever deleted on the
//    target, and only when the per-target toggle delete_removed is on (default off).
//  - A name already on the target that HushVault never wrote is a CONFLICT and is left untouched.
//  - Reserved bootstrap names (ENCRYPTION_MASTER_KEY, ENCRYPTION_KEY_V<n>, JWT_SECRET) are never pushed.
//  - Provider failures are mapped to a SyncErrorCode; provider error bodies are never stored.
//  - Fail closed: any resolution failure (e.g. a computed-secret error) aborts before a single provider call.
import type { SyncErrorCode, SyncNameFilter, SyncPlanDto, SyncRunDto, SyncRunStatus, SyncTargetDto, SyncTrigger } from '@hushvault/shared/integrations'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { readCredential } from '../lib/integration-credentials'
import { resolveEnvironment } from '../lib/resolve-environment'
import { writeAuditLog } from '../lib/security'
import { getProvider } from './provider'
import { isSyncProvider, type ProviderErrorCode, type SyncOp, type SyncProvider } from './sync-types'

// ---------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------

export const MAX_SYNC_ATTEMPTS = 5
export const RETRY_BASE_MS = 30_000
export const RETRY_CAP_MS = 15 * 60_000
export const SYNC_LEASE_MS = 5 * 60_000
export const LIST_TIMEOUT_MS = 15_000
export const PUSH_TIMEOUT_MS = 30_000

const FINGERPRINT_INFO = 'hushvault-sync-fp-v1'
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const RESERVED_NAME = /^(ENCRYPTION_MASTER_KEY|ENCRYPTION_KEY_V\d+|JWT_SECRET)$/i

const NON_RETRYABLE: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>(['PROVIDER_AUTH', 'PROVIDER_VALIDATION', 'TARGET_NOT_FOUND'])
const RETRYABLE: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>(['PROVIDER_RATE_LIMIT', 'PROVIDER_ERROR', 'TIMEOUT'])
// A provider response that means "stop hammering this target for the rest of the run".
const STOP_ON: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>(['PROVIDER_AUTH', 'TARGET_NOT_FOUND', 'PROVIDER_RATE_LIMIT', 'TIMEOUT'])
// When several item errors happen in one run, report the most actionable one.
const ERROR_PRIORITY: SyncErrorCode[] = ['PROVIDER_AUTH', 'TARGET_NOT_FOUND', 'PROVIDER_VALIDATION', 'PROVIDER_RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR']

export function isReservedSyncName(name: string): boolean {
  return RESERVED_NAME.test(name)
}

export function isRetryableSyncError(code: SyncErrorCode | null): boolean {
  return code !== null && RETRYABLE.has(code)
}

export class SyncEngineError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'PROVIDER_UNAVAILABLE' | 'BUSY') {
    super(code)
  }
}

const encoder = new TextEncoder()

function randomUnit(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000
}

// ---------------------------------------------------------------------------------------------
// Retry helper (the scheduler that acts on next_retry_at is M4; the engine only SETS it)
// ---------------------------------------------------------------------------------------------

/** Exponential backoff with jitter: 30s * 2^(attempt-1), capped at 15 min, then jittered into [50%, 100%]. */
export function computeRetryDelayMs(attempt: number, random: () => number = randomUnit): number {
  const exp = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp / 2 + random() * (exp / 2))
}

/** ISO time of the next attempt, or null when the error is not retryable or attempts are exhausted. */
export function computeNextRetryAt(code: SyncErrorCode | null, attempt: number, now: Date, random?: () => number): string | null {
  if (!isRetryableSyncError(code) || attempt >= MAX_SYNC_ATTEMPTS) return null
  return new Date(now.getTime() + computeRetryDelayMs(attempt, random)).toISOString()
}

// ---------------------------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------------------------

export function newFingerprintSalt(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function deriveFingerprintKey(env: Env, salt: string): Promise<CryptoKey> {
  const ikm = await crypto.subtle.importKey('raw', encoder.encode(env.JWT_SECRET), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(salt), info: encoder.encode(FINGERPRINT_INFO) },
    ikm,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign'],
  )
}

/**
 * HMAC-SHA256(key = HKDF-SHA256(JWT_SECRET, salt = target.fingerprint_salt, info = 'hushvault-sync-fp-v1'),
 * message = name + NUL + value), hex. A keyed MAC (never a plain hash) so the ledger cannot be used to
 * confirm a guessed value. Rotating JWT_SECRET changes every fingerprint, which only causes one extra
 * (idempotent) re-push per item on the next run.
 */
export async function computeFingerprint(env: Env, salt: string, name: string, value: string): Promise<string> {
  return fingerprintWith(await deriveFingerprintKey(env, salt), name, value)
}

async function fingerprintWith(key: CryptoKey, name: string, value: string): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${name}\u0000${value}`))
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ---------------------------------------------------------------------------------------------
// Targets and runs: row mapping
// ---------------------------------------------------------------------------------------------

export type SyncTargetRow = {
  id: string
  orgId: string
  projectId: string
  envId: string
  connectionId: string
  provider: string
  resource: Record<string, string>
  nameFilter: SyncNameFilter
  deleteRemoved: boolean
  fingerprintSalt: string
  status: 'active' | 'needs_attention'
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

type TargetDbRow = {
  id: string; org_id: string; project_id: string; env_id: string; connection_id: string; provider: string
  resource_json: string; name_filter_json: string; delete_removed: number; fingerprint_salt: string
  status: 'active' | 'needs_attention'; last_run_at: string | null; created_at: string; updated_at: string
}

type RunDbRow = {
  id: string; target_id: string; trigger: SyncTrigger; status: SyncRunStatus; attempt: number; counts_json: string
  error_code: SyncErrorCode | null; started_at: string; finished_at: string | null; next_retry_at: string | null
}

const TARGET_COLUMNS = 'id, org_id, project_id, env_id, connection_id, provider, resource_json, name_filter_json, delete_removed, fingerprint_salt, status, last_run_at, created_at, updated_at'
const RUN_COLUMNS = 'id, target_id, trigger, status, attempt, counts_json, error_code, started_at, finished_at, next_retry_at'

function parseJson<T>(text: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

function toTargetRow(row: TargetDbRow): SyncTargetRow {
  return {
    id: row.id,
    orgId: row.org_id,
    projectId: row.project_id,
    envId: row.env_id,
    connectionId: row.connection_id,
    provider: row.provider,
    resource: parseJson<Record<string, string>>(row.resource_json, {}),
    nameFilter: parseJson<SyncNameFilter>(row.name_filter_json, {}),
    deleteRemoved: row.delete_removed === 1,
    fingerprintSalt: row.fingerprint_salt,
    status: row.status,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Load a live (not soft-deleted) target. `orgId`, when given, must match the target's organisation. */
export async function loadSyncTarget(env: Env, targetId: string, orgId?: string): Promise<SyncTargetRow | null> {
  const row = await env.DB.prepare(`SELECT ${TARGET_COLUMNS} FROM sync_targets WHERE id = ? AND deleted_at IS NULL LIMIT 1`)
    .bind(targetId).first<TargetDbRow>()
  if (!row || (orgId !== undefined && row.org_id !== orgId)) return null
  return toTargetRow(row)
}

/** DTO for the API layer. lastRunStatus comes from the newest run. */
export async function toSyncTargetDto(env: Env, target: SyncTargetRow): Promise<SyncTargetDto> {
  const last = await env.DB.prepare('SELECT status FROM sync_runs WHERE target_id = ? ORDER BY started_at DESC, id DESC LIMIT 1')
    .bind(target.id).first<{ status: SyncRunStatus }>()
  return {
    id: target.id,
    projectId: target.projectId,
    envId: target.envId,
    connectionId: target.connectionId,
    provider: target.provider,
    resource: target.resource,
    nameFilter: target.nameFilter,
    deleteRemoved: target.deleteRemoved,
    status: target.status,
    lastRunAt: target.lastRunAt,
    lastRunStatus: last?.status ?? null,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  }
}

const ZERO_COUNTS: SyncRunDto['counts'] = { created: 0, updated: 0, deleted: 0, skipped: 0, failed: 0 }

export function toSyncRunDto(row: RunDbRow): SyncRunDto {
  return {
    id: row.id,
    targetId: row.target_id,
    trigger: row.trigger,
    status: row.status,
    attempt: row.attempt,
    counts: { ...ZERO_COUNTS, ...parseJson<Partial<SyncRunDto['counts']>>(row.counts_json, {}) },
    errorCode: row.error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextRetryAt: row.next_retry_at,
  }
}

/** Run lookup scoped to an organisation (joins through the target). */
export async function loadSyncRun(env: Env, orgId: string, runId: string): Promise<SyncRunDto | null> {
  const row = await env.DB.prepare(
    `SELECT ${RUN_COLUMNS.split(', ').map((c) => `r.${c}`).join(', ')} FROM sync_runs r INNER JOIN sync_targets t ON t.id = r.target_id WHERE r.id = ? AND t.org_id = ? LIMIT 1`,
  ).bind(runId, orgId).first<RunDbRow>()
  return row ? toSyncRunDto(row) : null
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

/** An op the engine will send. The value is non-enumerable: it never shows up in JSON or spreads. */
export type PlannedOp =
  | { type: 'set'; kind: 'create' | 'update'; name: string; fingerprint: string; readonly value: string }
  | { type: 'delete'; name: string }

function plannedSet(kind: 'create' | 'update', name: string, fingerprint: string, value: string): PlannedOp {
  const op = { type: 'set' as const, kind, name, fingerprint }
  Object.defineProperty(op, 'value', { value, enumerable: false })
  return op as PlannedOp
}

export type PlanResult =
  | {
    ok: true
    /** Names only. Safe to return from an endpoint. */
    plan: SyncPlanDto
    /** Internal: carries secret values (non-enumerable). Never serialise. */
    ops: PlannedOp[]
    /** Ledger rows to drop without a provider call (delete_removed on, name already gone from the target). */
    forget: string[]
    /** Names withheld because they are reserved bootstrap secrets (also listed under plan.skip). */
    reserved: string[]
  }
  | { ok: false; code: SyncErrorCode }

type ProviderCall<T> = { ok: true; value: T } | { ok: false; code: ProviderErrorCode }

/** Run one provider call under a hard timeout. Whatever it throws becomes a fixed code; messages are dropped. */
async function callProvider<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<ProviderCall<T>> {
  const signal = AbortSignal.timeout(ms)
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))))
  try {
    return { ok: true, value: await Promise.race([fn(signal), aborted]) }
  } catch {
    return { ok: false, code: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR' }
  }
}

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export type PlanOptions = { actorId?: string | null; actorType?: 'user' | 'system' }

/**
 * Build the plan for one target: resolve the environment (decrypting values), apply the name filter, drop
 * reserved names, validate against the provider's limits, list the target's names and classify every name.
 * Resolution failures fail closed before any provider call. Audits the bulk read (secret.read_bulk).
 */
export async function planSync(env: Env, target: SyncTargetRow, provider: SyncProvider, opts: PlanOptions = {}): Promise<PlanResult> {
  const resolved = await resolveEnvironment(env, target.orgId, target.envId, { values: true })
  // Any resolution failure (missing env, bad chain, decryption, computed error) fails the run closed. The shared
  // contract has no separate code for these, so all of them surface as COMPUTED_ERROR.
  if (!resolved.ok || resolved.projectId !== target.projectId) return { ok: false, code: 'COMPUTED_ERROR' }

  await writeAuditLog(env, {
    orgId: target.orgId,
    actorId: opts.actorId ?? null,
    actorType: opts.actorType ?? 'system',
    action: 'secret.read_bulk',
    resourceType: 'environment',
    resourceId: resolved.environmentId,
  })

  const { prefix, deny } = target.nameFilter
  const denied = new Set(deny ?? [])
  const wanted = new Map<string, string>()
  const reserved: string[] = []
  for (const secret of resolved.secrets) {
    if (prefix && !secret.name.startsWith(prefix)) continue
    if (denied.has(secret.name)) continue
    if (isReservedSyncName(secret.name)) {
      reserved.push(secret.name)
      continue
    }
    wanted.set(secret.name, secret.value ?? '')
  }

  // Blockers are checked before anything touches the provider.
  const limits = provider.limits
  const invalidNames: string[] = []
  const tooLarge: string[] = []
  for (const [name, value] of wanted) {
    if (!NAME_PATTERN.test(name) || name.length > limits.maxNameLength) invalidNames.push(name)
    else if (encoder.encode(value).byteLength > limits.maxValueBytes) tooLarge.push(name)
  }
  const wantedNames = sorted(wanted.keys())
  const blockers: SyncPlanDto['blockers'] = []
  if (wantedNames.length > limits.maxItems) blockers.push({ code: 'TOO_MANY_ITEMS', names: wantedNames.slice(limits.maxItems) })
  if (invalidNames.length) blockers.push({ code: 'NAME_INVALID', names: sorted(invalidNames) })
  if (tooLarge.length) blockers.push({ code: 'VALUE_TOO_LARGE', names: sorted(tooLarge) })
  const blocked = new Set(blockers.flatMap((b) => b.code === 'TOO_MANY_ITEMS' ? [] : b.names))

  const credential = await readCredential(env, target.orgId, target.connectionId)
  if (credential === null) return { ok: false, code: 'CREDENTIAL_UNAVAILABLE' }
  const connection = await env.DB.prepare('SELECT provider, config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1')
    .bind(target.connectionId, target.orgId).first<{ provider: string; config_json: string }>()
  if (!connection || connection.provider !== target.provider) return { ok: false, code: 'CREDENTIAL_UNAVAILABLE' }
  const config = parseJson<Record<string, unknown>>(connection.config_json, {})

  const listed = await callProvider(LIST_TIMEOUT_MS, (signal) => provider.listNames({ credential, config, resource: target.resource, signal }))
  if (!listed.ok) return { ok: false, code: listed.code }
  if (!listed.value.ok) return { ok: false, code: listed.value.code }
  const onTarget = new Set(listed.value.names)

  const ledgerRows = await env.DB.prepare('SELECT name, fingerprint FROM sync_items WHERE target_id = ?').bind(target.id).all<{ name: string; fingerprint: string }>()
  const ledger = new Map((ledgerRows.results ?? []).map((r) => [r.name, r.fingerprint]))

  const key = await deriveFingerprintKey(env, target.fingerprintSalt)
  const create: string[] = []
  const update: string[] = []
  const skip: string[] = [...reserved]
  const conflict: string[] = []
  const ops: PlannedOp[] = []

  for (const name of wantedNames) {
    if (blocked.has(name)) continue
    if (blockers.some((b) => b.code === 'TOO_MANY_ITEMS' && b.names.includes(name))) continue
    const value = wanted.get(name) ?? ''
    const fingerprint = await fingerprintWith(key, name, value)
    const known = ledger.get(name)
    if (known === undefined) {
      if (onTarget.has(name)) conflict.push(name) // exists, HushVault never wrote it: leave untouched
      else {
        create.push(name)
        ops.push(plannedSet('create', name, fingerprint, value))
      }
    } else if (!onTarget.has(name)) {
      // We pushed it before but it is gone from the target (manual deletion): heal by pushing again.
      create.push(name)
      ops.push(plannedSet('create', name, fingerprint, value))
    } else if (known !== fingerprint) {
      update.push(name)
      ops.push(plannedSet('update', name, fingerprint, value))
    } else {
      skip.push(name)
    }
  }

  const del: string[] = []
  const forget: string[] = []
  if (target.deleteRemoved) {
    for (const name of sorted(ledger.keys())) {
      if (wanted.has(name) || isReservedSyncName(name)) continue
      if (onTarget.has(name)) {
        del.push(name)
        ops.push({ type: 'delete', name })
      } else {
        forget.push(name)
      }
    }
  }

  return {
    ok: true,
    plan: { create: sorted(create), update: sorted(update), delete: del, skip: sorted(skip), conflict: sorted(conflict), blockers },
    ops,
    forget,
    reserved: sorted(reserved),
  }
}

/** Plan for the preview endpoint: names only. Throws SyncEngineError('NOT_FOUND') for a missing/foreign target. */
export async function previewSync(env: Env, orgId: string, targetId: string, opts: PlanOptions = {}): Promise<{ ok: true; plan: SyncPlanDto } | { ok: false; code: SyncErrorCode }> {
  const target = await loadSyncTarget(env, targetId, orgId)
  if (!target) throw new SyncEngineError('NOT_FOUND')
  const provider = getProvider(target.provider)
  if (!isSyncProvider(provider)) throw new SyncEngineError('PROVIDER_UNAVAILABLE')
  const planned = await planSync(env, target, provider, { actorType: 'user', ...opts })
  return planned.ok ? { ok: true, plan: planned.plan } : planned
}

// ---------------------------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------------------------

export type RunOptions = {
  trigger: SyncTrigger
  actorId?: string | null
  now?: Date
  /** 1-based attempt number; a scheduler (M4) passes the previous attempt + 1 when it retries. Default 1. */
  attempt?: number
  /** When set, the target must belong to this organisation (defence in depth for the API layer). */
  orgId?: string
}

type Outcome = { status: Exclude<SyncRunStatus, 'queued' | 'running'>; errorCode: SyncErrorCode | null }

const NON_RETRYABLE_STATUS_CODES = NON_RETRYABLE

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message)
}

async function writeRunAudit(env: Env, target: SyncTargetRow, runId: string, action: string, actorType: 'user' | 'system', actorId: string | null): Promise<void> {
  // Resource id only. A failed audit write must not change the run's outcome.
  try {
    await writeAuditLog(env, { orgId: target.orgId, actorId, actorType, action, resourceType: 'sync_run', resourceId: runId })
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'sync.audit_failed', action }))
  }
}

/**
 * Run one sync for a target. Single flight per target: if a run is already active (unexpired lease), that run
 * is returned and nothing else happens. Persists partial progress (ledger rows for confirmed items) so a retry
 * resumes. Never throws for provider failures: they become a failed/partial run with an error code.
 * Throws SyncEngineError for a missing target, an unavailable provider module, or a lost single-flight race.
 */
export async function runSync(env: Env, targetId: string, opts: RunOptions): Promise<SyncRunDto> {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const target = await loadSyncTarget(env, targetId, opts.orgId)
  if (!target) throw new SyncEngineError('NOT_FOUND')
  const provider = getProvider(target.provider)
  if (!isSyncProvider(provider)) throw new SyncEngineError('PROVIDER_UNAVAILABLE')

  const actorId = opts.actorId ?? null
  const actorType: 'user' | 'system' = opts.trigger === 'manual' && actorId ? 'user' : 'system'
  const attempt = Math.max(1, Math.min(opts.attempt ?? 1, MAX_SYNC_ATTEMPTS))
  const runId = createPrefixedId('isr')

  // Lease. A crashed worker leaves a 'running' row behind; once its lease expired it is closed as failed so
  // the unique index (one queued/running run per target) lets a new run in.
  await env.DB.prepare(
    "UPDATE sync_runs SET status = 'failed', error_code = 'TIMEOUT', finished_at = ?, lease_until = NULL WHERE target_id = ? AND status IN ('queued', 'running') AND lease_until IS NOT NULL AND lease_until < ?",
  ).bind(nowIso, target.id, nowIso).run()
  const leaseUntil = new Date(now.getTime() + SYNC_LEASE_MS).toISOString()
  try {
    await env.DB.prepare(
      "INSERT INTO sync_runs (id, target_id, trigger, status, attempt, counts_json, actor_id, started_at, lease_until) VALUES (?, ?, ?, 'running', ?, '{}', ?, ?, ?)",
    ).bind(runId, target.id, opts.trigger, attempt, actorId, nowIso, leaseUntil).run()
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    const active = await env.DB.prepare(`SELECT ${RUN_COLUMNS} FROM sync_runs WHERE target_id = ? AND status IN ('queued', 'running') LIMIT 1`)
      .bind(target.id).first<RunDbRow>()
    if (!active) throw new SyncEngineError('BUSY')
    return toSyncRunDto(active)
  }

  await writeRunAudit(env, target, runId, 'sync.run.started', actorType, actorId)

  const counts = { ...ZERO_COUNTS }
  let outcome: Outcome
  try {
    outcome = await execute(env, target, provider, runId, now, counts, { actorId, actorType })
  } catch {
    // Unexpected failure (never surface its message: it could carry anything).
    outcome = { status: 'failed', errorCode: 'PROVIDER_ERROR' }
  }

  const finishedAt = (opts.now ?? new Date()).toISOString()
  const nextRetryAt = outcome.status === 'succeeded' ? null : computeNextRetryAt(outcome.errorCode, attempt, now)
  const needsAttention = outcome.status !== 'succeeded' && outcome.errorCode !== null && NON_RETRYABLE_STATUS_CODES.has(outcome.errorCode)
  await env.DB.batch([
    env.DB.prepare('UPDATE sync_runs SET status = ?, counts_json = ?, error_code = ?, finished_at = ?, next_retry_at = ?, lease_until = NULL WHERE id = ?')
      .bind(outcome.status, JSON.stringify(counts), outcome.errorCode, finishedAt, nextRetryAt, runId),
    env.DB.prepare('UPDATE sync_targets SET last_run_at = ?, status = ?, updated_at = ? WHERE id = ?')
      .bind(finishedAt, outcome.status === 'succeeded' ? 'active' : needsAttention ? 'needs_attention' : target.status, finishedAt, target.id),
  ])
  await writeRunAudit(env, target, runId, outcome.status === 'succeeded' ? 'sync.run.succeeded' : 'sync.run.failed', actorType, actorId)

  return {
    id: runId,
    targetId: target.id,
    trigger: opts.trigger,
    status: outcome.status,
    attempt,
    counts,
    errorCode: outcome.errorCode,
    startedAt: nowIso,
    finishedAt,
    nextRetryAt,
  }
}

async function execute(
  env: Env,
  target: SyncTargetRow,
  provider: SyncProvider,
  runId: string,
  now: Date,
  counts: SyncRunDto['counts'],
  actor: { actorId: string | null; actorType: 'user' | 'system' },
): Promise<Outcome> {
  const planned = await planSync(env, target, provider, actor)
  if (!planned.ok) return { status: 'failed', errorCode: planned.code }

  const { plan, ops, forget } = planned
  counts.skipped = plan.skip.length + plan.conflict.length
  // Limits are validated before any write. The shared contract has no SYNC_BLOCKED run code, so a blocked run
  // is a non-retryable validation failure: it needs the owner to change the environment or the filter.
  if (plan.blockers.length > 0) return { status: 'failed', errorCode: 'PROVIDER_VALIDATION' }

  const credential = await readCredential(env, target.orgId, target.connectionId)
  if (credential === null) return { status: 'failed', errorCode: 'CREDENTIAL_UNAVAILABLE' }
  const connection = await env.DB.prepare('SELECT config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1')
    .bind(target.connectionId, target.orgId).first<{ config_json: string }>()
  const config = parseJson<Record<string, unknown>>(connection?.config_json ?? '{}', {})

  const errors = new Set<SyncErrorCode>()
  const pushedAt = now.toISOString()
  const chunkSize = Math.max(1, provider.limits.maxItems)
  // Sets first, deletes last, so a failure mid-way never removes something before its replacement landed.
  const ordered = [...ops.filter((o) => o.type === 'set'), ...ops.filter((o) => o.type === 'delete')]
  let okItems = 0
  let stopped = false

  for (let offset = 0; offset < ordered.length; offset += chunkSize) {
    const chunk = ordered.slice(offset, offset + chunkSize)
    if (stopped) {
      counts.failed += chunk.length
      continue
    }
    const syncOps: SyncOp[] = chunk.map((o) => (o.type === 'set' ? { type: 'set', name: o.name, value: o.value } : { type: 'delete', name: o.name }))
    const pushed = await callProvider(PUSH_TIMEOUT_MS, (signal) => provider.push({ credential, config, resource: target.resource, ops: syncOps, signal }))
    const result = pushed.ok ? pushed.value : { ok: false as const, code: pushed.code }
    if (!result.ok) {
      errors.add(result.code)
      counts.failed += chunk.length
      stopped = true
      continue
    }

    const byName = new Map(result.results.map((r) => [r.name, r]))
    const statements: D1PreparedStatement[] = []
    for (const op of chunk) {
      const item = byName.get(op.name)
      if (!item || !item.ok) {
        const code: ProviderErrorCode = item && !item.ok ? item.code : 'PROVIDER_ERROR'
        errors.add(code)
        counts.failed += 1
        if (STOP_ON.has(code)) stopped = true
        continue
      }
      okItems += 1
      if (op.type === 'set') {
        if (op.kind === 'create') counts.created += 1
        else counts.updated += 1
        statements.push(env.DB.prepare(
          'INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) VALUES (?, ?, ?, ?) ON CONFLICT (target_id, name) DO UPDATE SET fingerprint = excluded.fingerprint, last_pushed_at = excluded.last_pushed_at',
        ).bind(target.id, op.name, op.fingerprint, pushedAt))
      } else {
        counts.deleted += 1
        statements.push(env.DB.prepare('DELETE FROM sync_items WHERE target_id = ? AND name = ?').bind(target.id, op.name))
      }
    }
    // Progress is recorded per chunk (and the lease extended), so a crash or failure later keeps what landed.
    statements.push(env.DB.prepare('UPDATE sync_runs SET lease_until = ? WHERE id = ?').bind(new Date(now.getTime() + SYNC_LEASE_MS).toISOString(), runId))
    await env.DB.batch(statements)
  }

  if (forget.length > 0 && !stopped) {
    await env.DB.batch(forget.map((name) => env.DB.prepare('DELETE FROM sync_items WHERE target_id = ? AND name = ?').bind(target.id, name)))
  }

  if (errors.size === 0) return { status: 'succeeded', errorCode: null }
  const errorCode = ERROR_PRIORITY.find((c) => errors.has(c)) ?? 'PROVIDER_ERROR'
  return { status: okItems > 0 ? 'partial' : 'failed', errorCode }
}
