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

SQLite cannot alter a foreign key or a CHECK constraint, so the table must be rebuilt.

**First: is anything else's `REFERENCES` pointing at this table?**

```bash
grep -rn "REFERENCES <table>" apps/api/migrations/
```

#### If nothing references it — rename first

Rename, create, copy, drop. Never the reverse (drop the original, rename the copy into place):
that has a window where a partial apply leaves no table at all, and the retry's first statement
drops the only surviving copy. `0010_integration_connections.sql` does it the wrong way round.

#### If something references it — do not rebuild it

There is **no safe ordering**, and no PRAGMA on D1 to make one. This was established empirically
against the dev database and reproduced locally (issue #81):

- `ALTER TABLE x RENAME TO x_old` rewrites every other table's `REFERENCES x` into
  `REFERENCES x_old`. Then `DROP TABLE x_old` runs an implicit `DELETE FROM`, which **fires the
  children's `ON DELETE CASCADE` and deletes every child row** — and leaves the rewritten
  foreign keys dangling. Every statement returns success. There is no error to notice.
  Verified: a parent with two cascading children ends the rebuild with zero children and
  `no such table: main.parent_old` on the next write.
- Drop-first preserves the children, because references resolve by **name** and the final rename
  restores it — but it keeps the destructive-retry window above.
- `PRAGMA foreign_keys = OFF` is **silently ignored by D1**: it is accepted and still reads back
  `1`.
- `PRAGMA legacy_alter_table = ON` is accepted by D1, **reads back `1`, and is not honoured** —
  the rename still rewrites the child. This is the worst of the three, because it looks like it
  worked.
- `PRAGMA defer_foreign_keys = true` *is* honoured, but only defers the check to commit. A real
  end-state violation then makes D1 **reset the database and roll back to its last known good
  state**, which is worse than an immediate error. It helps only where the violation is
  transient and repaired before commit — a rebuild is not that case.

So: change the application, not the schema. A nullable column can get `ON DELETE SET NULL`
semantics by having the deleting code null it first, inside the same `batch()` as the delete.
A `NO ACTION` foreign key is then a **safety property**, not a bug: it guarantees no code path
can remove the parent while rows still reference it.

In this schema that applies to `integration_connections`, `sync_targets` (referenced by
`sync_items`, `sync_runs` and `sync_outbox`, all cascading) and transitively anything below
them. `oidc_repo_rules` is referenced by nothing and would be safe to rebuild.

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
await c.env.DB.batch([auditInsert, secretUpdate])
```

`meta.changes` is documented by D1 as a rough indication; do not rely on it for correctness.
Where a write must be confirmed, read the row back.

## KV Storage (Encrypted Secrets)

KV key format: `secret:{secretId}:{blobRev}` — `secret:{secretId}` at revision 0 (pre-0014).
KV value: the plain string `base64(iv):base64(ciphertext+tag)`, not JSON. The wrapped DEK is in D1.

D1 stores metadata only (id, name, projectId, wrappedDek, keyVersion, encVersion, blobRev).
KV stores the encrypted value blob.

**A blob key is written once and never overwritten.** A value change writes
`secret:{id}:{blobRev+1}` and D1 then moves the pointer, so a failed D1 write leaves an orphan
rather than a secret whose ciphertext and wrapped DEK disagree (migration 0014). Superseded
revisions stay in KV but are undecryptable: only the current wrapped DEK is kept, so no previous
value is recoverable (issue #84 dropped `secret_history`; see docs/API.md). Do not add a table
that retains superseded wrapped DEKs without also building the retention and purge for it.
