# Multi-Tenancy Isolation

**Priority:** P0 — must be read before implementing any route handler
**Status:** Design approved, all routes pending implementation

---

## Core Rule

**Never trust client-supplied resource IDs without resolving through org membership.**

Every D1 query on org-owned resources must join through the authenticated user's `orgId`.
The `orgId` comes from the JWT payload — never from the request body or URL params.

---

## The Confused Deputy Attack

If a route does:
```typescript
// WRONG — user in org A can supply a secretId belonging to org B
const secret = await db.select().from(secrets).where(eq(secrets.id, secretId)).get()
```

A user in org A can supply `secretId=secret_from_org_B` and read another tenant's secret.

**Always do:**
```typescript
// CORRECT — join through project → environment → org
const secret = await db.select()
  .from(secrets)
  .innerJoin(environments, eq(secrets.envId, environments.id))
  .innerJoin(projects, eq(environments.projectId, projects.id))
  .where(and(
    eq(secrets.id, secretId),
    eq(projects.orgId, user.orgId)   // ← enforces org scope
  ))
  .get()

if (!secret) return c.json({ error: 'NOT_FOUND', message: 'Secret not found' }, 404)
// Never: 403 (reveals existence). Always: 404 for non-existent or wrong tenant.
```

**Rule:** Always return 404 (not 403) for cross-tenant access — never reveal that a resource exists in another org.

---

## KV Key Namespacing

**Current (wrong):** `secret:{secretId}` — collides across tenants if IDs are guessable.
**Required:** `secret:{orgId}:{secretId}` — guarantees isolation even if KV ACLs are misconfigured.

```typescript
// apps/api/src/routes/secrets.ts
const kvKey = `secret:${user.orgId}:${secretId}`
const encrypted = await c.env.SECRETS_KV.get(kvKey)
```

Also applies to plan cache: `plan:{orgId}` (already correct in subscription plan).

---

## Auth Middleware Contract

`requireAuth` middleware must attach both `userId` AND `orgId` to context:

```typescript
declare module 'hono' {
  interface ContextVariableMap {
    user: { id: string; orgId: string; role: 'owner' | 'admin' | 'member' | 'viewer' }
  }
}
```

Every protected route accesses `c.get('user')` — never `c.req.header('x-org-id')` or body params.

---

## RBAC Matrix

| Operation | owner | admin | member | viewer |
|-----------|-------|-------|--------|--------|
| Read secrets | ✅ | ✅ | ✅ | ✅ |
| Write secrets | ✅ | ✅ | ✅ | ❌ |
| Delete secrets | ✅ | ✅ | ❌ | ❌ |
| Manage environments | ✅ | ✅ | ❌ | ❌ |
| Invite members | ✅ | ✅ | ❌ | ❌ |
| Remove members | ✅ | ❌ | ❌ | ❌ |
| Billing / plan | ✅ | ❌ | ❌ | ❌ |
| API keys | ✅ | ✅ | Own only | ❌ |

RBAC enforcement: `requireRole('admin')` middleware after `requireAuth`.
RBAC is a Team plan feature — Free/Pro use simplified owner/member only.

---

## Encryption Isolation

One `ENCRYPTION_MASTER_KEY` for all tenants. This is acceptable because:
- Each secret has its own random DEK
- The master key wraps DEKs, not values directly
- A compromised DEK exposes one secret, not all tenants
- Master key lives in Wrangler secrets (never in D1 or KV)

**When to move to per-org KEKs:** If enterprise customers require HSM-backed or customer-managed keys (BYOK). This is a v2/Enterprise feature — document as roadmap.

---

## Org Deletion Cascade

D1 `ON DELETE CASCADE` handles relational data automatically.
**KV does not cascade** — must be handled explicitly.

When `DELETE /api/orgs/:id` is called:
```typescript
// 1. List all secrets for this org
const orgSecrets = await db.select({ id: secrets.id })
  .from(secrets)
  .innerJoin(environments, eq(secrets.envId, environments.id))
  .innerJoin(projects, eq(environments.projectId, projects.id))
  .where(eq(projects.orgId, orgId))
  .all()

// 2. Delete from KV
await Promise.all(
  orgSecrets.map(s => c.env.SECRETS_KV.delete(`secret:${orgId}:${s.id}`))
)

// 3. Delete from D1 (cascades to all related tables)
await db.delete(organisations).where(eq(organisations.id, orgId))
```

For large orgs: offload KV deletion to a background task via `ctx.waitUntil()`.

---

## Share Links — Cross-Org by Design

Share links are intentionally org-agnostic: any holder of the URL can view the secret payload. This is safe because:
- Payload is encrypted client-side; server stores only ciphertext
- Encryption key is in the URL fragment — never sent to server
- Server never decrypts the payload — zero-knowledge

Access control on share links: `maxViews` and `expiresAt` enforced by server. No org membership required to view.

---

## Checklist for Every New Route

Before shipping any route handler, verify:
- [ ] `user.orgId` comes from JWT context, not request params
- [ ] Every D1 query on org-owned resources includes `WHERE org_id = :orgId`
- [ ] Cross-tenant access returns 404, never 403
- [ ] KV keys use `{orgId}:{resourceId}` prefix
- [ ] Role requirement documented and enforced with `requireRole()` middleware
