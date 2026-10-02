import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────────────
// Users & Auth
// ─────────────────────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(), // empty string for OAuth-only users
  salt: text('salt').notNull(), // PBKDF2 salt for key derivation
  provider: text('provider'), // 'github' | 'google' | null (password)
  providerId: text('provider_id'), // provider's stable user id
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  // Unix seconds; JWTs issued before this are rejected (set on password reset). 0 = none.
  sessionsValidAfter: integer('sessions_valid_after').notNull().default(0),
  createdAt: text('created_at').notNull(),
}, (t) => [uniqueIndex('users_provider_idx').on(t.provider, t.providerId)])

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  keyHash: text('key_hash').notNull().unique(), // SHA-256 hash of raw key
  name: text('name').notNull(),
  lastUsedAt: text('last_used_at'),
  expiresAt: text('expires_at'),
  // Soft-revocation audit trail. A revoked key is invalidated by setting
  // expiresAt to "now" (already honoured by the auth middleware); these columns
  // record when and why. revokedReason e.g. "leaked_in_github".
  revokedAt: text('revoked_at'),
  revokedReason: text('revoked_reason'),
  createdAt: text('created_at').notNull(),
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
  // Optional per-org audit log retention override (days). null = use the plan
  // default. Can shorten retention below the plan allowance, never extend it.
  auditRetentionDays: integer('audit_retention_days'),
  createdAt: text('created_at').notNull(),
})

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull().default('member'),
  createdAt: text('created_at').notNull(),
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
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (t) => [index('projects_org_idx').on(t.orgId)])

export const environments = sqliteTable('environments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // e.g. "production", "staging", "development"
  slug: text('slug').notNull(),
  parentEnvId: text('parent_env_id'), // null = root env; set for branch inheritance
  color: text('color').default('#6366f1'), // UI color hint
  createdAt: text('created_at').notNull(),
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
  encVersion: integer('enc_version').notNull().default(1), // 2 = AAD-bound ciphertext
  isComputed: integer('is_computed', { mode: 'boolean' }).notNull().default(false),
  template: text('template'),                   // e.g. "${DB_USER}:${DB_PASS}@host/db"
  dependencies: text('dependencies'),           // JSON array of secret names
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
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
  encVersion: integer('enc_version').notNull().default(1),
  changedAt: text('changed_at').notNull(),
  changedBy: text('changed_by').references(() => users.id),
}, (t) => [index('secret_history_secret_idx').on(t.secretId)])

// ─────────────────────────────────────────────
// Share Links (Temporary share URLs)
// ─────────────────────────────────────────────

export const shareLinks = sqliteTable('share_links', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),       // URL token (random, not the encryption key)
  encryptedPayload: text('encrypted_payload').notNull(), // client-encrypted secret value
  expiresAt: text('expires_at').notNull(),
  maxViews: integer('max_views').notNull().default(1),
  viewCount: integer('view_count').notNull().default(0),
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
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
  timestamp: text('timestamp').notNull(),
}, (t) => [
  index('audit_log_org_idx').on(t.orgId),
  index('audit_log_timestamp_idx').on(t.timestamp),
])

// ─────────────────────────────────────────────
// Key rotation (KEK versions; migration 0006, issue #27)
// ─────────────────────────────────────────────

export const encryptionKeys = sqliteTable('encryption_keys', {
  version: text('version').primaryKey(),        // "v1", "v2", ...
  checkValue: text('check_value').notNull(),    // encryption of a fixed canary; no key material
  status: text('status', { enum: ['active', 'decrypt_only', 'retired'] }).notNull(),
  createdAt: text('created_at').notNull(),
  activatedAt: text('activated_at'),
  retiredAt: text('retired_at'),
})

export const keyRotations = sqliteTable('key_rotations', {
  id: text('id').primaryKey(),
  fromVersion: text('from_version').notNull(),
  toVersion: text('to_version').notNull(),
  status: text('status', { enum: ['running', 'paused', 'completed', 'completed_with_errors', 'failed'] }).notNull(),
  phase: text('phase', { enum: ['secrets', 'history', 'connections'] }).notNull().default('secrets'),
  secretsCursor: text('secrets_cursor'),
  historyCursor: text('history_cursor'),
  connectionsCursor: text('connections_cursor'),
  rewrapped: integer('rewrapped').notNull().default(0),
  skipped: integer('skipped').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  leaseUntil: text('lease_until'),
  leaseOwner: text('lease_owner'),
  lastErrorCode: text('last_error_code'),
  startedAt: text('started_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
})

export const keyRotationFailures = sqliteTable('key_rotation_failures', {
  rotationId: text('rotation_id').notNull(),
  tableName: text('table_name', { enum: ['secrets', 'secret_history', 'integration_connections'] }).notNull(),
  rowId: text('row_id').notNull(),
  errorCode: text('error_code').notNull(),
}, (t) => [primaryKey({ columns: [t.rotationId, t.tableName, t.rowId] })])

// ─────────────────────────────────────────────
// Email verification / password reset tokens (migration 0007, issue #26)
// ─────────────────────────────────────────────

export const authTokens = sqliteTable('auth_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text('purpose', { enum: ['verify_email', 'reset_password'] }).notNull(),
  tokenHash: text('token_hash').notNull().unique(), // SHA-256 of the token; the token is never stored
  email: text('email').notNull(),                   // address the token was issued for
  expiresAt: text('expires_at').notNull(),
  usedAt: text('used_at'),
  createdAt: text('created_at').notNull(),
}, (t) => [
  index('auth_tokens_user_purpose_idx').on(t.userId, t.purpose),
  index('auth_tokens_expires_idx').on(t.expiresAt),
])

// ─────────────────────────────────────────────
// Integrations (issue #39)
// ─────────────────────────────────────────────

// Outbound credential vault: ciphertext only. Never selected into API responses.
export const integrationConnections = sqliteTable('integration_connections', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  configJson: text('config_json').notNull().default('{}'), // non-secret provider settings
  encryptedCredential: text('encrypted_credential').notNull(),
  wrappedDek: text('wrapped_dek').notNull(),
  keyVersion: text('key_version').notNull(),
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastVerifiedAt: text('last_verified_at'),
}, (t) => [
  index('integration_connections_org_idx').on(t.orgId),
  uniqueIndex('integration_connections_label_idx').on(t.orgId, t.provider, t.label),
])
