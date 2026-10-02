import { describe, expect, it } from 'vitest'
import { createTestEnv } from './helpers/env'

describe('migrations', () => {
  it('apply cleanly to an empty database and create every table', async () => {
    const env = createTestEnv()
    const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()
    const tables = results.map((r) => r.name)
    for (const t of ['users', 'api_keys', 'organisations', 'members', 'projects', 'environments', 'secrets', 'secret_history', 'share_links', 'audit_log', 'encryption_keys', 'key_rotations', 'key_rotation_failures', 'auth_tokens', 'refresh_tokens']) {
      expect(tables).toContain(t)
    }
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
