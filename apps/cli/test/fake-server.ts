import { vi } from 'vitest'

export interface Env { id: string; project_id: string; name: string; slug: string; parent_env_id: string | null }
export interface Sec { id: string; project_id: string; env_id: string; name: string; value: string }

export interface Call { method: string; path: string; query: Record<string, string>; body: unknown; auth: string | null }

/** Scripted fake of the HushVault API contract. */
export class FakeServer {
  calls: Call[] = []
  role: 'viewer' | 'member' | 'admin' = 'admin'
  projects = [{ id: 'prj_1', name: 'Demo App', slug: 'demo-app' }]
  envs: Env[] = [
    { id: 'env_dev', project_id: 'prj_1', name: 'Development', slug: 'development', parent_env_id: null },
    { id: 'env_stg', project_id: 'prj_1', name: 'Staging', slug: 'staging', parent_env_id: 'env_dev' },
  ]
  secrets: Sec[] = [
    { id: 'sec_1', project_id: 'prj_1', env_id: 'env_dev', name: 'BASE', value: 'base-val' },
    { id: 'sec_2', project_id: 'prj_1', env_id: 'env_stg', name: 'OWN', value: 'own-val' },
  ]
  n = 0

  json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }

  handle = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url)
    const method = init?.method ?? 'GET'
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    const query = Object.fromEntries(url.searchParams.entries())
    this.calls.push({ method, path: url.pathname, query, body, auth: headers['Authorization'] ?? null })
    const p = url.pathname

    if (p === '/api/auth/login' && method === 'POST') {
      if (body.password !== 'pw') return this.json(401, { error: 'UNAUTHORIZED', message: 'Invalid credentials' })
      return this.json(200, { data: { token: 'jwt-token', userId: 'usr_1', orgId: 'org_1', role: 'admin' } })
    }
    if (!headers['Authorization']) return this.json(401, { error: 'UNAUTHORIZED', message: 'Missing token' })
    const canAdmin = this.role === 'admin'
    const canWrite = this.role !== 'viewer'

    if (p === '/api/projects' && method === 'GET') return this.json(200, { data: this.projects })
    if (p === '/api/projects' && method === 'POST') {
      if (!canAdmin) return this.json(403, { error: 'FORBIDDEN', message: 'Insufficient role' })
      const row = { id: `prj_${++this.n + 1}`, name: body.name, slug: String(body.name).toLowerCase() }
      this.projects.push(row)
      return this.json(201, { data: row })
    }
    if (p === '/api/environments' && method === 'GET') {
      return this.json(200, { data: this.envs.filter((e) => e.project_id === query['projectId']) })
    }
    if (p === '/api/environments' && method === 'POST') {
      if (!canAdmin) return this.json(403, { error: 'FORBIDDEN', message: 'Insufficient role' })
      const slug = String(body.name).toLowerCase()
      const row = { id: `env_${slug}`, project_id: body.projectId, name: body.name, slug, parent_env_id: null }
      this.envs.push(row)
      return this.json(201, { data: { id: row.id, projectId: row.project_id, name: row.name, slug, parentEnvId: null } })
    }
    if (p === '/api/secrets' && method === 'GET') {
      const data = this.secrets
        .filter((s) => s.env_id === query['envId'])
        .map((s) => ({ id: s.id, project_id: s.project_id, env_id: s.env_id, name: s.name, is_computed: 0, template: null }))
      return this.json(200, { data })
    }
    if (p === '/api/secrets' && method === 'POST') {
      if (!canWrite) return this.json(403, { error: 'FORBIDDEN', message: 'Insufficient role' })
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(body.name)) return this.json(400, { error: 'VALIDATION_ERROR', message: 'Bad name' })
      if (this.secrets.some((s) => s.env_id === body.envId && s.name === body.name)) {
        return this.json(409, { error: 'CONFLICT', message: 'Secret already exists' })
      }
      const row = { id: `sec_${++this.n + 10}`, project_id: body.projectId, env_id: body.envId, name: body.name, value: body.value }
      this.secrets.push(row)
      return this.json(201, { data: { id: row.id, name: row.name } })
    }
    const patch = /^\/api\/secrets\/([^/]+)$/.exec(p)
    if (patch && method === 'PATCH') {
      if (!canWrite) return this.json(403, { error: 'FORBIDDEN', message: 'Insufficient role' })
      const s = this.secrets.find((x) => x.id === decodeURIComponent(patch[1]!))
      if (!s) return this.json(404, { error: 'NOT_FOUND', message: 'Secret not found' })
      if (body.value !== undefined) s.value = body.value
      return this.json(200, { data: { id: s.id, name: s.name } })
    }
    const res = /^\/api\/environments\/([^/]+)\/resolved$/.exec(p)
    if (res && method === 'GET') {
      const envId = decodeURIComponent(res[1]!)
      const env = this.envs.find((e) => e.id === envId)
      if (!env) return this.json(404, { error: 'NOT_FOUND', message: 'Environment not found' })
      const merged = new Map<string, { s: Sec; from: string | null }>()
      const chain: Env[] = []
      for (let e: Env | undefined = env; e; e = this.envs.find((x) => x.id === e!.parent_env_id)) chain.unshift(e)
      for (const e of chain) {
        for (const s of this.secrets.filter((x) => x.env_id === e.id)) merged.set(s.name, { s, from: e.id === env.id ? null : e.id })
      }
      const secrets = [...merged.values()].map(({ s, from }) => ({
        id: s.id, name: s.name, isComputed: false, template: null, inheritedFrom: from, value: query['values'] === 'true' ? s.value : null,
      }))
      return this.json(200, { data: { environmentId: envId, values: query['values'] === 'true', secrets } })
    }
    if (p === '/api/share' && method === 'POST') {
      return this.json(201, { data: { token: 'tok_1', url: 'https://hushvault.com/share/tok_1' } })
    }
    return this.json(404, { error: 'NOT_FOUND', message: 'No route' })
  }

  install(): void {
    vi.stubGlobal('fetch', vi.fn(this.handle))
  }
}
