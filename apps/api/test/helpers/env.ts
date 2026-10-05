// Test harness: a D1 + KV fake backed by real SQLite (node:sqlite) with every
// migration in apps/api/migrations applied in order. Not type-checked by tsc
// (see tsconfig `include`); vitest transpiles it.
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signJwt, createPrefixedId, hashPassword, createApiKey } from '../../src/lib/auth'
import { app } from '../../src/index'

type Bindable = string | number | boolean | null | Uint8Array

function normalise(values: unknown[]): (string | number | null | Uint8Array)[] {
  return values.map((v) => {
    if (v === undefined) throw new Error('D1 cannot bind undefined')
    if (typeof v === 'boolean') return v ? 1 : 0
    return v as string | number | null | Uint8Array
  })
}

class FakeStatement {
  private params: unknown[] = []
  constructor(private db: DatabaseSync, readonly sql: string) {}

  bind(...values: Bindable[]): FakeStatement {
    const next = new FakeStatement(this.db, this.sql)
    next.params = values
    return next
  }

  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...normalise(this.params)) as Record<string, unknown> | undefined
    if (!row) return null
    return (col ? row[col] : row) as T
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const results = this.db.prepare(this.sql).all(...normalise(this.params)) as T[]
    return { results, success: true, meta: { changes: 0 } }
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const res = this.db.prepare(this.sql).run(...normalise(this.params))
    return { success: true, meta: { changes: Number(res.changes) } }
  }

  runSync() {
    return this.db.prepare(this.sql).run(...normalise(this.params))
  }
}

export class FakeD1 {
  constructor(readonly sqlite: DatabaseSync) {}
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql)
  }
  async batch(statements: FakeStatement[]) {
    this.sqlite.exec('BEGIN')
    try {
      const out = statements.map((s) => {
        const r = s.runSync()
        return { success: true, meta: { changes: Number(r.changes) } }
      })
      this.sqlite.exec('COMMIT')
      return out
    } catch (err) {
      this.sqlite.exec('ROLLBACK')
      throw err
    }
  }
}

/**
 * Deliberately NOT bulk-read capable: `get` takes a single key, so the whole suite exercises
 * readSecretBlobs' fallback path. test/secret-blobs.test.ts covers the bulk path with its own
 * double. `list` paginates like KV does (sorted keys, opaque cursor, `list_complete`), which
 * is what the orphan sweep's per-tick bound rides on.
 */
export class FakeKV {
  readonly store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    if (Array.isArray(key)) throw new Error('FakeKV does not implement bulk reads')
    return this.store.get(key) ?? null
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
  async list(opts?: { prefix?: string | null; limit?: number; cursor?: string | null }) {
    const all = [...this.store.keys()].filter((k) => k.startsWith(opts?.prefix ?? '')).sort()
    const after = opts?.cursor ? all.filter((k) => k > opts.cursor!) : all
    const limit = opts?.limit ?? 1000
    const page = after.slice(0, limit)
    const keys = page.map((name) => ({ name }))
    if (page.length < after.length) {
      return { keys, list_complete: false as const, cursor: page[page.length - 1] as string }
    }
    return { keys, list_complete: true as const }
  }
}

export type TestEnv = {
  DB: FakeD1
  SECRETS_KV: FakeKV
  ENVIRONMENT: string
  ENCRYPTION_MASTER_KEY: string
  JWT_SECRET: string
  [key: string]: unknown
}

const MIGRATIONS_DIR = join(fileURLToPath(new URL('.', import.meta.url)), '../../migrations')

export function createTestEnv(overrides: Record<string, unknown> = {}): TestEnv {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return {
    DB: new FakeD1(sqlite),
    SECRETS_KV: new FakeKV(),
    ENVIRONMENT: 'test',
    ENCRYPTION_MASTER_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    JWT_SECRET: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
    ...overrides,
  }
}

export type Role = 'owner' | 'admin' | 'member' | 'viewer'

/** Insert a user (+ optionally a brand new org, or membership in `orgId`) and return a signed JWT. */
export async function seedUser(
  env: TestEnv,
  opts: { role?: Role; orgId?: string; email?: string; password?: string; emailVerified?: boolean } = {},
) {
  const role = opts.role ?? 'owner'
  const userId = createPrefixedId('usr')
  const email = opts.email ?? `${userId}@example.test`
  const now = new Date().toISOString()
  const { salt, passwordHash } = await hashPassword(opts.password ?? 'correct horse battery staple')
  await env.DB.prepare('INSERT INTO users (id, email, password_hash, salt, created_at, email_verified) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(userId, email, passwordHash, salt, now, opts.emailVerified ? 1 : 0).run()
  let orgId = opts.orgId
  if (!orgId) {
    orgId = createPrefixedId('org')
    await env.DB.prepare('INSERT INTO organisations (id, name, slug, plan, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(orgId, 'Test Org', `test-${orgId.slice(-8).toLowerCase()}`, 'free', now).run()
  }
  await env.DB.prepare('INSERT INTO members (id, org_id, user_id, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(createPrefixedId('mem'), orgId, userId, role, now).run()
  const token = await signJwt({ sub: userId, orgId, role }, env.JWT_SECRET)
  return { userId, orgId, email, role, token }
}

/**
 * Insert an API key for a user; returns the raw key to use as a Bearer token.
 *
 * A key names the org it acts in (migration 0018). `orgId` defaults to the user's earliest
 * membership, which is what the production create endpoint would have recorded for a single-org
 * user; pass it explicitly to seed a key in a specific org. Pass `null` to seed a pre-0018 key
 * with no org at all.
 */
export async function seedApiKey(env: TestEnv, userId: string, orgId?: string | null) {
  const { rawKey, keyHash } = await createApiKey()
  const id = createPrefixedId('key')
  const resolved = orgId === undefined
    ? (await env.DB.prepare('SELECT org_id FROM members WHERE user_id = ? ORDER BY created_at ASC LIMIT 1')
      .bind(userId).first<{ org_id: string }>())?.org_id ?? null
    : orgId
  await env.DB.prepare('INSERT INTO api_keys (id, user_id, org_id, key_hash, name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, userId, resolved, keyHash, 'test key', new Date().toISOString()).run()
  return { id, rawKey, orgId: resolved }
}

export async function seedProject(env: TestEnv, orgId: string, name = 'Proj') {
  const id = createPrefixedId('prj')
  const now = new Date().toISOString()
  await env.DB.prepare('INSERT INTO projects (id, org_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, orgId, name, `${name.toLowerCase()}-${id.slice(-6).toLowerCase()}`, null, now, now).run()
  return id
}

export async function seedEnvironment(env: TestEnv, projectId: string, name = 'production', parentEnvId: string | null = null) {
  const id = createPrefixedId('env')
  await env.DB.prepare('INSERT INTO environments (id, project_id, name, slug, parent_env_id, color, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, projectId, name, name.toLowerCase(), parentEnvId, '#6366f1', new Date().toISOString()).run()
  return id
}

type CallOpts = { token?: string; json?: unknown; headers?: Record<string, string> }

/** Call the real Hono app in-process. */
export async function call(env: TestEnv, method: string, path: string, opts: CallOpts = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) }
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`
  if (opts.json !== undefined) headers['content-type'] = 'application/json'
  const res = await app.request(path, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  }, env)
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return { status: res.status, body, headers: res.headers }
}
