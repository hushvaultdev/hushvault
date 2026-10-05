// Organisation invitations (issue #82, docs/plans/multi-org-and-invites.md Lane B).
//
// An invite is a CREDENTIAL: whoever holds the token can add one named address to one
// organisation. So it is built like the other credentials in this codebase and not like a row:
//
//   * 256 bits from crypto.getRandomValues, handed back exactly once by the create response and
//     mailed once. Nothing else can ever read it again.
//   * Only base64url(SHA-256(token)) is stored (org_invites.token_hash, migration 0018), so a
//     `wrangler d1 export` yields nothing usable -- the same construction as auth_tokens and
//     refresh_tokens.
//   * Bound to a lower-cased email address, not to its bearer. Forwarding the link does not let
//     the recipient in; the accepting account's VERIFIED address has to match.
//   * Seven days, then dead whether or not anybody sweeps the row.
import { createBase64Url } from './auth'

/** An invitation is valid for seven days. Pinned in docs/API.md and said out loud in the email. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** How many open invitations one listing returns. A bound, not a page: nothing pages this yet. */
export const INVITE_LIST_LIMIT = 200

const textEncoder = new TextEncoder()

/**
 * A fresh invitation token. 32 bytes, so guessing one is not a strategy and the only paths to it
 * are the mailbox it was sent to and the one create response that returned it.
 */
export function createInviteToken(): string {
  return createBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

/** base64url(SHA-256(token)) -- what is stored, and the only thing a lookup ever matches on. */
export async function hashInviteToken(token: string): Promise<string> {
  return createBase64Url(await crypto.subtle.digest('SHA-256', textEncoder.encode(token)))
}

/**
 * The four states a stored invitation can be in. Revoked beats expired beats accepted only in the
 * order they are reported to a token holder; they are not exclusive in the row (a revoked invite
 * also goes on to expire), so the order here is the order the refusals are written in.
 */
export type InviteState = 'open' | 'revoked' | 'expired' | 'accepted'

export type InviteStateRow = {
  accepted_at: string | null
  revoked_at: string | null
  expires_at: string
}

/**
 * Why a stored invitation cannot be accepted, or 'open' if it can.
 *
 * The classification is only for the REFUSAL MESSAGE. What actually stops a second use is the
 * conditional UPDATE in routes/members.ts, which re-checks all three conditions inside the same
 * statement -- this function is read outside any transaction and is therefore already stale by
 * the time the caller acts on it.
 */
export function inviteState(row: InviteStateRow, nowIso: string): InviteState {
  if (row.revoked_at !== null) return 'revoked'
  if (row.accepted_at !== null) return 'accepted'
  if (row.expires_at <= nowIso) return 'expired'
  return 'open'
}

/** The refusal for each closed state: code, status and a message written for a person. */
export const INVITE_REFUSALS: Record<Exclude<InviteState, 'open'>, { error: string; message: string }> = {
  revoked: { error: 'INVITE_REVOKED', message: 'This invitation was revoked. Ask an admin to send a new one.' },
  expired: { error: 'INVITE_EXPIRED', message: 'This invitation has expired. Ask an admin to send a new one.' },
  accepted: { error: 'INVITE_ACCEPTED', message: 'This invitation has already been used.' },
}
