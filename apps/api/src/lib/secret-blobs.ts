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

export function secretBlobKey(secretId: string, blobRev: number): string {
  return blobRev > LEGACY_BLOB_REV ? `secret:${secretId}:${blobRev}` : `secret:${secretId}`
}

/**
 * Where a historical value's ciphertext lives. A pre-0014 row has no blob_rev and
 * points at its own copy; a row written since points at the secret revision that
 * held that value, so nothing is copied.
 */
export function historyBlobKey(secretId: string, historyId: string, blobRev: number | null): string {
  return blobRev === null ? `secrethist:${historyId}` : secretBlobKey(secretId, blobRev)
}

/**
 * Every blob key a secret may own: the unversioned one plus every revision up to
 * the current pointer. Used when deleting, where guessing wrong leaks storage.
 */
export function allSecretBlobKeys(secretId: string, blobRev: number): string[] {
  const keys = [`secret:${secretId}`]
  for (let rev = 1; rev <= blobRev; rev += 1) keys.push(`secret:${secretId}:${rev}`)
  return keys
}
