// API DTOs that mirror the JSON returned by the HushVault API.
// The wire format is not uniform: list endpoints AND some detail endpoints
// (e.g. GET /api/projects, GET /api/projects/:id) return raw D1 rows with
// snake_case columns, while create responses and GET /api/secrets/:name return
// camelCase objects. Each type below matches its specific endpoint's shape.

export type Role = 'owner' | 'admin' | 'member' | 'viewer'

export interface Session {
  token: string
  userId: string
  orgId: string
  role: Role
}

export interface ProjectRow {
  id: string
  name: string
  slug: string
  description: string | null
  created_at: string
  updated_at: string
}

export interface EnvironmentRow {
  id: string
  project_id: string
  name: string
  slug: string
  parent_env_id: string | null
  color: string | null
  created_at: string
}

export interface SecretRow {
  id: string
  project_id: string
  env_id: string
  name: string
  is_computed: number
  template: string | null
  created_at: string
  updated_at: string
}

export interface SecretValue {
  id: string
  name: string
  envId: string
  projectId: string
  value: string
  isComputed: boolean
  template: string | null
}

export interface AuditRow {
  id: string
  org_id: string
  actor_id: string | null
  actor_type: string
  action: string
  resource_type: string | null
  resource_id: string | null
  ip: string | null
  user_agent: string | null
  timestamp: string
}
