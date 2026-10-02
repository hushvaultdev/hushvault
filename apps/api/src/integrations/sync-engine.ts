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
//  - Reserved names (ENCRYPTION_*, JWT_SECRET, OAuth client secrets, Stripe keys: every secret-typed Env key) are
//    never pushed. Names that could corrupt a request body (__proto__, constructor, prototype) are blockers.
//  - Intent first: before a chunk is sent, its 'set' names get a 'pending' ledger row. If the response is lost the
//    pending row marks the name as OURS, so the next plan updates it instead of reporting a conflict forever.
//  - The sync denylist (scripts and Cloudflare account ids) is enforced here as well as in the routes.
//  - Provider failures are mapped to a SyncErrorCode; provider error bodies are never stored.
//  - Fail closed: any resolution failure (e.g. a computed-secret error) aborts before a single provider call.
import type { SyncAutoSync, SyncErrorCode, SyncNameFilter, SyncPlanDto, SyncRunDto, SyncRunStatus, SyncTargetDto, SyncTrigger } from '@hushvault/shared/integrations'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { readCredential } from '../lib/integration-credentials'
import { resolveEnvironment } from '../lib/resolve-environment'
import { writeAuditLog } from '../lib/security'
import { getProvider } from './provider'
import { isSyncProvider, type FailureInfo, type ProviderErrorCode, type SyncOp, type SyncProvider } from './sync-types'
import { isTargetDenied } from './target-denylist'

// ---------------------------------------------------------------------------------------------
// Constants and small helpers
// ---------------------------------------------------------------------------------------------

export const MAX_SYNC_ATTEMPTS = 5
export const RETRY_BASE_MS = 30_000
export const RETRY_CAP_MS = 15 * 60_000
/** A provider rate limit blocks the token for minutes (Cloudflare: 5), so a retry may not come sooner than this. */
export const RATE_LIMIT_MIN_WAIT_MS = 5 * 60_000
export const SYNC_LEASE_MS = 5 * 60_000
export const LIST_TIMEOUT_MS = 15_000
export const PUSH_TIMEOUT_MS = 30_000
/** Ledger fingerprint of a name whose push was started but not confirmed. Never a valid 64-hex fingerprint. */
export const PENDING_FINGERPRINT = 'pending'

const FINGERPRINT_INFO = 'hushvault-sync-fp-v1'
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
// Every secret-typed key of Env (src/index.ts): ENCRYPTION_* (master key, key ring, active version), JWT_SECRET,
// the OAuth client secrets and the Stripe keys.
const RESERVED_NAME = /^(ENCRYPTION_[A-Z0-9_]*|JWT_SECRET|GITHUB_CLIENT_SECRET|GOOGLE_CLIENT_SECRET|STRIPE_SECRET_KEY|STRIPE_WEBHOOK_SECRET)$/i
// Names that are special on a JS object. They match NAME_PATTERN but must never become a request body key.
const UNSAFE_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype'])

const NON_RETRYABLE: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>(['PROVIDER_AUTH', 'PROVIDER_VALIDATION', 'TARGET_NOT_FOUND'])
const RETRYABLE: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>(['PROVIDER_RATE_LIMIT', 'PROVIDER_ERROR', 'TIMEOUT'])
// Failures that need a person to act: the target is flagged needs_attention and nothing retries by itself.
const NEEDS_ATTENTION: ReadonlySet<SyncErrorCode> = new Set<SyncErrorCode>([
  ...NON_RETRYABLE, 'COMPUTED_ERROR', 'CREDENTIAL_UNAVAILABLE', 'DECRYPTION_FAILED', 'TARGET_NOT_ALLOWED',
])
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

/**
 * ISO time of the next attempt, or null when the error is not retryable or attempts are exhausted. A rate limit
 * never retries sooner than RATE_LIMIT_MIN_WAIT_MS, or the provider's Retry-After when that is longer.
 */
export function computeNextRetryAt(code: SyncErrorCode | null, attempt: number, now: Date, random?: () => number, retryAfterSeconds?: number): string | null {
  if (!isRetryableSyncError(code) || attempt >= MAX_SYNC_ATTEMPTS) return null
  let delay = computeRetryDelayMs(attempt, random)
  if (code === 'PROVIDER_RATE_LIMIT') delay = Math.max(delay, RATE_LIMIT_MIN_WAIT_MS, Math.max(0, retryAfterSeconds ?? 0) * 1000)
  return new Date(now.getTime() + delay).toISOString()
}

/** Retry time when ANY of the run's errors is retryable (not just the highest-priority one). */
export function computeNextRetryAtForErrors(errors: ReadonlySet<SyncErrorCode>, attempt: number, now: Date, random?: () => number, retryAfterSeconds?: number): string | null {
  const code = (['PROVIDER_RATE_LIMIT', 'TIMEOUT', 'PROVIDER_ERROR'] as const).find((c) => errors.has(c)) ?? null
  return computeNextRetryAt(code, attempt, now, random, retryAfterSeconds)
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
  /** The stored resource_json: ledger writes are guarded on it so a run cannot write after the resource changed. */
  resourceJson: string
  nameFilter: SyncNameFilter
  deleteRemoved: boolean
  autoSync: SyncAutoSync
  fingerprintSalt: string
  status: 'active' | 'needs_attention'
  lastRunAt: string | null
  createdAt: string
  updatedAt: string
}

type TargetDbRow = {
  id: string; org_id: string; project_id: string; env_id: string; connection_id: string; provider: string
  resource_json: string; name_filter_json: string; delete_removed: number; sync_on_change: number; schedule_minutes: number | null; fingerprint_salt: string
  status: 'active' | 'needs_attention'; last_run_at: string | null; created_at: string; updated_at: string
}

type RunDbRow = {
  id: string; target_id: string; trigger: SyncTrigger; status: SyncRunStatus; attempt: number; counts_json: string
  error_code: SyncErrorCode | null; started_at: string; finished_at: string | null; next_retry_at: string | null
}

const TARGET_COLUMNS = 'id, org_id, project_id, env_id, connection_id, provider, resource_json, name_filter_json, delete_removed, sync_on_change, schedule_minutes, fingerprint_salt, status, last_run_at, created_at, updated_at'
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
    resourceJson: row.resource_json,
    nameFilter: parseJson<SyncNameFilter>(row.name_filter_json, {}),
    deleteRemoved: row.delete_removed === 1,
    autoSync: { onChange: row.sync_on_change === 1, scheduleMinutes: row.schedule_minutes },
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
    autoSync: target.autoSync,
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
    /** Ledger rows to drop without a provider call (name already gone from the target, or no longer synced). */
    forget: string[]
    /** Names withheld because they are reserved secrets (also listed under plan.skip). */
    reserved: string[]
  }
  | ({ ok: false; code: SyncErrorCode } & Pick<FailureInfo, 'retryAfterSeconds'>)

type ProviderCall<T> = { ok: true; value: T } | { ok: false; code: ProviderErrorCode; maybeApplied: true; retryAfterSeconds?: undefined }

/**
 * Run one provider call under a hard timeout. Whatever it throws becomes a fixed code; messages are dropped.
 * A call that threw or timed out may still have been applied by the provider, hence maybeApplied.
 */
async function callProvider<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<ProviderCall<T>> {
  const signal = AbortSignal.timeout(ms)
  const aborted = new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('timeout'))))
  try {
    return { ok: true, value: await Promise.race([fn(signal), aborted]) }
  } catch {
    return { ok: false, code: signal.aborted ? 'TIMEOUT' : 'PROVIDER_ERROR', maybeApplied: true }
  }
}

function sorted(names: Iterable<string>): string[] {
  return [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

export type PlanOptions = { actorId?: string | null; actorType?: 'user' | 'system'; ip?: string | null; userAgent?: string | null }

/**
 * Build the plan for one target: enforce the sync denylist, resolve the environment (decrypting values), apply the
 * name filter, drop reserved names, validate against the provider's limits, list the target's names and classify
 * every name. Resolution failures fail closed before any provider call. Audits the bulk read (secret.read_bulk);
 * a failed audit write is logged (event name only) and does not fail the plan.
 */
export async function planSync(env: Env, target: SyncTargetRow, provider: SyncProvider, opts: PlanOptions = {}): Promise<PlanResult> {
  if (isTargetDenied(env, target.resource)) return { ok: false, code: 'TARGET_NOT_ALLOWED' }

  const resolved = await resolveEnvironment(env, target.orgId, target.envId, { values: true })
  // Decryption failure and every other resolution failure (missing env, bad chain, computed error) fail the run
  // closed, with distinct codes so the owner knows whether to look at keys or at the environment.
  if (!resolved.ok) return { ok: false, code: resolved.code === 'DECRYPTION_FAILED' ? 'DECRYPTION_FAILED' : 'COMPUTED_ERROR' }
  if (resolved.projectId !== target.projectId) return { ok: false, code: 'COMPUTED_ERROR' }

  try {
    await writeAuditLog(env, {
      orgId: target.orgId,
      actorId: opts.actorId ?? null,
      actorType: opts.actorType ?? 'system',
      action: 'secret.read_bulk',
      resourceType: 'environment',
      resourceId: resolved.environmentId,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
    })
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'sync.audit_failed', action: 'secret.read_bulk' }))
  }

  const { prefix, deny } = target.nameFilter
  const denied = new Set(deny ?? [])
  const envNames = new Set<string>()
  const wanted = new Map<string, string>()
  const reserved: string[] = []
  for (const secret of resolved.secrets) {
    envNames.add(secret.name)
    if (prefix && !secret.name.startsWith(prefix)) continue
    if (denied.has(secret.name)) continue
    if (isReservedSyncName(secret.name)) {
      reserved.push(secret.name)
      continue
    }
    wanted.set(secret.name, secret.value ?? '')
  }

  // Per-name blockers are checked before anything touches the provider.
  const limits = provider.limits
  const invalidNames: string[] = []
  const tooLarge: string[] = []
  const emptyValues: string[] = []
  for (const [name, value] of wanted) {
    if (UNSAFE_NAMES.has(name.toLowerCase()) || !NAME_PATTERN.test(name) || name.length > limits.maxNameLength) invalidNames.push(name)
    else if (value === '') emptyValues.push(name) // whether the provider accepts an empty value is unverified: do not guess
    else if (encoder.encode(value).byteLength > limits.maxValueBytes) tooLarge.push(name)
  }
  const wantedNames = sorted(wanted.keys())
  const blockers: SyncPlanDto['blockers'] = []
  if (invalidNames.length) blockers.push({ code: 'NAME_INVALID', names: sorted(invalidNames) })
  if (emptyValues.length) blockers.push({ code: 'EMPTY_VALUE', names: sorted(emptyValues) })
  if (tooLarge.length) blockers.push({ code: 'VALUE_TOO_LARGE', names: sorted(tooLarge) })
  const blocked = new Set([...invalidNames, ...emptyValues, ...tooLarge])

  const connection = await env.DB.prepare('SELECT provider, config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1')
    .bind(target.connectionId, target.orgId).first<{ provider: string; config_json: string }>()
  if (!connection || connection.provider !== target.provider) return { ok: false, code: 'CREDENTIAL_UNAVAILABLE' }
  const config = parseJson<Record<string, unknown>>(connection.config_json, {})
  if (isTargetDenied(env, target.resource, config)) return { ok: false, code: 'TARGET_NOT_ALLOWED' }
  const credential = await readCredential(env, target.orgId, target.connectionId)
  if (credential === null) return { ok: false, code: 'CREDENTIAL_UNAVAILABLE' }

  const listed = await callProvider(LIST_TIMEOUT_MS, (signal) => provider.listNames({ credential, config, resource: target.resource, signal }))
  if (!listed.ok) return { ok: false, code: listed.code }
  if (!listed.value.ok) {
    const failure = listed.value
    return { ok: false, code: failure.code, ...(failure.retryAfterSeconds !== undefined ? { retryAfterSeconds: failure.retryAfterSeconds } : {}) }
  }
  const onTarget = new Set(listed.value.names)

  const ledgerRows = await env.DB.prepare('SELECT name, fingerprint FROM sync_items WHERE target_id = ?').bind(target.id).all<{ name: string; fingerprint: string }>()
  const ledger = new Map((ledgerRows.results ?? []).map((r) => [r.name, r.fingerprint]))

  // Deletes first (only counted against capacity, never sent before the sets).
  const del: string[] = []
  const forget: string[] = []
  if (target.deleteRemoved) {
    for (const name of sorted(ledger.keys())) {
      if (wanted.has(name) || isReservedSyncName(name)) continue
      if (envNames.has(name)) {
        // Still in the environment, only outside the name filter now (prefix / deny changed): stop managing it,
        // never delete it on the target. Deleting is for names removed from the environment.
        forget.push(name)
      } else if (onTarget.has(name)) {
        del.push(name)
      } else {
        forget.push(name)
      }
    }
  }

  // Capacity: what the target will hold = names already there + names we would add - names we delete. Counting only
  // our own names would let foreign secrets push the Worker over its variable cap mid-run.
  const candidates = wantedNames.filter((n) => !onTarget.has(n))
  const projected = new Set([...onTarget, ...wantedNames]).size - del.length
  const overCapacity = new Set<string>()
  if (candidates.length > 0 && projected > limits.maxItems) {
    const overflow = Math.min(projected - limits.maxItems, candidates.length)
    for (const name of candidates.slice(candidates.length - overflow)) overCapacity.add(name)
    blockers.push({ code: 'TOO_MANY_ITEMS', names: sorted(overCapacity) })
  }

  const key = await deriveFingerprintKey(env, target.fingerprintSalt)
  const create: string[] = []
  const update: string[] = []
  const skip: string[] = [...reserved]
  const conflict: string[] = []
  const ops: PlannedOp[] = []

  for (const name of wantedNames) {
    if (blocked.has(name) || overCapacity.has(name)) continue
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
      // Includes PENDING_FINGERPRINT: an earlier push of this name has an unknown outcome, so it is ours and is
      // rewritten rather than reported as a conflict.
      update.push(name)
      ops.push(plannedSet('update', name, fingerprint, value))
    } else {
      skip.push(name)
    }
  }
  for (const name of del) ops.push({ type: 'delete', name })

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
  return planned.ok ? { ok: true, plan: planned.plan } : { ok: false, code: planned.code }
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
  /** Request metadata for the audit rows (the sync.run.* and secret.read_bulk entries). */
  ip?: string | null
  userAgent?: string | null
  /**
   * When true, a plan with blockers is returned as `{ blocked: plan }` from runSync's single plan and no run row is
   * kept. Default false: the run is recorded as failed (PROVIDER_VALIDATION), which is what a scheduler wants.
   */
  returnBlocked?: boolean
}

export type RunBlocked = { blocked: SyncPlanDto }

type Outcome = {
  status: Exclude<SyncRunStatus, 'queued' | 'running'>
  errorCode: SyncErrorCode | null
  /** Every distinct error seen in the run (errorCode is only the most actionable one). */
  errors: ReadonlySet<SyncErrorCode>
  retryAfterSeconds?: number
}

function failedOutcome(code: SyncErrorCode, retryAfterSeconds?: number): Outcome {
  return { status: 'failed', errorCode: code, errors: new Set([code]), ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}) }
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE/i.test(err.message)
}

async function writeRunAudit(env: Env, target: SyncTargetRow, runId: string, action: string, actorType: 'user' | 'system', actorId: string | null, opts: { ip?: string | null; userAgent?: string | null }): Promise<void> {
  // Resource id only. A failed audit write must not change the run's outcome.
  try {
    await writeAuditLog(env, { orgId: target.orgId, actorId, actorType, action, resourceType: 'sync_run', resourceId: runId, ip: opts.ip ?? null, userAgent: opts.userAgent ?? null })
  } catch {
    console.error(JSON.stringify({ level: 'error', event: 'sync.audit_failed', action }))
  }
}

/**
 * Run one sync for a target. Single flight per target: if a run is already active (unexpired lease), that run
 * is returned before anything is planned. Records intent before each push and the confirmed result after it, so a
 * lost response or a crash never leaves names on the target that the ledger does not know about. Never throws for
 * provider failures: they become a failed/partial run with an error code.
 * Throws SyncEngineError for a missing target, an unavailable provider module, or a lost single-flight race.
 */
export async function runSync(env: Env, targetId: string, opts: RunOptions & { returnBlocked: true }): Promise<SyncRunDto | RunBlocked>
export async function runSync(env: Env, targetId: string, opts: RunOptions): Promise<SyncRunDto>
export async function runSync(env: Env, targetId: string, opts: RunOptions): Promise<SyncRunDto | RunBlocked> {
  const now = opts.now ?? new Date()
  const nowIso = now.toISOString()
  const wallStart = Date.now()
  /** Run time elapsed in REAL time (Date.now), so leases and finish times stay honest when `now` is injected. */
  const clock = (): Date => new Date(now.getTime() + (Date.now() - wallStart))
  const target = await loadSyncTarget(env, targetId, opts.orgId)
  if (!target) throw new SyncEngineError('NOT_FOUND')
  const provider = getProvider(target.provider)
  if (!isSyncProvider(provider)) throw new SyncEngineError('PROVIDER_UNAVAILABLE')

  const actorId = opts.actorId ?? null
  const actorType: 'user' | 'system' = opts.trigger === 'manual' && actorId ? 'user' : 'system'
  const attempt = Math.max(1, Math.min(opts.attempt ?? 1, MAX_SYNC_ATTEMPTS))
  const runId = createPrefixedId('isr')
  const meta = { ip: opts.ip ?? null, userAgent: opts.userAgent ?? null }

  // Lease. A crashed worker leaves a 'running' row behind; once its lease expired it is closed as failed so
  // the unique index (one queued/running run per target) lets a new run in. The active-run check happens here,
  // before any planning (and so before any decryption or provider call).
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

  const counts = { ...ZERO_COUNTS }
  let planned: PlanResult | null = null
  let outcome: Outcome | null = null
  try {
    planned = await planSync(env, target, provider, { actorId, actorType, ...meta })
  } catch {
    // Unexpected failure (never surface its message: it could carry anything).
    outcome = failedOutcome('PROVIDER_ERROR')
  }

  if (planned?.ok && planned.plan.blockers.length > 0 && opts.returnBlocked) {
    // The caller asked for the plan instead of a failed run. The row was only a lease; drop it.
    await env.DB.prepare("DELETE FROM sync_runs WHERE id = ? AND status = 'running'").bind(runId).run()
    return { blocked: planned.plan }
  }

  // This run supersedes any retry another run of the target had scheduled.
  await env.DB.prepare('UPDATE sync_runs SET next_retry_at = NULL WHERE target_id = ? AND id <> ? AND next_retry_at IS NOT NULL').bind(target.id, runId).run()
  await writeRunAudit(env, target, runId, 'sync.run.started', actorType, actorId, meta)

  if (outcome === null && planned !== null) {
    try {
      outcome = await execute(env, target, provider, runId, planned, counts, clock)
    } catch {
      outcome = failedOutcome('PROVIDER_ERROR')
    }
  }
  const final: Outcome = outcome ?? failedOutcome('PROVIDER_ERROR')

  const finished = clock()
  const finishedAt = finished.toISOString()
  const nextRetryAt = final.status === 'succeeded' ? null : computeNextRetryAtForErrors(final.errors, attempt, finished, undefined, final.retryAfterSeconds)
  const needsAttention = final.status !== 'succeeded' && [...final.errors].some((c) => NEEDS_ATTENTION.has(c))

  const batch = (): Promise<unknown[]> => {
    const statements = [
      // The target row is updated only while this run still owns the lease (same transaction as the run update).
      env.DB.prepare(
        "UPDATE sync_targets SET last_run_at = ?, status = CASE WHEN ? = 'succeeded' THEN 'active' WHEN ? = 1 THEN 'needs_attention' ELSE status END, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM sync_runs WHERE id = ? AND status = 'running')",
      ).bind(finishedAt, final.status, needsAttention ? 1 : 0, finishedAt, target.id, runId),
    ]
    if (final.status === 'succeeded') {
      statements.push(env.DB.prepare('UPDATE sync_runs SET next_retry_at = NULL WHERE target_id = ? AND id <> ? AND next_retry_at IS NOT NULL').bind(target.id, runId))
    }
    statements.push(
      env.DB.prepare("UPDATE sync_runs SET status = ?, counts_json = ?, error_code = ?, finished_at = ?, next_retry_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'")
        .bind(final.status, JSON.stringify(counts), final.errorCode, finishedAt, nextRetryAt, runId),
    )
    return env.DB.batch(statements)
  }

  let result: SyncRunDto = {
    id: runId, targetId: target.id, trigger: opts.trigger, status: final.status, attempt, counts, errorCode: final.errorCode, startedAt: nowIso, finishedAt, nextRetryAt,
  }
  let committed: unknown[] | null = null
  for (let tries = 0; tries < 2 && committed === null; tries++) {
    try { committed = await batch() } catch { committed = null }
  }
  if (committed === null) {
    // The final transaction failed twice. Do not leave the run 'running' until its lease expires: mark it failed.
    const fallbackRetry = computeNextRetryAt('PROVIDER_ERROR', attempt, finished)
    try {
      await env.DB.prepare("UPDATE sync_runs SET status = 'failed', counts_json = ?, error_code = 'PROVIDER_ERROR', finished_at = ?, next_retry_at = ?, lease_until = NULL WHERE id = ? AND status = 'running'")
        .bind(JSON.stringify(counts), finishedAt, fallbackRetry, runId).run()
    } catch {
      console.error(JSON.stringify({ level: 'error', event: 'sync.finish_failed' }))
    }
    result = { ...result, status: 'failed', errorCode: 'PROVIDER_ERROR', nextRetryAt: fallbackRetry }
  } else {
    const last = committed[committed.length - 1] as { meta?: { changes?: number } } | undefined
    if (Number(last?.meta?.changes ?? 1) === 0) {
      // Someone else closed this run (its lease expired and a newer run took over): report what is stored.
      const stored = await env.DB.prepare(`SELECT ${RUN_COLUMNS} FROM sync_runs WHERE id = ? LIMIT 1`).bind(runId).first<RunDbRow>()
      if (stored) result = toSyncRunDto(stored)
    }
  }
  await writeRunAudit(env, target, runId, result.status === 'succeeded' ? 'sync.run.succeeded' : 'sync.run.failed', actorType, actorId, meta)
  return result
}

const INTENT_SQL = 'INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_targets WHERE id = ? AND resource_json = ? AND deleted_at IS NULL) ON CONFLICT (target_id, name) DO NOTHING'
const CONFIRM_SQL = 'INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM sync_targets WHERE id = ? AND resource_json = ? AND deleted_at IS NULL) ON CONFLICT (target_id, name) DO UPDATE SET fingerprint = excluded.fingerprint, last_pushed_at = excluded.last_pushed_at'

async function execute(
  env: Env,
  target: SyncTargetRow,
  provider: SyncProvider,
  runId: string,
  planned: PlanResult,
  counts: SyncRunDto['counts'],
  clock: () => Date,
): Promise<Outcome> {
  if (!planned.ok) return failedOutcome(planned.code, planned.retryAfterSeconds)

  const { plan, ops, forget } = planned
  counts.skipped = plan.skip.length + plan.conflict.length
  // Limits are validated before any write. The shared contract has no SYNC_BLOCKED run code, so a blocked run
  // is a non-retryable validation failure: it needs the owner to change the environment or the filter.
  if (plan.blockers.length > 0) return failedOutcome('PROVIDER_VALIDATION')

  const connection = await env.DB.prepare('SELECT config_json FROM integration_connections WHERE id = ? AND org_id = ? LIMIT 1')
    .bind(target.connectionId, target.orgId).first<{ config_json: string }>()
  const config = parseJson<Record<string, unknown>>(connection?.config_json ?? '{}', {})
  // Defence in depth: the plan already checked, but the connection is re-read here.
  if (isTargetDenied(env, target.resource, config)) return failedOutcome('TARGET_NOT_ALLOWED')
  const credential = await readCredential(env, target.orgId, target.connectionId)
  if (credential === null) return failedOutcome('CREDENTIAL_UNAVAILABLE')

  const errors = new Set<SyncErrorCode>()
  let retryAfterSeconds: number | undefined
  const note = (code: SyncErrorCode, retryAfter?: number): void => {
    errors.add(code)
    if (retryAfter !== undefined) retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, retryAfter)
  }
  const pushedAt = clock().toISOString()
  const resourceJson = target.resourceJson
  const guard = [target.id, resourceJson] as const
  const chunkSize = Math.max(1, provider.limits.maxItems)
  // Sets first, deletes last, so a failure mid-way never removes something before its replacement landed.
  const ordered = [...ops.filter((o) => o.type === 'set'), ...ops.filter((o) => o.type === 'delete')]
  let okItems = 0
  let stopped = false

  const stillCurrent = async (): Promise<boolean> =>
    (await env.DB.prepare('SELECT 1 AS ok FROM sync_targets WHERE id = ? AND resource_json = ? AND deleted_at IS NULL').bind(...guard).first()) !== null
  const dropPending = (name: string) => env.DB.prepare('DELETE FROM sync_items WHERE target_id = ? AND name = ? AND fingerprint = ?').bind(target.id, name, PENDING_FINGERPRINT)

  for (let offset = 0; offset < ordered.length; offset += chunkSize) {
    const chunk = ordered.slice(offset, offset + chunkSize)
    if (stopped) {
      counts.failed += chunk.length
      continue
    }

    // Intent first. A run that started against an old resource (the target was edited or deleted meanwhile) sends
    // nothing and writes no ledger rows.
    try {
      if (!(await stillCurrent())) throw new Error('target changed')
      const intents = chunk.flatMap((o) => (o.type === 'set' ? [env.DB.prepare(INTENT_SQL).bind(target.id, o.name, PENDING_FINGERPRINT, pushedAt, ...guard)] : []))
      if (intents.length > 0) await env.DB.batch(intents)
    } catch {
      note('PROVIDER_ERROR')
      counts.failed += chunk.length
      stopped = true
      continue
    }

    const syncOps: SyncOp[] = chunk.map((o) => (o.type === 'set' ? { type: 'set', name: o.name, value: o.value } : { type: 'delete', name: o.name }))
    const pushed = await callProvider(PUSH_TIMEOUT_MS, (signal) => provider.push({ credential, config, resource: target.resource, ops: syncOps, signal }))
    const result = pushed.ok ? pushed.value : pushed
    const statements: D1PreparedStatement[] = []
    if (!result.ok) {
      note(result.code, result.retryAfterSeconds)
      counts.failed += chunk.length
      stopped = true
      // A definite failure means nothing landed: forget the intent. An unknown outcome keeps it (the names may exist).
      if (!outcomeUnknown(result)) for (const op of chunk) if (op.type === 'set') statements.push(dropPending(op.name))
    } else {
      const byName = new Map(result.results.map((r) => [r.name, r]))
      for (const op of chunk) {
        const item = byName.get(op.name)
        if (!item || !item.ok) {
          const code: ProviderErrorCode = item && !item.ok ? item.code : 'PROVIDER_ERROR'
          note(code, item && !item.ok ? item.retryAfterSeconds : undefined)
          counts.failed += 1
          if (STOP_ON.has(code)) stopped = true
          const unknown = !item || outcomeUnknown(item)
          if (op.type === 'set' && !unknown) statements.push(dropPending(op.name))
          continue
        }
        okItems += 1
        if (op.type === 'set') {
          if (op.kind === 'create') counts.created += 1
          else counts.updated += 1
          statements.push(env.DB.prepare(CONFIRM_SQL).bind(target.id, op.name, op.fingerprint, pushedAt, ...guard))
        } else {
          counts.deleted += 1
          statements.push(env.DB.prepare('DELETE FROM sync_items WHERE target_id = ? AND name = ?').bind(target.id, op.name))
        }
      }
    }
    // Progress is recorded per chunk and the lease extended from the real clock, so a crash or failure later keeps
    // what landed and a long run is not mistaken for a crashed one.
    statements.push(env.DB.prepare("UPDATE sync_runs SET lease_until = ? WHERE id = ? AND status = 'running'").bind(new Date(clock().getTime() + SYNC_LEASE_MS).toISOString(), runId))
    try {
      await env.DB.batch(statements)
    } catch {
      // Provider calls landed but the ledger write failed. The pending intent rows remain, which the next plan
      // reads as "ours", so nothing is orphaned. Stop here.
      note('PROVIDER_ERROR')
      stopped = true
    }
  }

  if (forget.length > 0 && !stopped) {
    try {
      await env.DB.batch(forget.map((name) => env.DB.prepare('DELETE FROM sync_items WHERE target_id = ? AND name = ?').bind(target.id, name)))
    } catch {
      note('PROVIDER_ERROR')
    }
  }

  const retry = retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}
  if (errors.size === 0) return { status: 'succeeded', errorCode: null, errors, ...retry }
  const errorCode = ERROR_PRIORITY.find((c) => errors.has(c)) ?? 'PROVIDER_ERROR'
  return { status: okItems > 0 ? 'partial' : 'failed', errorCode, errors, ...retry }
}

/** A failure whose effect on the target is unknown: the request may have been applied before the response was lost. */
function outcomeUnknown(failure: { code: ProviderErrorCode } & FailureInfo): boolean {
  return failure.maybeApplied === true || failure.code === 'TIMEOUT'
}
