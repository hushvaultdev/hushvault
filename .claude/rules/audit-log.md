# Audit Log Rules

The `audit_log` table is the one trail a security auditor reads. `.claude/rules/crypto-security.md`
and `.claude/rules/database-schema.md` still apply to it in full; this file is only about the
`metadata` column (migration 0019, issue #96).

## `audit_log.metadata`

`metadata` is a nullable `TEXT` column holding a JSON object, written only through the shared audit
writer (`writeAuditLog` / `auditLogStatement` in `apps/api/src/lib/security.ts`, entry field
`metadata`). It exists so a row can record *what* an event changed, not merely that it changed — a
role change files `{ "from": <old role>, "to": <new role> }`.

### The rule (never break)

`audit_log.metadata` holds a **small, bounded, non-secret** JSON object of **fixed keys set by the
server**. Specifically:

- **Non-secret only.** NEVER a secret value, a DEK, a wrapped DEK, a master/KEK, an API key, a
  token, an invite token or hash, a password or password hash, a session value, or anything derived
  from them. If a value could carry plaintext secret material, it does not go here. This is the same
  bar as every structured log line (see `crypto-security.md` and `logEvent`).
- **Not caller-supplied free text.** NEVER a request body field, a user-typed name, note, label,
  description, email body, or any other free-text the caller controls. Values are chosen by the
  server from a known, finite vocabulary — role names, resource ids already stored in the row's own
  columns, counts, enum labels, boolean flags. An email address is an established audit field
  elsewhere; prefer role/id only, and never put free text in `metadata` to get around this.
- **Bounded shape.** A flat object whose values are `string | number | boolean | null` — the
  `AuditMetadata` type in `security.ts`. No nested objects or arrays (a nested object is the shape a
  secret value would eventually arrive wrapped in); `serialiseAuditMetadata` throws on a
  non-primitive value, so the type is backed by a runtime guard at the one chokepoint. Keep it a
  handful of small fields, not an event dump.
- **Fixed keys.** The key set for a given `action` is decided in code, not by input.

Why this matters: the column is trivial; the rule is the point of issue #96. Without it, `metadata`
becomes the place a plaintext secret eventually gets logged — it is a general-purpose JSON bag
attached to the table auditors trust most.

### What populates it today

| action | metadata |
|--------|----------|
| `org.member.role_change` | `{ from, to }` — old and new role |
| `org.member.remove` / `org.member.leave` | `{ role }` — role held when removed/left |
| `org.invite.create` | `{ role }` — invited role |
| `org.invite.accept` | `{ role }` — role actually granted (the existing role if already a member) |

Every other action leaves `metadata` NULL. Do not add a secret-bearing or free-text value to any
new call site; if a new event needs context, add fixed non-secret keys and document them here and in
`docs/API.md` § Audit actions.
