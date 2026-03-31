// Core domain types shared across API, CLI, and dashboard

export interface User {
  id: string
  email: string
  name: string | null
  createdAt: string
}

export interface Organisation {
  id: string
  name: string
  slug: string
  plan: 'free' | 'pro' | 'team' | 'enterprise'
  createdAt: string
}

export interface Project {
  id: string
  orgId: string
  name: string
  slug: string
  createdAt: string
}

export interface Environment {
  id: string
  projectId: string
  name: string
  slug: string
  parentEnvId: string | null
  createdAt: string
}

export interface Secret {
  id: string
  envId: string
  key: string
  isComputed: boolean
  template: string | null
  dependencies: string[]
  createdAt: string
  updatedAt: string
}

// API response shape
export interface ApiResponse<T> {
  data: T
}

export interface ApiListResponse<T> {
  data: T[]
  total: number
}

export interface ApiError {
  error: string
  message: string
}

// CLI project config shape (.hushvault.json)
export interface ProjectConfig {
  projectId: string
  projectSlug: string
  orgSlug: string
  apiUrl?: string
}

// Share link
export interface ShareLink {
  id: string
  slug: string
  expiresAt: string | null
  maxViews: number | null
  viewCount: number
  createdAt: string
}
