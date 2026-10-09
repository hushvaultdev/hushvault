import { describe, expect, it } from 'vitest'
import { createTestEnv } from './helpers/env'

describe('migrations', () => {
  it('apply cleanly to an empty database and create every table', async () => {
    const env = createTestEnv()
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()
    const tables = results.map((r) => r.name)
    for (const t of ['users', 'api_keys', 'organisations', 'members', 'projects', 'environments', 'secrets', 'share_links', 'audit_log', 'encryption_keys', 'key_rotations', 'key_rotation_failures', 'auth_tokens', 'refresh_tokens', 'org_invites']) {
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
    expect(await cols('audit_log')).toContain('metadata')
  })

  it('0019 adds audit_log.metadata as a nullable column with no default', async () => {
    const env = createTestEnv()
    const col = (await env.DB.prepare('PRAGMA table_info(audit_log)')
      .all<{ name: string; type: string; notnull: number; dflt_value: string | null }>()).results
      .find((c) => c.name === 'metadata')
    // Nullable, no default: the previously deployed Worker INSERTs audit rows without naming the
    // column (migration 0019 is additive and applied before the deploy), and every action the new
    // code does not populate leaves it NULL.
    expect(col).toMatchObject({ type: 'TEXT', notnull: 0, dflt_value: null })
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

  it('0018 adds the credential org columns and keeps them nullable for the old code', async () => {
    const env = createTestEnv()
    const info = async (t: string) =>
      (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string; notnull: number; dflt_value: string | null }>()).results
    const apiKeyOrg = (await info('api_keys')).find((c) => c.name === 'org_id')
    const refreshOrg = (await info('refresh_tokens')).find((c) => c.name === 'org_id')
    // Nullable with no default: SQLite cannot add NOT NULL to a populated table, and the
    // previously deployed code still INSERTs without naming the column while 0018 is live. The
    // CODE is what refuses a NULL (KEY_ORG_UNRESOLVED / a revoked refresh family), not the schema.
    expect(apiKeyOrg).toMatchObject({ notnull: 0, dflt_value: null })
    expect(refreshOrg).toMatchObject({ notnull: 0, dflt_value: null })

    const now = new Date().toISOString()
    await env.DB.prepare('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)').bind('o1', 'O', 'o', now).run()
    await env.DB.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)').bind('u1', 'u@x', 'h', 's', now).run()
    // An insert in exactly the shape the pre-0018 Worker writes still succeeds (backward compatible).
    await env.DB.prepare('INSERT INTO api_keys (id, user_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('key_old', 'u1', 'hash-old', 'legacy', now).run()
    expect(await env.DB.prepare("SELECT org_id FROM api_keys WHERE id = 'key_old'").first<{ org_id: string | null }>())
      .toEqual({ org_id: null })

    // Deleting the organisation takes its credentials with it, which neither table did before.
    await env.DB.prepare('INSERT INTO api_keys (id, user_id, org_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('key_new', 'u1', 'o1', 'hash-new', 'current', now).run()
    await env.DB.prepare('INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, created_at, expires_at, family_started_at, org_id) VALUES (?, ?, ?, ?, 1, 2, 1, ?)')
      .bind('rt1', 'u1', 'f1', 'rt-hash', 'o1').run()
    await env.DB.prepare("DELETE FROM organisations WHERE id = 'o1'").run()
    expect(await env.DB.prepare("SELECT id FROM api_keys WHERE id = 'key_new'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT id FROM refresh_tokens WHERE id = 'rt1'").first()).toBeNull()
    expect(await env.DB.prepare("SELECT id FROM api_keys WHERE id = 'key_old'").first()).toEqual({ id: 'key_old' })
  })

  it('0018 allows one OPEN invite per address per org, and frees the address on accept or revoke', async () => {
    const env = createTestEnv()
    const now = new Date().toISOString()
    const later = new Date(Date.now() + 7 * 86_400_000).toISOString()
    const cols = (await env.DB.prepare('PRAGMA table_info(org_invites)').all<{ name: string }>()).results.map((r) => r.name)
    expect(cols).toEqual([
      'id', 'org_id', 'email', 'role', 'token_hash', 'invited_by',
      'created_at', 'expires_at', 'accepted_at', 'accepted_by', 'revoked_at', 'revoked_by',
    ])

    await env.DB.prepare('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)').bind('o1', 'O', 'o', now).run()
    await env.DB.prepare('INSERT INTO organisations (id, name, slug, created_at) VALUES (?, ?, ?, ?)').bind('o2', 'P', 'p', now).run()
    await env.DB.prepare('INSERT INTO users (id, email, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)').bind('u1', 'a@x', 'h', 's', now).run()
    const invite = (id: string, orgId: string, email: string, hash: string) =>
      env.DB.prepare('INSERT INTO org_invites (id, org_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, orgId, email, 'member', hash, 'u1', now, later)

    await invite('inv_1', 'o1', 'ann@x.test', 'h1').run()
    // A second OPEN invite to the same address in the same org is the thing the partial unique
    // index exists to refuse — otherwise an admin re-inviting produces two live tokens.
    await expect(invite('inv_2', 'o1', 'ann@x.test', 'h2').run()).rejects.toThrow(/UNIQUE/i)
    // Another org, same address: fine. An invite is to an address IN an org.
    await invite('inv_3', 'o2', 'ann@x.test', 'h3').run()
    // The token hash is globally unique, so a token can never name two invites.
    await expect(invite('inv_4', 'o2', 'bob@x.test', 'h1').run()).rejects.toThrow(/UNIQUE/i)

    // Accepting frees the address: a member who later leaves can be invited again.
    await env.DB.prepare("UPDATE org_invites SET accepted_at = ?, accepted_by = 'u1' WHERE id = 'inv_1'").bind(now).run()
    await invite('inv_5', 'o1', 'ann@x.test', 'h5').run()
    await expect(invite('inv_6', 'o1', 'ann@x.test', 'h6').run()).rejects.toThrow(/UNIQUE/i)

    // So does revoking.
    await env.DB.prepare("UPDATE org_invites SET revoked_at = ?, revoked_by = 'u1' WHERE id = 'inv_5'").bind(now).run()
    await invite('inv_7', 'o1', 'ann@x.test', 'h7').run()

    // The role CHECK matches members', and the default is the least-privileged useful role.
    await expect(
      env.DB.prepare('INSERT INTO org_invites (id, org_id, email, role, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind('inv_bad', 'o2', 'c@x.test', 'superuser', 'h8', now, later).run(),
    ).rejects.toThrow(/CHECK/i)
    await env.DB.prepare('INSERT INTO org_invites (id, org_id, email, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('inv_default', 'o2', 'd@x.test', 'h9', now, later).run()
    expect(await env.DB.prepare("SELECT role FROM org_invites WHERE id = 'inv_default'").first()).toEqual({ role: 'member' })

    // Offboarding the inviting admin keeps the invite and blanks the reference; deleting the org
    // takes its invites with it.
    await env.DB.prepare("DELETE FROM users WHERE id = 'u1'").run()
    expect(await env.DB.prepare("SELECT invited_by FROM org_invites WHERE id = 'inv_7'").first()).toEqual({ invited_by: null })
    await env.DB.prepare("DELETE FROM organisations WHERE id = 'o1'").run()
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM org_invites WHERE org_id = 'o1'").first<{ n: number }>()).toEqual({ n: 0 })
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
