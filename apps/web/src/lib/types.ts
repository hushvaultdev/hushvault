// API DTOs that mirror the JSON returned by the HushVault API.
// List endpoints return raw D1 rows (snake_case); detail/create endpoints
// return camelCase objects. Types here match the wire format exactly.

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
