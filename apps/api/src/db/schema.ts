import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Users & Auth
// ─────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  salt: text('salt').notNull(), // PBKDF2 salt for key derivation
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull().unique(), // SHA-256 hash of raw key
  name: text('name').notNull(),
  lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('api_keys_user_idx').on(t.userId)])

// ─────────────────────────────────────────────
// Organisations & Members
// ─────────────────────────────────────────────

export const organisations = sqliteTable('organisations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan', { enum: ['free', 'pro', 'team', 'enterprise'] }).notNull().default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
})

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [
  index('members_org_idx').on(t.orgId),
  index('members_user_idx').on(t.userId),
])

// ─────────────────────────────────────────────
// Projects & Environments
// ─────────────────────────────────────────────

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('projects_org_idx').on(t.orgId)])

export const environments = sqliteTable('environments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // e.g. "production", "staging", "development"
  slug: text('slug').notNull(),
  parentEnvId: text('parent_env_id'), // null = root env; set for branch inheritance
  color: text('color').default('#6366f1'), // UI color hint
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('environments_project_idx').on(t.projectId)])

// ─────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  envId: text('env_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),                 // e.g. "DATABASE_URL"
  // Encrypted value stored in KV, key = "secret:{id}"
  // wrappedDek stored here (DEK encrypted with org master key)
  wrappedDek: text('wrapped_dek').notNull(),
  keyVersion: text('key_version').notNull().default('v1'), // for key rotation
  isComputed: integer('is_computed', { mode: 'boolean' }).notNull().default(false),
  template: text('template'),                   // e.g. "${DB_USER}:${DB_PASS}@host/db"
  dependencies: text('dependencies'),           // JSON array of secret names
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  createdBy: text('created_by').references(() => users.id),
}, (t) => [
  index('secrets_env_idx').on(t.envId),
  index('secrets_project_idx').on(t.projectId),
  index('secrets_name_idx').on(t.name),
])

export const secretHistory = sqliteTable('secret_history', {
  id: text('id').primaryKey(),
  secretId: text('secret_id').notNull().references(() => secrets.id, { onDelete: 'cascade' }),
  wrappedDek: text('wrapped_dek').notNull(),
  keyVersion: text('key_version').notNull(),
  changedAt: integer('changed_at', { mode: 'timestamp' }).notNull(),
  changedBy: text('changed_by').references(() => users.id),
}, (t) => [index('secret_history_secret_idx').on(t.secretId)])

// ─────────────────────────────────────────────
// Share Links (Temporary share URLs)
// ─────────────────────────────────────────────

export const shareLinks = sqliteTable('share_links', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),       // URL token (random, not the encryption key)
  encryptedPayload: text('encrypted_payload').notNull(), // client-encrypted secret value
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  maxViews: integer('max_views').notNull().default(1),
  viewCount: integer('view_count').notNull().default(0),
  createdBy: text('created_by').references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (t) => [index('share_links_token_idx').on(t.token)])

// ─────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').references(() => users.id),
  actorType: text('actor_type', { enum: ['user', 'api_key', 'system'] }).notNull(),
  action: text('action').notNull(), // e.g. "secret.read", "secret.update", "member.invite"
  resourceType: text('resource_type'),          // "secret", "project", "environment"
  resourceId: text('resource_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  timestamp: integer('timestamp', { mode: 'timestamp' }).notNull(),
}, (t) => [
  index('audit_log_org_idx').on(t.orgId),
  index('audit_log_timestamp_idx').on(t.timestamp),
])
