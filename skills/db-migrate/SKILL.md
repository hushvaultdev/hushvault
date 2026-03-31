# DB Migrate Skill

Create and apply Cloudflare D1 migrations for HushVault.

## When to Use

Use `/db-migrate` when:
- Adding a new table to the schema
- Adding columns to an existing table
- Creating an index for a query that's becoming slow
- Renaming columns (requires multi-step migration)

## Workflow

### 1. Update the Drizzle Schema

Edit `apps/api/src/db/schema.ts` with your changes.

### 2. Generate the Migration SQL

```bash
cd apps/api
npx drizzle-kit generate
```

This creates a new file in `drizzle/` — review it before applying.

### 3. Create a Named Migration File

Copy the generated SQL to `apps/api/migrations/NNNN_description.sql`.
Number sequentially (e.g., `0002_add_audit_log.sql`).

Make it idempotent:
```sql
-- Good
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Adding a column (SQLite doesn't support IF NOT EXISTS for ALTER)
-- Wrap in a try-catch at application level, or check first:
ALTER TABLE secrets ADD COLUMN tags TEXT DEFAULT '[]';
```

### 4. Test Locally

```bash
# Apply to local D1 (wrangler creates a local SQLite file)
wrangler d1 execute hushvault-db --local --file=migrations/NNNN_description.sql

# Verify schema
wrangler d1 execute hushvault-db --local --command="PRAGMA table_info(table_name);"
```

### 5. Commit the Migration

```bash
git add apps/api/migrations/NNNN_description.sql apps/api/src/db/schema.ts
git commit -m "feat: add [description] migration"
```

### 6. Apply to Production (at deploy time)

```bash
wrangler d1 execute hushvault-db --file=migrations/NNNN_description.sql
```

## SQLite Constraints (D1)

- `ALTER TABLE` only supports `ADD COLUMN` (no `DROP COLUMN`, `RENAME COLUMN` in older SQLite)
- For column renames: create new column, backfill, drop old (3-step migration)
- No foreign key enforcement by default — enable with `PRAGMA foreign_keys = ON` per connection
- JSON stored as `TEXT` — use `JSON_EXTRACT()` in SQL or parse in application layer

## Schema File Location

`apps/api/src/db/schema.ts` — single source of truth for all table definitions.
