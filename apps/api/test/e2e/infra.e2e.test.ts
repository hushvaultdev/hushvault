// Always-green infra safety net against live dev. Read-only — never creates users or secrets.
// Covers: health, root banner, CORS pre-flight, D1 canary row, migration count.
import { describe, expect, it } from 'vitest'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { api, cfApi, CF_ACCOUNT_ID } from './_helpers'

describe('[infra] live dev Worker is alive', () => {
  it('GET /health → 200, status ok, db and kv ok', async () => {
    const res = await api('/health')
    expect(res.status).toBe(200)
    const body = res.body as { status?: string; checks?: { db?: string; kv?: string } }
    expect(body.status).toBe('ok')
    expect(body.checks?.db).toBe('ok')
    expect(body.checks?.kv).toBe('ok')
  })

  it('GET / returns the banner', async () => {
    const res = await api('/')
    expect(res.status).toBe(200)
  })

  it('CORS pre-flight from beta.hushvault.dev is allowed', async () => {
    const res = await api('/api/orgs', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://beta.hushvault.dev',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,content-type',
      },
    })
    // Hono CORS returns 204 for allowed preflights.
    expect([200, 204]).toContain(res.status)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://beta.hushvault.dev')
  })
})

describe('[infra] dev D1 is in a sane state', () => {
  it('encryption_keys has exactly one active row and a well-formed check_value', async () => {
    // D1 execute via the CF REST API (same account the Worker uses). Database id from wrangler.toml [env.dev].
    const databaseId = '3bab0adc-c28b-474f-8e39-810657ecae0b'
    const res = await cfApi(`/accounts/${CF_ACCOUNT_ID()}/d1/database/${databaseId}/query`, {
      method: 'POST',
      json: { sql: 'SELECT version, check_value, status FROM encryption_keys' },
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: Array<{ results?: Array<{ version: string; check_value: string; status: string }> }> }
    const rows = body.result?.[0]?.results ?? []
    const active = rows.filter((r) => r.status === 'active')
    expect(active).toHaveLength(1)
    const cv = active[0]!.check_value
    expect(cv).toMatch(/^[A-Za-z0-9+/=_-]+:[A-Za-z0-9+/=_-]+$/)
  })

  it('migration count on dev equals the number of .sql files in apps/api/migrations/', async () => {
    const migrationsDir = resolve(__dirname, '..', '..', 'migrations')
    const localCount = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).length

    const databaseId = '3bab0adc-c28b-474f-8e39-810657ecae0b'
    const res = await cfApi(`/accounts/${CF_ACCOUNT_ID()}/d1/database/${databaseId}/query`, {
      method: 'POST',
      json: { sql: "SELECT COUNT(*) AS n FROM d1_migrations" },
    })
    expect(res.status).toBe(200)
    const body = res.body as { result?: Array<{ results?: Array<{ n: number }> }> }
    const remote = body.result?.[0]?.results?.[0]?.n ?? -1
    expect(remote).toBe(localCount)
  })
})
