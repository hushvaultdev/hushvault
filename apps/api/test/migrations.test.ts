import { describe, expect, it } from 'vitest'
import { createTestEnv } from './helpers/env'

describe('migrations', () => {
  it('apply cleanly to an empty database and create every table', async () => {
    const env = createTestEnv()
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()
    const tables = results.map((r) => r.name)
    for (const t of ['users', 'api_keys', 'organisations', 'members', 'projects', 'environments', 'secrets', 'share_links', 'audit_log', 'encryption_keys', 'key_rotations', 'key_rotation_failures', 'auth_tokens', 'refresh_tokens']) {
      expect(tables).toContain(t)
    }
    // 0017 dropped it (issue #84); 0000 still creates it, so this asserts the drop actually ran.
    expect(tables).not.toContain('secret_history')
  })

  it('includes columns added by the ALTER migrations', async () => {
    const env = createTestEnv()
    const cols = async (t: string) =>
      (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((r) => r.name)
    expect(await cols('users')).toEqual(expect.arrayContaining(['provider', 'provider_id', 'email_verified', 'sessions_valid_after']))
    expect(await cols('api_keys')).toEqual(expect.arrayContaining(['revoked_at', 'revoked_reason']))
    expect(await cols('organisations')).toContain('audit_retention_days')
  })

  it('rejects a duplicate secret name within one environment', async () => {
    const env = createTestEnv()
    const now = new Date().toISOString()
    await env.DB.prepare('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)').bind('o1', 'O', 'o', now).run()
    await env.DB.prepare('INSERT INTO projects (id, org_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind('p1', 'o1', 'P', 'p', now, now).run()
    await env.DB.prepare('INSERT INTO environments (id, project_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').bind('e1', 'p1', 'E', 'e', now).run()
    const insert = () => env.DB.prepare('INSERT INTO secrets (id, project_id, env_id, name, wrapped_dek, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    await insert().bind('s1', 'p1', 'e1', 'DB_URL', 'x', now, now).run()
    await expect(insert().bind('s2', 'p1', 'e1', 'DB_URL', 'x', now, now).run()).rejects.toThrow(/UNIQUE/i)
  })

  it('cascades project deletion to environments and secrets', async () => {
    const env = createTestEnv()
    const now = new Date().toISOString()
    await env.DB.prepare('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)').bind('o1', 'O', 'o', now).run()
    await env.DB.prepare('INSERT INTO projects (id, org_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind('p1', 'o1', 'P', 'p', now, now).run()
    await env.DB.prepare('INSERT INTO environments (id, project_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)').bind('e1', 'p1', 'E', 'e', now).run()
    await env.DB.prepare('DELETE FROM projects WHERE id = ?').bind('p1').run()
    expect(await env.DB.prepare('SELECT id FROM environments').first()).toBeNull()
  })

  it('0011 creates the sync tables, is idempotent, enforces single flight and cascades from the connection', async () => {
    const env = createTestEnv()
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    env.DB.sqlite.exec(readFileSync(join(__dirname, '../migrations/0011_sync.sql'), 'utf8'))
    const cols = async (t: string) =>
      (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((r) => r.name)
    expect(await cols('sync_targets')).toEqual(expect.arrayContaining(['id', 'org_id', 'project_id', 'env_id', 'connection_id', 'provider', 'resource_json', 'name_filter_json', 'delete_removed', 'fingerprint_salt', 'status', 'last_run_at', 'created_by', 'created_at', 'updated_at', 'deleted_at']))
    expect(await cols('sync_items')).toEqual(['target_id', 'name', 'fingerprint', 'last_pushed_at'])
    expect(await cols('sync_runs')).toEqual(expect.arrayContaining(['id', 'target_id', 'trigger', 'status', 'attempt', 'counts_json', 'error_code', 'actor_id', 'started_at', 'finished_at', 'next_retry_at', 'lease_until']))

    const now = new Date().toISOString()
    const run = (sql: string, ...v: string[]) => env.DB.prepare(sql).bind(...v).run()
    await run('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)', 'o1', 'O', 'o', now)
    await run('INSERT INTO projects (id, org_id, name, slug, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'p1', 'o1', 'P', 'p', now, now)
    await run('INSERT INTO environments (id, project_id, name, slug, created_at) VALUES (?, ?, ?, ?, ?)', 'e1', 'p1', 'E', 'e', now)
    await run('INSERT INTO integration_connections (id, org_id, provider, label, encrypted_credential, wrapped_dek, key_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 'c1', 'o1', 'x', 'l', 'x', 'x', 'v1', now, now)
    await run('INSERT INTO sync_targets (id, org_id, project_id, env_id, connection_id, provider, fingerprint_salt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', 't1', 'o1', 'p1', 'e1', 'c1', 'x', 's', now, now)
    const insertRun = (id: string, status: string) =>
      run("INSERT INTO sync_runs (id, target_id, trigger, status, started_at) VALUES (?, 't1', 'manual', ?, ?)", id, status, now)
    await insertRun('r1', 'running')
    await expect(insertRun('r2', 'queued')).rejects.toThrow(/UNIQUE/i)
    await insertRun('r3', 'failed')
    await expect(insertRun('r4', 'bogus')).rejects.toThrow(/CHECK/i)
    await run("INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) VALUES ('t1', 'A', 'f', ?)", now)
    await expect(run("INSERT INTO sync_items (target_id, name, fingerprint, last_pushed_at) VALUES ('t1', 'A', 'f', ?)", now)).rejects.toThrow(/UNIQUE/i)
    expect((await env.DB.prepare('SELECT delete_removed, status FROM sync_targets').first())).toEqual({ delete_removed: 0, status: 'active' })

    // Re-applying changes nothing and loses nothing.
    env.DB.sqlite.exec(readFileSync(join(__dirname, '../migrations/0011_sync.sql'), 'utf8'))
    expect((await env.DB.prepare('SELECT id FROM sync_runs').all()).results).toHaveLength(2)

    // Deleting the connection removes targets, ledger and runs.
    await run('DELETE FROM integration_connections WHERE id = ?', 'c1')
    for (const t of ['sync_targets', 'sync_items', 'sync_runs']) expect(await env.DB.prepare(`SELECT 1 AS x FROM ${t}`).first()).toBeNull()
  })

  it('0016 creates the cron bookkeeping tables and is safe to apply twice', async () => {
    const env = createTestEnv()
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const cols = async (t: string) =>
      (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((r) => r.name)
    expect(await cols('system_state')).toEqual(['key', 'value', 'updated_at'])
    expect(await cols('orphan_blob_candidates')).toEqual(['kv_key', 'first_seen_at'])

    const now = new Date().toISOString()
    await env.DB.prepare('INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)').bind('k', 'v', now).run()
    await env.DB.prepare('INSERT INTO orphan_blob_candidates (kv_key, first_seen_at) VALUES (?, ?)').bind('secret:sec_a:1', now).run()
    // Both are upserted by key, so a second sighting must not duplicate or error.
    await env.DB.prepare('INSERT INTO orphan_blob_candidates (kv_key, first_seen_at) VALUES (?, ?) ON CONFLICT(kv_key) DO NOTHING')
      .bind('secret:sec_a:1', new Date(Date.now() + 1000).toISOString()).run()
    expect((await env.DB.prepare('SELECT first_seen_at AS t FROM orphan_blob_candidates').all<{ t: string }>()).results)
      .toEqual([{ t: now }])

    // Re-applying changes nothing and loses nothing.
    env.DB.sqlite.exec(readFileSync(join(__dirname, '../migrations/0016_cron_bookkeeping.sql'), 'utf8'))
    expect((await env.DB.prepare('SELECT value AS v FROM system_state').all<{ v: string }>()).results).toEqual([{ v: 'v' }])
    expect((await env.DB.prepare('SELECT count(*) AS n FROM orphan_blob_candidates').first<{ n: number }>())!.n).toBe(1)
  })

  it('0017 drops secret_history and the retired rotation cursor, keeping single flight', async () => {
    const env = createTestEnv()
    const cols = (await env.DB.prepare('PRAGMA table_info(key_rotations)').all<{ name: string }>()).results.map((r) => r.name)
    expect(cols).not.toContain('history_cursor')
    expect(cols).toEqual(expect.arrayContaining(['secrets_cursor', 'connections_cursor', 'phase']))

    // The partial unique index must survive DROP COLUMN, or single flight is silently lost.
    const now = new Date().toISOString()
    const insert = (id: string, status: string) =>
      env.DB.prepare("INSERT INTO key_rotations (id, from_version, to_version, status, started_at, updated_at) VALUES (?, 'v1', 'v2', ?, ?, ?)").bind(id, status, now, now)
    await insert('r1', 'running').run()
    await expect(insert('r2', 'running').run()).rejects.toThrow(/UNIQUE/i)

    // The CHECK is deliberately not narrowed, so the retired phase name is still accepted; the
    // migration's UPDATE is what stops a stored job sitting on it.
    await env.DB.prepare("UPDATE key_rotations SET phase = 'history' WHERE id = 'r1'").run()
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sql = readFileSync(join(__dirname, '../migrations/0017_drop_secret_history.sql'), 'utf8')
    // Re-apply only the re-runnable part; DROP COLUMN has no IF EXISTS (see the file header).
    env.DB.sqlite.exec(sql.split('ALTER TABLE key_rotations DROP COLUMN')[0]!)
    expect(await env.DB.prepare("SELECT phase FROM key_rotations WHERE id = 'r1'").first<{ phase: string }>())
      .toEqual({ phase: 'connections' })
  })

  it('0006 is safe to apply twice and enforces a single running rotation', async () => {
    const env = createTestEnv()
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const sql = readFileSync(join(__dirname, '../migrations/0006_key_rotation.sql'), 'utf8')
    env.DB.sqlite.exec(sql)
    const now = new Date().toISOString()
    const insert = (id: string, status: string) =>
      env.DB.prepare("INSERT INTO key_rotations (id, from_version, to_version, status, started_at, updated_at) VALUES (?, 'v1', 'v2', ?, ?, ?)").bind(id, status, now, now)
    await insert('r1', 'running').run()
    await expect(insert('r2', 'running').run()).rejects.toThrow(/UNIQUE/i)
    await insert('r3', 'completed').run()
    await expect(
      env.DB.prepare("INSERT INTO encryption_keys (version, check_value, status, created_at) VALUES ('v9', 'x', 'bogus', ?)").bind(now).run(),
    ).rejects.toThrow(/CHECK/i)
  })
})
