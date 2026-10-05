// Cron housekeeping: the deletes nothing else does (issue #80).
//
// Three tables grew without bound. `audit_log` is the fastest — one row per secret read, plus
// three per sync run, which a minute cron can turn into tens of thousands a day — and retention
// was only ever a filter applied to reads, so a free-plan organisation was told it had seven-day
// retention while every row it ever wrote stayed in D1 forever. `share_links` kept its
// `encrypted_payload` after the link expired or was used up, so ciphertext nobody can reach any
// more still landed in every `wrangler d1 export`. `auth_tokens` was only purged opportunistically
// by the routes that happened to touch it. Issue #87 added a fourth sweep, for orphaned KV
// blobs, which nothing collected and nothing could even enumerate.
//
// Two rules shape this file:
//   - Bounded per tick. The cron shares one subrequest and CPU budget with rotation and sync, so
//     every statement here has a LIMIT and the organisation loop has a cap.
//   - The audit sweep uses the PLAN's window, never the per-organisation override. The override
//     narrows what the API shows; letting it delete would turn a display preference into a
//     self-destruct button for the trail that is supposed to be watching whoever set it.
import type { Env } from '../index'
import { AUDIT_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, retentionCutoffIso } from './audit-retention'
import { logEvent } from './security'
import { KV_DELETE_CHUNK, SECRET_BLOB_PREFIX, parseSecretBlobKey } from './secret-blobs'
import { clearSystemState, readSystemState, writeSystemState } from './system-state'

/** Organisations whose audit log is swept per tick. */
export const AUDIT_SWEEP_ORGS_PER_TICK = 20
/** Rows deleted per organisation per tick. The next tick continues where this one stopped. */
export const AUDIT_SWEEP_ROWS_PER_TICK = 500
/** Expired or exhausted share links removed per tick. */
export const SHARE_PURGE_PER_TICK = 200

/** KV keys listed per tick. One list call; the cursor resumes on the next tick. */
export const ORPHAN_SCAN_KEYS_PER_TICK = 200
/** KV blobs actually deleted per tick. Each delete is a subrequest. */
export const ORPHAN_DELETE_PER_TICK = 50
/**
 * How long a blob must have been known to be unreferenced before it may be deleted.
 * It only has to exceed the lifetime of the request that could still be writing it —
 * an hour is orders of magnitude more than a Worker invocation gets.
 */
export const ORPHAN_GRACE_MS = 3600_000
/**
 * Candidate rows are forgotten after this long. A candidate whose blob is still in KV is
 * re-listed and re-recorded (which only restarts its wait, the safe direction); one whose
 * blob has gone — deleted by the normal delete path after we first saw it — would otherwise
 * sit in the table forever, which is the growth this file exists to stop.
 */
export const ORPHAN_CANDIDATE_TTL_MS = 7 * 24 * 3600_000
/** Stale candidate rows pruned per tick. */
export const ORPHAN_CANDIDATE_PRUNE_PER_TICK = 200

const ORPHAN_CURSOR_KEY = 'housekeeping.orphan_blob_cursor'
/**
 * Values bound per statement when building an `IN (...)` list. D1's documented limits do not
 * state a maximum, and SQLite's own has moved between builds, so a page is split into
 * statements small enough that no plausible limit is in play.
 */
const D1_BIND_CHUNK = 90

export type HousekeepingResult = {
  auditRowsDeleted: number
  shareLinksDeleted: number
  authTokensDeleted: number
  /** Blobs listed from KV and checked against D1 this tick. */
  orphanBlobsScanned: number
  /** Of those, the ones no live row references. Most will be inside the grace period. */
  orphanBlobsUnreferenced: number
  /** Blobs deleted: proved unreferenced twice, ORPHAN_GRACE_MS apart. */
  orphanBlobsDeleted: number
}

/**
 * Sweep audit rows outside each organisation's plan retention window.
 *
 * Organisations are taken in rotation by id so that one very busy organisation cannot starve the
 * others: the cursor is simply "the ids after the last one we looked at", wrapping each tick.
 */
async function sweepAuditLog(env: Env, now: Date): Promise<number> {
  // Only plans with a finite window. An unrecognised plan string falls back to the most
  // restrictive tier, matching effectiveRetentionDays.
  const orgs = await env.DB.prepare(
    `SELECT id, plan FROM organisations
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE audit_log.org_id = organisations.id)
      ORDER BY id LIMIT ?`,
  ).bind(AUDIT_SWEEP_ORGS_PER_TICK).all<{ id: string; plan: string }>()

  let deleted = 0
  for (const org of orgs.results ?? []) {
    const planDays = AUDIT_RETENTION_DAYS[org.plan] ?? DEFAULT_RETENTION_DAYS
    const cutoff = retentionCutoffIso(planDays, now)
    if (cutoff === null) continue // retain forever

    // Delete by primary key from a bounded SELECT rather than a bare DELETE ... LIMIT, which
    // SQLite only supports when compiled with an option D1 does not guarantee.
    const result = await env.DB.prepare(
      `DELETE FROM audit_log WHERE id IN (
         SELECT id FROM audit_log WHERE org_id = ? AND timestamp <= ? LIMIT ?
       )`,
    ).bind(org.id, cutoff, AUDIT_SWEEP_ROWS_PER_TICK).run()
    deleted += Number(result.meta.changes ?? 0)
  }
  return deleted
}

/** Expired or fully viewed share links, including their stored ciphertext. */
async function purgeShareLinks(env: Env, now: Date): Promise<number> {
  const result = await env.DB.prepare(
    `DELETE FROM share_links WHERE id IN (
       SELECT id FROM share_links WHERE expires_at <= ? OR view_count >= max_views LIMIT ?
     )`,
  ).bind(now.toISOString(), SHARE_PURGE_PER_TICK).run()
  return Number(result.meta.changes ?? 0)
}

/**
 * Reconcile KV's `secret:` blobs against D1 and delete the ones proved unreachable.
 *
 * Why there is anything to collect: the create and update paths write the blob and only then
 * commit D1 (migration 0014 explains why that order is the safe one), so a failed D1 write
 * leaves a blob nothing points at; and the delete path removes the D1 rows first, so hitting
 * the subrequest ceiling mid-cleanup orphans the rest. Neither leaks a readable secret — a
 * blob without its wrapped DEK is undecryptable — but both leak storage, and until now there
 * was no way even to count them.
 *
 * HOW A LIVE BLOB IS GUARANTEED SAFE. Two independent conditions, and a blob must fail both
 * before it is touched:
 *
 *  1. Referenced-ness is computed from the pointer, generously. A blob is referenced when its
 *     secret row exists and its revision is <= that row's `blob_rev`. `blob_rev` only ever
 *     increases, and a `secret_history` row points at a revision of its OWN secret, so that
 *     one bound covers every historical reference without reading `secret_history` at all.
 *     The pre-0014 unversioned key is revision 0 and so is referenced for as long as its row
 *     exists. Anything that does not parse as a key this codebase writes is skipped, not
 *     guessed at. So the set considered for deletion is a subset of the truly unreferenced.
 *
 *  2. A blob written by a request still in flight is excluded by time, not by inspection.
 *     Nothing in KV distinguishes "rubbish from a failed D1 write" from "a blob whose row is
 *     about to be inserted": list() reports no write time and pre-0014 blobs carry no
 *     metadata. So the first sighting only records the key in `orphan_blob_candidates`. A key
 *     is deleted on a LATER tick, and only if its first sighting is older than ORPHAN_GRACE_MS
 *     *and* D1 — re-read in that same tick, below — still does not reference it. Since the
 *     blob write and the D1 commit happen in one request, and ORPHAN_GRACE_MS is far longer
 *     than a request can live, a blob still unreferenced after the grace period cannot be in
 *     flight: the request that wrote it has either committed (the key is referenced now, and
 *     its candidate row is dropped) or is gone for good.
 *
 * The asymmetry is deliberate: a referenced blob is never a candidate, so the worst outcome of
 * a wrong answer here is leaked storage, never an unreadable secret.
 */
/**
 * Kill switch, for one specific scenario: a D1 point-in-time restore.
 *
 * The sweep's safety argument rests on D1 being the source of truth — a blob is referenced when
 * its row exists and its revision is at or below `blob_rev`. A restore that moves `blob_rev`
 * *backwards* breaks that premise: a blob the live row still needs looks unreferenced, and an
 * hour later the sweep deletes it. That is a data-loss path that only opens during recovery,
 * which is the worst moment for it, so it gets an explicit off switch rather than a comment.
 *
 * Set `DISABLE_ORPHAN_SWEEP=1` before restoring D1, and leave it set until KV and D1 agree
 * again. See OPERATIONS.md § 2.
 */
function orphanSweepDisabled(env: Env): boolean {
  return String(env.DISABLE_ORPHAN_SWEEP ?? '').trim() === '1'
}

async function sweepOrphanBlobs(env: Env, now: Date): Promise<Pick<HousekeepingResult, 'orphanBlobsScanned' | 'orphanBlobsUnreferenced' | 'orphanBlobsDeleted'>> {
  if (orphanSweepDisabled(env)) {
    logEvent('housekeeping.orphan_sweep_disabled')
    return { orphanBlobsScanned: 0, orphanBlobsUnreferenced: 0, orphanBlobsDeleted: 0 }
  }
  const nowIso = now.toISOString()
  const stored = await readSystemState(env, ORPHAN_CURSOR_KEY)
  const listing = await env.SECRETS_KV.list({
    prefix: SECRET_BLOB_PREFIX,
    limit: ORPHAN_SCAN_KEYS_PER_TICK,
    cursor: stored?.value ?? null,
  })

  const parsed = listing.keys
    .map((entry) => parseSecretBlobKey(entry.name))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

  let unreferencedCount = 0
  let deleted = 0

  if (parsed.length > 0) {
    // Which of this page's secrets still exist, and where their pointer is. The ids are
    // bound; only the placeholders are interpolated.
    const pointer = new Map<string, number>()
    for (const ids of chunked([...new Set(parsed.map((entry) => entry.secretId))], D1_BIND_CHUNK)) {
      const rows = await env.DB.prepare(
        `SELECT id, blob_rev FROM secrets WHERE id IN (${ids.map(() => '?').join(',')})`,
      ).bind(...ids).all<{ id: string; blob_rev: number }>()
      for (const row of rows.results ?? []) pointer.set(row.id, row.blob_rev)
    }

    const referenced: string[] = []
    const unreferenced: string[] = []
    for (const entry of parsed) {
      const rev = pointer.get(entry.secretId)
      if (rev !== undefined && entry.rev <= rev) referenced.push(entry.key)
      else unreferenced.push(entry.key)
    }
    unreferencedCount = unreferenced.length

    // A key that turned out to be referenced after all — the in-flight write committed —
    // loses its candidate record, so if it is ever orphaned later the clock starts again.
    await deleteCandidates(env, referenced)

    // Record first sightings. ON CONFLICT DO NOTHING, so an existing sighting keeps its
    // original timestamp: the grace period must not restart every time we look.
    for (const chunk of chunked(unreferenced, D1_BIND_CHUNK)) {
      await env.DB.batch(chunk.map((key) => env.DB.prepare(
        'INSERT INTO orphan_blob_candidates (kv_key, first_seen_at) VALUES (?, ?) ON CONFLICT(kv_key) DO NOTHING',
      ).bind(key, nowIso)))
    }

    // Of this page's unreferenced keys, the ones first seen long enough ago. `pointer` was
    // read above in this same tick, so the unreferenced-ness being acted on is current.
    const cutoff = new Date(now.getTime() - ORPHAN_GRACE_MS).toISOString()
    const doomed: string[] = []
    for (const chunk of chunked(unreferenced, D1_BIND_CHUNK)) {
      const budget = ORPHAN_DELETE_PER_TICK - doomed.length
      if (budget <= 0) break
      const aged = await env.DB.prepare(
        `SELECT kv_key FROM orphan_blob_candidates
          WHERE first_seen_at <= ? AND kv_key IN (${chunk.map(() => '?').join(',')})
          ORDER BY first_seen_at LIMIT ?`,
      ).bind(cutoff, ...chunk, budget).all<{ kv_key: string }>()
      for (const row of aged.results ?? []) doomed.push(row.kv_key)
    }

    for (const chunk of chunked(doomed, KV_DELETE_CHUNK)) {
      // A KV error must not fail the sweep, and must not drop the candidate row either:
      // the key stays recorded and is deleted on a later tick.
      const outcomes = await Promise.all(chunk.map((key) => env.SECRETS_KV.delete(key).then(() => true, () => false)))
      const gone = chunk.filter((_, index) => outcomes[index])
      deleted += gone.length
      await deleteCandidates(env, gone)
    }
  }

  // Advance only after the page has been handled, so a thrown tick retries the same page.
  // A completed listing clears the cursor, and the next sweep starts from the beginning.
  if (listing.list_complete) await clearSystemState(env, ORPHAN_CURSOR_KEY)
  else await writeSystemState(env, ORPHAN_CURSOR_KEY, listing.cursor, nowIso)

  await pruneStaleCandidates(env, now)

  return { orphanBlobsScanned: parsed.length, orphanBlobsUnreferenced: unreferencedCount, orphanBlobsDeleted: deleted }
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

async function deleteCandidates(env: Env, keys: string[]): Promise<void> {
  for (const chunk of chunked(keys, D1_BIND_CHUNK)) {
    await env.DB.prepare(
      `DELETE FROM orphan_blob_candidates WHERE kv_key IN (${chunk.map(() => '?').join(',')})`,
    ).bind(...chunk).run()
  }
}

/** Candidate rows whose blob is no longer in KV would otherwise never be revisited. */
async function pruneStaleCandidates(env: Env, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - ORPHAN_CANDIDATE_TTL_MS).toISOString()
  await env.DB.prepare(
    `DELETE FROM orphan_blob_candidates WHERE kv_key IN (
       SELECT kv_key FROM orphan_blob_candidates WHERE first_seen_at <= ? LIMIT ?
     )`,
  ).bind(cutoff, ORPHAN_CANDIDATE_PRUNE_PER_TICK).run()
}

/** Used or expired verification and reset tokens. */
async function purgeAuthTokens(env: Env, now: Date): Promise<number> {
  const result = await env.DB.prepare('DELETE FROM auth_tokens WHERE expires_at <= ? OR used_at IS NOT NULL')
    .bind(now.toISOString()).run()
  return Number(result.meta.changes ?? 0)
}

/**
 * Never throws: it shares a scheduled invocation with key rotation and the sync tick, and a
 * housekeeping failure must not take either of those down. Each step is independent, so one
 * failing does not skip the others.
 */
export async function housekeepingTick(env: Env, now: Date = new Date()): Promise<HousekeepingResult> {
  const result: HousekeepingResult = {
    auditRowsDeleted: 0,
    shareLinksDeleted: 0,
    authTokensDeleted: 0,
    orphanBlobsScanned: 0,
    orphanBlobsUnreferenced: 0,
    orphanBlobsDeleted: 0,
  }

  for (const [step, run] of [
    ['audit', async () => { result.auditRowsDeleted = await sweepAuditLog(env, now) }],
    ['share', async () => { result.shareLinksDeleted = await purgeShareLinks(env, now) }],
    ['tokens', async () => { result.authTokensDeleted = await purgeAuthTokens(env, now) }],
    ['orphan_blobs', async () => { Object.assign(result, await sweepOrphanBlobs(env, now)) }],
  ] as const) {
    try {
      await run()
    } catch (err) {
      logEvent('housekeeping.step_failed', { step, reason: err instanceof Error ? err.name : 'UnknownError' })
    }
  }

  // The orphan counts are logged whenever anything was found, deleted or not: an operator
  // needs to see a growing backlog, which is the symptom of D1 writes failing after KV ones.
  if (result.orphanBlobsUnreferenced || result.orphanBlobsDeleted) {
    logEvent('housekeeping.orphan_blobs', {
      scanned: result.orphanBlobsScanned,
      unreferenced: result.orphanBlobsUnreferenced,
      deleted: result.orphanBlobsDeleted,
    })
  }
  if (result.auditRowsDeleted || result.shareLinksDeleted || result.authTokensDeleted) {
    logEvent('housekeeping.swept', {
      auditRowsDeleted: result.auditRowsDeleted,
      shareLinksDeleted: result.shareLinksDeleted,
      authTokensDeleted: result.authTokensDeleted,
    })
  }
  return result
}
