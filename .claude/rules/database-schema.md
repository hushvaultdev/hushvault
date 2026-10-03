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
// ID: text, from createPrefixedId(); never an integer auto-increment
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
- Prefer idempotent statements (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`).
  SQLite has no `ADD COLUMN IF NOT EXISTS`, so an `ALTER TABLE ... ADD COLUMN` migration is
  **not** re-runnable — which is fine, because `wrangler d1 migrations apply` tracks which
  files have run. Do not pretend otherwise in a file header.

**Always apply with `migrations apply`, never `d1 execute --file=`.** `execute` has no tracking,
so running it twice re-applies the file and breaks the database:

```bash
# local
wrangler d1 migrations apply DB --local
# dev / production (the binding name is DB, not the database name)
wrangler d1 migrations apply DB --remote --env dev
wrangler d1 migrations apply DB --remote --env production
```

### Rebuilding a table

SQLite cannot alter a foreign key or a CHECK constraint, so the table must be rebuilt. Two rules,
both learned the hard way:

1. **Rename first, then create, then copy, then drop.** The reverse order (drop the original,
   rename the copy into place) has a window where a partial apply leaves no table at all, and the
   retry's first statement drops the only surviving copy. `0010_integration_connections.sql` does
   it the wrong way round; do not copy it.
2. **Watch what RENAME does to other tables.** `ALTER TABLE x RENAME TO x_old` rewrites every
   other table's `REFERENCES x` to `REFERENCES x_old`, so dropping `x_old` afterwards dangles
   those foreign keys. D1 documents `PRAGMA defer_foreign_keys = true` for migrations, but not
   `PRAGMA foreign_keys` or `PRAGMA legacy_alter_table` — so verify against D1 before relying on
   either, and prefer not rebuilding a referenced table at all.

## Query Patterns

Queries are raw D1 prepared statements. Drizzle is imported **only** by `schema.ts`, for the table
definitions; no route constructs a `drizzle()` instance, and `schema.ts` is documentation of the
schema rather than the thing that generates it (the SQL migrations are authoritative, and the two
have drifted — see issue tracking).

Every user value is bound. Interpolation into SQL is allowed only for fixed internal fragments,
such as a column list or a known table name.

```typescript
// Select
const secret = await c.env.DB.prepare(
  'SELECT s.id, s.name FROM secrets s INNER JOIN projects p ON p.id = s.project_id'
  + ' WHERE s.id = ? AND p.org_id = ? LIMIT 1',
).bind(id, auth.orgId).first<{ id: string; name: string }>()

// Insert
await c.env.DB.prepare('INSERT INTO secrets (id, name, created_at) VALUES (?, ?, ?)')
  .bind(createPrefixedId('sec'), name, new Date().toISOString()).run()

// Several statements that must land together
await c.env.DB.batch([historyInsert, secretUpdate])
```

`meta.changes` is documented by D1 as a rough indication; do not rely on it for correctness.
Where a write must be confirmed, read the row back.

## KV Storage (Encrypted Secrets)

KV key format: `secret:{secretId}:{version}`
KV value: JSON `{ encryptedValue: string, wrappedDek: string }`

D1 stores metadata only (id, key name, projectId, wrappedDek, keyVersion).
KV stores the encrypted value blob.
