// KV key naming for encrypted secret values (issue #80, migration 0014).
//
// The one rule: a blob key is written once and never overwritten. D1 holds the
// pointer (`secrets.blob_rev`) and is the single source of truth, so a failed D1
// write leaves an orphaned blob rather than a secret whose ciphertext in KV no
// longer matches the wrapped DEK in D1. Overwriting was unrecoverable, because the
// compensating write landed inside KV's one-write-per-second-per-key window and so
// could not be relied on to happen at all.

/**
 * How many KV deletes to issue at once. Cloudflare counts each as a subrequest, so a
 * delete must be chunked rather than fanned out over an unbounded list, and serialising
 * them turns a large delete into a long chain of round trips.
 */
export const KV_DELETE_CHUNK = 50

/** Revision 0 is the pre-0014 unversioned key, which existing rows still use. */
export const LEGACY_BLOB_REV = 0

/** Every secret-value blob key starts with this; nothing else in SECRETS_KV does. */
export const SECRET_BLOB_PREFIX = 'secret:'

export function secretBlobKey(secretId: string, blobRev: number): string {
  return blobRev > LEGACY_BLOB_REV ? `secret:${secretId}:${blobRev}` : `secret:${secretId}`
}

/**
 * Pre-0014 superseded-value copies, `secrethist:{historyId}`.
 *
 * Nothing writes this prefix any more, and since issue #84 nothing *references* it either:
 * the `secret_history` rows that named these keys, and that held the wrapped DEKs needed to
 * read them, were dropped by migration 0017. So every key under this prefix is unreadable
 * ciphertext and pure leaked storage. It is kept here for one reason only — the housekeeping
 * sweep is the last thing that can still find and delete them, because the delete paths no
 * longer have any D1 row to enumerate them from.
 *
 * Note it is NOT a sub-prefix of SECRET_BLOB_PREFIX: `secrethist:` does not start with
 * `secret:` (the seventh character is `h`, not `:`), which is why it needs its own listing.
 */
export const LEGACY_HISTORY_BLOB_PREFIX = 'secrethist:'

/**
 * Every blob key a secret may own: the unversioned one plus every revision up to
 * the current pointer. Used when deleting, where guessing wrong leaks storage.
 */
export function allSecretBlobKeys(secretId: string, blobRev: number): string[] {
  const keys = [`secret:${secretId}`]
  for (let rev = 1; rev <= blobRev; rev += 1) keys.push(`secret:${secretId}:${rev}`)
  return keys
}

/** A `secret:` key taken apart again. `rev` is LEGACY_BLOB_REV for the unversioned form. */
export type ParsedBlobKey = { key: string; secretId: string; rev: number }

/**
 * The inverse of `secretBlobKey`, for the reconciliation sweep, which only has the key.
 * Returns null for anything that is not exactly one of the two shapes this module writes,
 * so an unrecognised key under the prefix is left alone rather than guessed at.
 */
export function parseSecretBlobKey(key: string): ParsedBlobKey | null {
  if (!key.startsWith(SECRET_BLOB_PREFIX)) return null
  const parts = key.slice(SECRET_BLOB_PREFIX.length).split(':')
  const secretId = parts[0]
  if (!secretId) return null
  if (parts.length === 1) return { key, secretId, rev: LEGACY_BLOB_REV }
  if (parts.length !== 2) return null
  const rev = parts[1]
  // Decimal, no leading zero, no sign: the only form secretBlobKey can produce.
  if (rev === undefined || !/^[1-9][0-9]*$/.test(rev)) return null
  return { key, secretId, rev: Number(rev) }
}

/**
 * Cloudflare's documented maximum keys per KV bulk read (`get(keys: string[])`).
 * https://developers.cloudflare.com/kv/api/read-key-value-pairs/
 */
export const KV_BULK_READ_MAX = 100

/**
 * Fallback fan-out when the binding has no bulk read. Workers allows a small number of
 * simultaneous outgoing connections per invocation, so a wider fan-out queues rather
 * than going faster.
 */
export const KV_READ_CONCURRENCY = 6

/**
 * Bindings observed not to implement bulk read, so the probe below is paid at most once
 * per binding per isolate rather than once per call. A WeakSet, so a binding object the
 * runtime discards is not retained.
 */
const noBulkRead = new WeakSet<object>()

/**
 * Read many blobs, returning `key -> value` with `null` for a key KV does not hold.
 *
 * Bulk read is the point of this function: Cloudflare counts `get(keys)` as a SINGLE
 * operation against the per-invocation limit on operations to external services, and it is
 * not subject to the simultaneous-connection limit — so chunks of `KV_BULK_READ_MAX` beat
 * any fan-out of single gets on both counts. Resolving an environment is the hot path for
 * `hv run`, every CI pull and every sync run, and it used to spend one operation per secret.
 *
 * A binding that does not implement it (an old compatibility date, or a test double) is
 * detected rather than assumed: the array form is trusted only when it answers with a `Map`,
 * and anything else — including a throw — falls back to the bounded `Promise.all` batches
 * that preceded it. The fallback repeats the whole read rather than the failed chunk, which
 * costs a handful of operations exactly once per binding and keeps this simple. A transient
 * error on the array form therefore demotes the binding for the rest of the isolate's life,
 * which is the safe way round: slower reads, same answers, and the next isolate retries.
 */
export async function readSecretBlobs(kv: KVNamespace, keys: string[]): Promise<Map<string, string | null>> {
  if (keys.length === 0) return new Map()
  if (!noBulkRead.has(kv)) {
    const bulk = await bulkRead(kv, keys)
    if (bulk) return bulk
    noBulkRead.add(kv)
  }
  return batchedRead(kv, keys)
}

async function bulkRead(kv: KVNamespace, keys: string[]): Promise<Map<string, string | null> | null> {
  const out = new Map<string, string | null>()
  for (let i = 0; i < keys.length; i += KV_BULK_READ_MAX) {
    const chunk = keys.slice(i, i + KV_BULK_READ_MAX)
    // `unknown` on purpose: the types promise a Map, and this checks the binding agrees.
    let values: unknown
    try {
      values = await kv.get(chunk, 'text')
    } catch {
      return null
    }
    if (!(values instanceof Map)) return null
    const map = values as Map<string, string | null>
    for (const key of chunk) out.set(key, map.get(key) ?? null)
  }
  return out
}

async function batchedRead(kv: KVNamespace, keys: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>()
  for (let i = 0; i < keys.length; i += KV_READ_CONCURRENCY) {
    const chunk = keys.slice(i, i + KV_READ_CONCURRENCY)
    const values = await Promise.all(chunk.map((key) => kv.get(key)))
    for (const [index, key] of chunk.entries()) out.set(key, values[index] ?? null)
  }
  return out
}
