# Audit Log & Compliance

**Priority:** P1 — required for paid plans, differentiator vs Doppler
**Status:** Schema exists, implementation pending

---

## Doppler Gap We're Filling

Doppler's audit log **does not include CLI secret injection events**.
HushVault logs every `hushvault run` invocation as `secret.bulk_inject` with:
- List of secret **names** accessed (never values)
- Actor: API key ID + environment
- Timestamp, IP, user agent

This is a genuine differentiator for security-conscious teams.

---

## Event Taxonomy

Every event uses the format `resource.action`:

```typescript
type AuditAction =
  // Secrets
  | 'secret.read'           // individual secret fetched
  | 'secret.bulk_inject'    // CLI run / GitHub Action — N secrets fetched
  | 'secret.create'
  | 'secret.update'
  | 'secret.delete'
  // Projects & Environments
  | 'project.create' | 'project.delete'
  | 'environment.create' | 'environment.delete'
  // Members
  | 'member.invite' | 'member.accept' | 'member.remove' | 'member.role_change'
  // Auth
  | 'auth.login' | 'auth.login_failed' | 'auth.logout' | 'auth.api_key_create' | 'auth.api_key_revoke'
  // Org / Billing
  | 'org.plan_change' | 'org.settings_change'
  // Share links
  | 'share_link.create' | 'share_link.view' | 'share_link.expire'
```

---

## Write Path

Non-blocking fire-and-forget from every route handler:

```typescript
// apps/api/src/lib/audit.ts
import { drizzle } from 'drizzle-orm/d1'
import { auditLog } from '../db/schema.js'
import { nanoid } from 'nanoid'
import type { Context } from 'hono'
import type { Env } from '../index.js'

export function writeAuditLog(
  c: Context<{ Bindings: Env }>,
  event: {
    action: AuditAction
    resourceType: string
    resourceId: string
    metadata?: Record<string, unknown>  // key names only, never values
  }
) {
  const user = c.get('user')
  const db = drizzle(c.env.DB)

  // Non-blocking — never delays the response
  c.executionCtx.waitUntil(
    db.insert(auditLog).values({
      id: nanoid(),
      orgId: user.orgId,
      actorId: user.id,
      actorType: user.type ?? 'user',  // 'user' | 'api_key' | 'system'
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      metadata: JSON.stringify(event.metadata ?? {}),
      ip: c.req.header('cf-connecting-ip') ?? '',
      userAgent: c.req.header('user-agent') ?? '',
      timestamp: new Date().toISOString(),
    }).execute()
  )
}
```

Usage in route handlers:
```typescript
writeAuditLog(c, {
  action: 'secret.create',
  resourceType: 'secret',
  resourceId: created.id,
  metadata: { key: created.key, envId: created.envId }
  // Never include: value, encryptedValue, wrappedDek
})
```

---

## Read / Query API

```
GET /api/audit?from=2026-01-01&to=2026-03-31&action=secret.delete&actorId=usr_xyz&cursor=xxx
```

Response (cursor-paginated, 100 rows per page):
```json
{
  "data": [
    {
      "id": "...",
      "action": "secret.delete",
      "actorId": "usr_xyz",
      "actorEmail": "user@example.com",
      "resourceType": "secret",
      "resourceId": "sec_abc",
      "metadata": { "key": "DATABASE_URL" },
      "ip": "1.2.3.4",
      "timestamp": "2026-03-15T10:30:00Z"
    }
  ],
  "nextCursor": "cursor_xyz",
  "total": 1240
}
```

Retention enforced per plan tier — queries automatically filter to `timestamp > now - auditLogDays`.

---

## Retention Enforcement (Cron Trigger)

```typescript
// apps/api/src/cron/purge-audit-log.ts
// Runs daily via Cloudflare Workers Cron (see wrangler.toml)
export async function purgeAuditLog(env: Env) {
  const db = drizzle(env.DB)

  // Get all orgs with their plan's retention period
  const orgs = await db.select({
    id: organisations.id,
    plan: organisations.plan,
  }).from(organisations).all()

  for (const org of orgs) {
    const retentionDays = PLANS[org.plan].limits.auditLogDays
    if (retentionDays === -1) continue  // enterprise: never purge

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - retentionDays)

    await db.delete(auditLog).where(
      and(
        eq(auditLog.orgId, org.id),
        sql`timestamp < ${cutoff.toISOString()}`
      )
    )
  }
}
```

**wrangler.toml addition:**
```toml
[triggers]
crons = ["0 2 * * *"]  # 2am UTC daily
```

---

## Compliance Export

`GET /api/audit/export?format=csv&from=2026-01-01&to=2026-03-31`

Available on Team/Enterprise plans (`complianceExport` feature flag).
Returns a CSV or JSON file attachment. Used for SOC 2 evidence, insurance audits.

---

## Immutability Guarantee

Audit log rows are INSERT-only in application code.
Only the daily cron purge touches old rows (DELETE by age, never UPDATE).
Document this in security posture for SOC 2 reviewers.
