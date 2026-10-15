// Shared keyset-cursor codec (issue #113). Two callers today:
//   - apps/api/src/routes/admin.ts (GET /api/admin/orgs) rejects an invalid cursor with 400.
//   - apps/api/src/integrations/sync-engine.ts (listSyncTargets) silently resets to page one.
// Those are deliberate, per-caller choices around the SAME codec; this file centralises only the
// encode/decode of an opaque `created_at|id` pair, not the error-handling policy. A future third
// caller should pick its own policy around decodeKeysetCursor's `null` return, not assume one is
// "correct".

/** Encode an opaque, URL-safe cursor from a sort key pair. */
export function encodeKeysetCursor(createdAt: string, id: string): string {
  return btoa(`${createdAt}|${id}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Decode an opaque cursor, or return null on anything malformed (not base64, no separator, empty parts). */
export function decodeKeysetCursor(cursor: string): { createdAt: string; id: string } | null {
  let decoded = ''
  try {
    decoded = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return null
  }
  const sep = decoded.lastIndexOf('|')
  if (sep <= 0) return null
  return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) }
}
