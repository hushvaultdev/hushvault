# Multi-org, invites and the org switcher (issue #82)

**Status:** foundation design, agreed before implementation. Owner decision on 2026-10-05:
**multi-org with an explicit switcher** (not one-org-per-user, not implicit resolution).
**Date:** 2026-10-05

This is the contract the implementation lanes work to. Where a lane finds the contract wrong,
it changes this file in the same commit rather than diverging from it silently.

**Lane status.** Lane A (foundation, API) is implemented: migration `0018_multi_org.sql`,
`GET/POST /api/orgs`, `POST /api/orgs/:id/switch`, and all five first-membership resolutions
removed. Lanes B and C are not started. Every change Lane A made to this file is marked inline
with *(Lane A)*.

---

## The problem being fixed, precisely

Every account today is a single-member organisation: the only `INSERT INTO members` statements
are self-signup and OAuth signup, each creating a fresh org with the user as `owner`. RBAC,
`requireRole`, `requireCurrentAdmin` and the audit trail are all implemented and enforced, and
all unreachable.

Three places resolve "the user's org" as `members ... ORDER BY created_at ASC LIMIT 1`. That is
correct only while nobody has two memberships, which is exactly what invites end. The day a user
joins a second org each becomes a cross-tenant bug, so they are fixed **in the same change** as
invites, not after:

| Where | What goes wrong with two memberships |
|---|---|
| `middleware/auth.ts` (API-key auth) | The key acts in the user's *earliest* org, whatever org it was created in |
| `routes/auth.ts` (refresh) | A user working in org B is silently moved to org A, with org A's role, within 15 minutes |
| `routes/secret-scanner.ts` (revocation audit) | The revocation is recorded against the wrong org |

## Principles

1. **An org is chosen explicitly and then carried, never re-derived.** A credential (access
   token, refresh family, API key) names the org it acts in. Nothing re-resolves an org from the
   actor's memberships, because that is what makes the bug above possible at all.
2. **Membership is re-checked on every use, never cached in the credential alone.** The access
   token carries `orgId` *and* `role`; the role is re-read from `members` where a request can
   change anything (`requireCurrentAdmin` already does this). A revoked membership must stop
   working without waiting for a token to expire — within one refresh (15 min) at worst, and
   immediately for anything that re-reads the role.
3. **An audit row's org comes from the resource, not the actor.** Already true for share links
   (#80) and must hold for every new row.
4. **Nothing silently crosses an org boundary.** Where the org cannot be established, the answer
   is a 401/403 with a distinct code the dashboard can act on — never a fallback to another org.

---

## Lane A — foundation (API)

**Migration `0018_multi_org.sql`.** Additive only; applied before the code, per DEPLOYMENT.md.

- `api_keys.org_id TEXT` + backfill from the creator's single membership + index. Left nullable
  in SQLite (adding a NOT NULL column with no default is not possible on an existing table);
  the code treats NULL as "unusable, re-create the key" rather than falling back to a membership.
- `refresh_tokens.org_id TEXT` + backfill, same reasoning.
- `org_invites` table: `id` (`inv_`), `org_id`, `email` (stored lower-cased), `role`,
  `token_hash` (SHA-256, base64url — never the token), `invited_by`, `created_at`, `expires_at`,
  `accepted_at`, `accepted_by`, `revoked_at`, `revoked_by`. Unique on
  (`org_id`, `email`) **where** `accepted_at IS NULL AND revoked_at IS NULL`, as a partial unique
  index, so one open invite per address per org and no rebuild to change it later.
- ~~Index `members_user_idx` on `members(user_id)` if not already present~~ — **already created by
  `0000_init.sql`.** Lane A left it out rather than re-stating it; the org list query is already indexed.
  (Corrected during Lane A.)

**Org context.**

- `GET /api/orgs` — every org the caller is a member of, with their role, the org's plan and
  which one the current token acts in. This is what the switcher reads.
- `POST /api/orgs` — create an org; the caller becomes `owner`. Rate-limited like other
  account-level writes; audited `org.create` against the new org.
- `POST /api/orgs/:id/switch` — verifies membership, then issues a new access token and **revokes the
  family the caller came in on, starting a new family bound to the new org**. Audited `org.switch`
  against the target org. A non-member gets 403 `NOT_A_MEMBER` (never 404-by-org-guess).
  *(Lane A made this wording precise. "Rotates the cookie into a family bound to the new org" could be
  read as changing an existing family's org. It must not be: a family's org is immutable for its whole
  life — the rotating INSERT copies `org_id` from the row it consumes — which is what makes "a refresh
  cannot change org" a property of the schema rather than of a route remembering to pass the right
  value. Revoking the old family also means no sibling token survives pointing at the old org.
  Consequence for Lane C: switching invalidates the previous refresh cookie, so a tab that was
  mid-refresh when another tab switched gets a 401, not a 409.)*
  Signed-in people only: an API key is bound to one org for life and gets 403.
- Login / register / OAuth / claim all keep today's deterministic default (earliest membership),
  but the choice becomes explicit: the response carries `orgs` so the dashboard can offer the
  switch without a second round trip. *(Lane A: login, register and refresh carry `orgs`. The OAuth
  callback cannot — it is a 302 whose session rides in a URL fragment — so the dashboard reads
  `GET /api/orgs` after an OAuth sign-in. Lane C should not expect `orgs` in the fragment.)*

**The three resolutions.**

- `middleware/auth.ts`: API-key auth reads `api_keys.org_id` and then
  `members WHERE user_id = ? AND org_id = ?`. No membership, or a NULL `org_id` → 401
  `KEY_ORG_UNRESOLVED` (distinct from a bad key, so an operator can tell them apart).
- `routes/auth.ts`: refresh reads `refresh_tokens.org_id` for the family and re-reads the role
  for that org. Membership gone → 401 `MEMBERSHIP_REVOKED`, family revoked, cookie cleared.
- `routes/secret-scanner.ts`: the revocation audit row takes its org from the key being revoked. The
  revocation itself is unconditional and happens first: containing the leak must not depend on an org
  being resolvable. A key with no org is still revoked, and logs `secret_scanner.revoked_without_org`
  rather than filing the row somewhere wrong.

**Two more first-membership uses Lane A found and fixed, not in the original list.**

- `routes/auth.ts` also resolved earliest-membership to place four *account-level* audit rows
  (`auth.email.verified`, `auth.password_reset.requested`, `auth.password_reset.completed`,
  `auth.oauth.account_takeover`). These events are about the person, not one org, so "earliest
  membership" meant the other orgs a person belongs to would never learn that their member's password
  was reset. They are now written once per org the user is a member of: each org's admins see the
  security events of their own members. Rare events, so the fan-out is a few inserts.
- `DELETE /api/auth/api-keys/:id` audited against the *actor's current* org. Deleting a key belonging
  to org B while acting in org A filed the revocation in A's trail, where nobody responsible for B's
  credentials would see it. It now reads the key's own org first (principle 3).

## Lane B — invites and members (API), after Lane A lands

**Pinned by Lane C's implementation (2026-10-05).** The dashboard is built and merged, so these
are no longer open choices — Lane B matches them or Lane C breaks:

- **The invitation link is `{WEB_APP_URL}/invites/accept#token=<token>`.** The token goes in the
  **fragment**, like `/verify-email` and `/reset-password` already do, so it never reaches a server
  log or a `Referer` header. The page also accepts `?token=` as a fallback and an optional
  non-secret `email` hint.
- **`INVITE_EMAIL_MISMATCH` carries the invited address** (`details.invitedEmail`). This leaks
  nothing: whoever holds the emailed token already has the address, and without it the wrong-account
  case can only say "this was sent to another address", which does not tell the person which
  account to sign in as. It must NOT carry the org's name — a non-member learns nothing else.
- **Request bodies:** `POST /api/orgs` takes `{ name }` (not register's `organisationName`),
  `POST /api/orgs/:id/invites` takes `{ email, role }`, `PATCH .../members/:userId` takes
  `{ role }`, `POST /api/invites/accept` takes `{ token }`.
- **Responses** keep the house envelope `{ data: … }`. The accept response carries `orgId`,
  `orgName` and `role` so the dashboard can offer to switch straight into the org; without `orgId`
  it falls back to the org picker. A created invite may carry `acceptUrl`, shown once; if it does
  not, the email is the only path, which the UI handles.
- **Member rows** must carry `userId` (or `user_id`), `email` and `role`; a row without an
  identifier is dropped by the client rather than rendered unusable.
- **`MEMBERSHIP_REVOKED` means two different things and the status code is what distinguishes
  them.** On a normal request it is `403` and the dashboard sends the person to the org picker
  (they still hold a session). On `POST /api/auth/refresh` it is `401` with the family revoked and
  the cookie cleared — there is no credential left, so the only destination is sign-in. Lane A
  implemented the second; do not "fix" the dashboard to route a 401 to the picker.
- **A missing endpoint must stay distinguishable from a missing row.** The unmounted-route 404 body
  is Hono's `app.notFound` (`{ "error": "Not found" }`), while a route's own 404 is
  `{ "error": "NOT_FOUND", … }`. The dashboard uses exactly that difference to degrade to "one
  organisation, switching unavailable" instead of showing an error. Do not change the
  `app.notFound` body to SCREAMING_SNAKE.

- `POST /api/orgs/:id/invites` (admin) — create; emails a single-use link. The token is random
  (`crypto.getRandomValues`), returned once, stored only as a SHA-256 hash, and expires in 7 days.
- `GET /api/orgs/:id/invites` (admin) — open invites; never the token.
- `DELETE /api/orgs/:id/invites/:inviteId` (admin) — revoke.
- `POST /api/invites/accept` — authenticated. The signed-in user's **verified** email must equal
  the invite's email (case-insensitive) or the answer is 403 `INVITE_EMAIL_MISMATCH`: an invite
  is to an address, not a bearer ticket. Accepting inserts the membership and marks the invite
  accepted in one batch; it does **not** switch the caller's org (the dashboard calls switch).
- `GET /api/orgs/:id/members`, `PATCH .../members/:userId` (role), `DELETE .../members/:userId`.
  Refuse removing or demoting the last `owner` (`LAST_OWNER`); a member removing themselves is
  allowed unless they are that last owner. Every one audited against the org.
- **Removing a member must also delete that org's credentials for them, in the same `batch()` as the
  membership delete** (added by Lane A, which built the fail-closed paths these rely on):
  `DELETE FROM refresh_tokens WHERE user_id = ? AND org_id = ?` and
  `UPDATE api_keys SET revoked_at = …, revoked_reason = 'membership_removed' WHERE user_id = ? AND org_id = ?`.
  Without it, removal is only *eventually* effective: Lane A makes a refresh fail closed with
  `MEMBERSHIP_REVOKED` and an API key fail closed with `KEY_ORG_UNRESOLVED`, so nothing is authorised
  after removal — but the rows linger, the access token already issued stays valid for up to its 15
  minutes, and an operator reading `api_keys` cannot tell which keys are dead. Revoking at removal
  time makes it immediate and legible, and is the only part of principle 2 that Lane A could not close
  from its own side.
- Invite email: a new template beside the existing ones, no secret material in it beyond the
  single-use token, and it honours the per-kind email budget (`kind: 'invite'`).

## Lane C — dashboard (web)

- An explicit org switcher in the shell, fed by `GET /api/orgs`; switching calls
  `POST /api/orgs/:id/switch` and then refetches, because every list is org-scoped.
- The current org is visible at all times. It is read from the token/`/api/orgs`, never guessed
  from local storage, and a `MEMBERSHIP_REVOKED` or `NOT_A_MEMBER` answer sends the user back to
  org selection rather than showing an empty project list.
- Members page: list, invite (admin), revoke invite, change role, remove, with the `LAST_OWNER`
  refusal explained rather than shown as a generic error.
- An accept-invite page for the emailed link: signed out → sign in or register first, then accept;
  wrong account → say which address the invite is for, and offer to sign out.

## Out of scope here (tracked separately)

- CLI org selection. `hv` stores one token; after this lands a token names its org, so the CLI
  needs an `--org`/`hv orgs use` before a CLI user can work in a second org. Not needed for a
  single-org pilot client.
- SSO / domain-based auto-join, seat counting and billing (#81's plan, Phase 4).
- The last-member org deletion question (#81) stays open; this change only refuses the removal
  that would leave an org with no owner.
