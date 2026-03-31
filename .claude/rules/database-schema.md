---
description: Drizzle ORM + D1 schema conventions and migration rules
globs:
  - "apps/api/src/db/**/*.ts"
  - "apps/api/migrations/**/*.sql"
---

# Database Schema Rules

## Schema Location

All table definitions live in `apps/api/src/db/schema.ts`.
Import with: `import { secrets, environments, projects } from '../db/schema.js'`

## Table Conventions

```typescript
// ID: text nanoid, never integer auto-increment
id: text('id').primaryKey()

// Timestamps: ISO string, not unix timestamp
createdAt: text('created_at').notNull().default(sql`(datetime('now'))`)
updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`)

// Foreign keys: text references, explicit .references()
projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' })

// JSON columns: store as text, parse in application layer
dependencies: text('dependencies').default('[]')  // JSON array
```

## Migrations

- **Never modify D1 schema directly** — always create a migration
- Migrations live in `apps/api/migrations/`
- Naming: `NNNN_description.sql` (e.g., `0001_add_share_links.sql`)
- Migrations must be idempotent: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`

Apply locally:
```bash
wrangler d1 execute hushvault-db --local --file=migrations/NNNN_description.sql
```

Apply to production:
```bash
wrangler d1 execute hushvault-db --file=migrations/NNNN_description.sql
```

## Drizzle Query Patterns

```typescript
import { drizzle } from 'drizzle-orm/d1'
import { eq, and } from 'drizzle-orm'
import { secrets } from '../db/schema.js'

const db = drizzle(c.env.DB)

// Select
const secret = await db.select().from(secrets).where(
  and(eq(secrets.id, id), eq(secrets.projectId, projectId))
).get()

// Insert
const created = await db.insert(secrets).values({ id: nanoid(), ...data }).returning().get()

// Update
await db.update(secrets).set({ updatedAt: new Date().toISOString() }).where(eq(secrets.id, id))

// Delete
await db.delete(secrets).where(eq(secrets.id, id))
```

## KV Storage (Encrypted Secrets)

KV key format: `secret:{secretId}:{version}`
KV value: JSON `{ encryptedValue: string, wrappedDek: string }`

D1 stores metadata only (id, key name, projectId, wrappedDek, keyVersion).
KV stores the encrypted value blob.
