// Guards issue #88: apps/api/src/db/schema.ts is documentation of the schema, and the SQL files in
// apps/api/migrations are what actually ships. Nothing at runtime reads the Drizzle tables, so the
// two drifted silently — three whole tables, four columns, a column type and a dozen indexes.
//
// This replays every migration into an in-memory SQLite (via the normal test harness) and diffs the
// real schema against the Drizzle one: table set, and per table the columns, primary key, unique
// constraints, foreign keys and indexes. A migration that lands without a matching edit to
// schema.ts fails here.
import { describe, expect, it } from 'vitest'
import { SQL, is } from 'drizzle-orm'
import { SQLiteTable, SQLiteSyncDialect, getTableConfig } from 'drizzle-orm/sqlite-core'
import { createTestEnv } from './helpers/env'
import * as schema from '../src/db/schema'

const dialect = new SQLiteSyncDialect()

// Replayed once for the whole file: every migration applied in order, nothing else.
const db = createTestEnv().DB.sqlite

const drizzleTables = Object.values(schema)
  .filter((v): v is SQLiteTable => is(v, SQLiteTable))
  .map((table) => getTableConfig(table))

/**
 * Both sides of every SQL-text comparison go through this, so the comparison is about tokens rather
 * than how the DDL happens to be laid out: identifier quoting, keyword case, line breaks and the
 * spacing around brackets and commas all differ between a hand-written migration and rendered SQL.
 */
function normaliseSql(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('"', '')
    .replaceAll('`', '')
    .replace(/if not exists /g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s+\(/g, '(')
    .replace(/\s+\)/g, ')')
    .trim()
}

/** A column default as SQLite records it: a SQL literal, or null for no default. */
function drizzleDefault(column: { hasDefault: boolean; default: unknown }): string | null {
  if (!column.hasDefault) return null
  const value = column.default
  if (typeof value === 'string') return `'${value}'`
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number') return String(value)
  throw new Error(`unsupported default ${String(value)} — teach this test how to render it`)
}

type TableInfoRow = { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }
type IndexListRow = { name: string; origin: string }
type ForeignKeyRow = { table: string; from: string; to: string; on_delete: string }

describe('schema.ts matches the migrations', () => {
  it('declares exactly the tables the migrations create', () => {
    const real = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as { name: string }[]
    expect(drizzleTables.map((t) => t.name).sort()).toEqual(real.map((r) => r.name))
  })

  it('declares the same columns, types, nullability and defaults', () => {
    for (const { name: tableName, columns } of drizzleTables) {
      const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[]
      const real = info
        .map((c) => ({
          name: c.name,
          type: c.type.toUpperCase(),
          // SQLite only implies NOT NULL for an INTEGER PRIMARY KEY, so `id TEXT PRIMARY KEY`
          // reports as nullable while `id TEXT PRIMARY KEY NOT NULL` does not — a distinction with
          // no effect that Drizzle cannot make either (`.primaryKey()` always sets notNull).
          notNull: c.notnull === 1 || c.pk > 0,
          default: c.dflt_value,
        }))
        // Physical order is not compared: the ALTER migrations append their columns to the end of
        // the real table, while schema.ts groups them with the columns they belong with.
        .sort((a, b) => a.name.localeCompare(b.name))
      const declared = columns
        .map((c) => ({
          name: c.name,
          type: c.getSQLType().toUpperCase(),
          notNull: c.notNull,
          default: drizzleDefault(c),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      expect(declared, tableName).toEqual(real)
    }
  })

  it('declares the same primary keys and column-level unique constraints', () => {
    for (const { name: tableName, columns, primaryKeys } of drizzleTables) {
      const info = db.prepare(`PRAGMA table_info(${tableName})`).all() as TableInfoRow[]
      const realPk = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
      const declaredPk = primaryKeys.length > 0
        ? primaryKeys[0]!.columns.map((c) => c.name)
        : columns.filter((c) => c.primary).map((c) => c.name)
      expect(declaredPk, `${tableName} primary key`).toEqual(realPk)

      // Inline UNIQUE columns show up as an implicit index with origin 'u' ('pk' is the primary
      // key's, 'c' a CREATE INDEX). Drizzle spells the same thing as `.unique()` on the column.
      const realUnique = (db.prepare(`PRAGMA index_list(${tableName})`).all() as IndexListRow[])
        .filter((i) => i.origin === 'u')
        .flatMap((i) => (db.prepare(`PRAGMA index_info('${i.name}')`).all() as { name: string }[]).map((c) => c.name))
        .sort()
      expect(columns.filter((c) => c.isUnique).map((c) => c.name).sort(), `${tableName} unique`).toEqual(realUnique)
    }
  })

  it('declares the same foreign keys, including their ON DELETE action', () => {
    for (const { name: tableName, foreignKeys } of drizzleTables) {
      const real = (db.prepare(`PRAGMA foreign_key_list(${tableName})`).all() as ForeignKeyRow[])
        .map((fk) => `${fk.from} -> ${fk.table}.${fk.to} on delete ${fk.on_delete.toLowerCase()}`)
        .sort()
      const declared = foreignKeys
        .map((fk) => {
          const ref = fk.reference()
          const target = getTableConfig(ref.foreignTable).name
          // SQLite reports the absence of a clause as NO ACTION; Drizzle leaves onDelete undefined.
          return `${ref.columns.map((c) => c.name).join(',')} -> ${target}.${ref.foreignColumns
            .map((c) => c.name)
            .join(',')} on delete ${fk.onDelete ?? 'no action'}`
        })
        .sort()
      expect(declared, tableName).toEqual(real)
    }
  })

  it('declares the same indexes, down to column order, direction and partiality', () => {
    // Compared as rendered DDL rather than through PRAGMA index_info, because that is the only
    // place a partial index's WHERE clause and an expression column's text survive. It also covers
    // the two definitions #88 found drifting: sync_runs_target_idx is descending and
    // sync_runs_retry_idx is partial, neither of which the file said.
    const real = new Map(
      (db
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
        .all() as { name: string; sql: string }[])
        .map((row) => [row.name, normaliseSql(row.sql)]),
    )
    const declared = new Map(
      drizzleTables.flatMap(({ name: tableName, indexes }) =>
        indexes.map((idx) => {
          const { name, columns, unique, where } = idx.config
          const parts = columns.map((col) =>
            is(col, SQL) ? dialect.sqlToQuery(col, 'indexes').sql : col.name,
          )
          const clause = where ? ` WHERE ${dialect.sqlToQuery(where, 'indexes').sql}` : ''
          const kind = unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX'
          return [name, normaliseSql(`${kind} ${name} ON ${tableName} (${parts.join(', ')})${clause}`)] as const
        }),
      ),
    )
    expect([...declared.keys()].sort()).toEqual([...real.keys()].sort())
    for (const [name, ddl] of declared) expect(ddl, name).toEqual(real.get(name))
  })

  it('declares the CHECK constraints the migrations wrote', () => {
    // SQLite has no PRAGMA for CHECK constraints, so these are matched against the CREATE TABLE
    // text. Drizzle's column `enum` is a TypeScript-only narrowing that emits no SQL at all, which
    // is exactly why it can fall out of step with the migration's CHECK without anything failing.
    for (const { name: tableName, columns, checks } of drizzleTables) {
      const ddl = normaliseSql(
        (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql: string }).sql,
      )
      for (const column of columns) {
        const values = column.enumValues
        if (!values || values.length === 0) continue
        const expected = normaliseSql(`CHECK (${column.name} IN (${values.map((v) => `'${v}'`).join(', ')}))`)
        expect(ddl, `${tableName}.${column.name} enum`).toContain(expected)
      }
      for (const constraint of checks) {
        const expected = normaliseSql(`CHECK (${dialect.sqlToQuery(constraint.value).sql})`)
        expect(ddl, `${tableName} ${constraint.name}`).toContain(expected)
      }
    }
  })
})
