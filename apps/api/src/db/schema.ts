// The SQL files in apps/api/migrations are authoritative; this file documents the schema they
// produce (and types the few Drizzle-typed reads). Nothing here generates SQL — keep it in step
// with the migrations, which test/schema-drift.test.ts enforces by replaying them and diffing.
import { sql } from 'drizzle-orm'
import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  check,
  type AnySQLiteColumn,
} from 'drizzle-orm/sqlite-core'

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
  //
  // INTEGER, as 0002 declared it. Most writers bind unix seconds, but the
  // secret-scanner callback binds an ISO string, which INTEGER affinity keeps
  // as text — so readers must accept either (see routes/auth.ts). Narrowing
  // that to one representation needs a backfill, not a type change.
  revokedAt: integer('revoked_at'),
  revokedReason: text('revoked_reason'),
  // The organisation this key acts in (migration 0018, issue #82). Nullable only because SQLite
  // cannot add a NOT NULL column to a populated table: the middleware treats NULL as unusable
  // (401 KEY_ORG_UNRESOLVED) rather than falling back to the owner's earliest membership.
  orgId: text('org_id').references(() => organisations.id, { onDelete: 'cascade' }),
  createdAt: text('created_at').notNull(),
}, (t) => [
  index('api_keys_user_idx').on(t.userId),
  index('api_keys_revoked_idx').on(t.revokedAt),
  index('api_keys_org_idx').on(t.orgId),
])

// Rotating refresh tokens behind the 15-minute access JWTs (migration 0009, issue #77).
// Only SHA-256(token) is stored; every timestamp is unix seconds, not an ISO string.
export const refreshTokens = sqliteTable('refresh_tokens', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  familyId: text('family_id').notNull(), // a login; reusing a used token revokes the whole family
  tokenHash: text('token_hash').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  familyStartedAt: integer('family_started_at').notNull(), // caps how long rotation can extend a login
  usedAt: integer('used_at'),
  // The organisation this family is bound to (migration 0018, issue #82). Copied from the
  // predecessor row by every rotation, so a refresh can never move a session to another org;
  // switching org revokes the family and starts a new one. NULL = minted before 0018: the
  // refresh fails closed and the family is revoked rather than guessing an org.
  orgId: text('org_id').references(() => organisations.id, { onDelete: 'cascade' }),
}, (t) => [
  index('refresh_tokens_user_idx').on(t.userId),
  index('refresh_tokens_family_idx').on(t.familyId),
  index('refresh_tokens_expires_idx').on(t.expiresAt),
  index('refresh_tokens_org_idx').on(t.orgId),
])

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

// Invitations to join an organisation (migration 0018, issue #82). The table ships with Lane A so
// there is one migration for the whole change; the endpoints that write it are Lane B.
// Only base64url(SHA-256(token)) is stored, never the emailed token. `email` is written lower-cased.
export const orgInvites = sqliteTable('org_invites', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull().default('member'),
  tokenHash: text('token_hash').notNull().unique(),
  // SET NULL, not blocked and not cascading: offboarding the admin who invited someone must
  // neither be refused nor delete the record that the invite happened.
  invitedBy: text('invited_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  acceptedAt: text('accepted_at'),
  acceptedBy: text('accepted_by').references(() => users.id, { onDelete: 'set null' }),
  revokedAt: text('revoked_at'),
  revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  // One OPEN invite per address per org. Partial, so accepting or revoking frees the address
  // again — a plain unique (org_id, email) would be permanent and need a table rebuild to loosen.
  uniqueIndex('org_invites_open_idx').on(t.orgId, t.email).where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
  index('org_invites_org_idx').on(t.orgId),
  index('org_invites_expires_idx').on(t.expiresAt),
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
}, (t) => [
  index('projects_org_idx').on(t.orgId),
  uniqueIndex('projects_org_slug_uniq').on(t.orgId, t.slug),
])

export const environments = sqliteTable('environments', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), // e.g. "production", "staging", "development"
  slug: text('slug').notNull(),
  // null = root env; set for branch inheritance. Self-reference, so the type has to be annotated.
  // Deleting a parent orphans its children rather than cascading their secrets away.
  parentEnvId: text('parent_env_id').references((): AnySQLiteColumn => environments.id, { onDelete: 'set null' }),
  color: text('color').default('#6366f1'), // UI color hint
  createdAt: text('created_at').notNull(),
}, (t) => [
  index('environments_project_idx').on(t.projectId),
  uniqueIndex('environments_project_slug_uniq').on(t.projectId, t.slug),
])

// ─────────────────────────────────────────────
// Secrets
// ─────────────────────────────────────────────

export const secrets = sqliteTable('secrets', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  envId: text('env_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),                 // e.g. "DATABASE_URL"
  // Encrypted value stored in KV, key = "secret:{id}:{blobRev}"
  // wrappedDek stored here (DEK encrypted with org master key)
  wrappedDek: text('wrapped_dek').notNull(),
  keyVersion: text('key_version').notNull().default('v1'), // for key rotation
  encVersion: integer('enc_version').notNull().default(1), // 2 = AAD-bound ciphertext
  // Which KV blob holds the current value. 0 = the pre-0014 unversioned
  // "secret:{id}". Each value change writes a never-written key and then moves
  // this pointer, so a failed D1 write can only orphan a blob (migration 0014).
  blobRev: integer('blob_rev').notNull().default(0),
  isComputed: integer('is_computed', { mode: 'boolean' }).notNull().default(false),
  template: text('template'),                   // e.g. "${DB_USER}:${DB_PASS}@host/db"
  dependencies: text('dependencies').default('[]'), // JSON array of secret names
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
}, (t) => [
  index('secrets_env_idx').on(t.envId),
  index('secrets_project_idx').on(t.projectId),
  index('secrets_name_idx').on(t.name),
  uniqueIndex('secrets_env_name_uniq').on(t.envId, t.name),
  index('secrets_key_version_idx').on(t.keyVersion), // rotation scans by key version
])

// `secret_history` was here. It recorded the superseded (wrapped DEK, blob revision) pair on
// every value change, and no endpoint ever read one: no list, no restore, no retention, no
// purge. Migration 0017 dropped it (issue #84) rather than build the versions API that would
// have justified retaining every historical secret value forever. Previous values are not
// retained; see docs/API.md and docs/OPERATIONS.md § 2 for the recovery path this removes.

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
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: text('created_at').notNull(),
  // Owner recorded at creation (migration 0015), so the audit row survives the creator being
  // deleted. Nullable only because 0015 could not backfill links whose creator was already
  // gone; the read path refuses to serve those.
  orgId: text('org_id').references(() => organisations.id, { onDelete: 'cascade' }),
}, (t) => [
  index('share_links_token_idx').on(t.token),
  index('share_links_org_idx').on(t.orgId, t.expiresAt),
])

// ─────────────────────────────────────────────
// Audit Log
// ─────────────────────────────────────────────

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
  actorType: text('actor_type', { enum: ['user', 'api_key', 'system'] }).notNull(),
  action: text('action').notNull(), // e.g. "secret.read", "secret.update", "member.invite"
  resourceType: text('resource_type'),          // "secret", "project", "environment"
  resourceId: text('resource_id'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  // Small, bounded, NON-SECRET JSON object of fixed server-set keys (migration 0019, issue #96).
  // e.g. a role change stores {"from","to"}. Never a secret value, DEK, token, key or caller free
  // text — see .claude/rules/audit-log.md. Nullable: most actions leave it NULL.
  metadata: text('metadata'),
  timestamp: text('timestamp').notNull(),
}, (t) => [
  index('audit_log_org_idx').on(t.orgId),
  index('audit_log_timestamp_idx').on(t.timestamp),
  index('audit_log_org_timestamp_idx').on(t.orgId, t.timestamp), // export + retention sweep
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
  // 'history' is still in the CHECK constraint and so must stay in this enum, which exists to
  // match it (see the drift test). The engine no longer walks that phase and never writes the
  // value: narrowing the constraint would mean rebuilding key_rotations and recreating its
  // partial unique index, which migration 0017 judged not worth the risk. `history_cursor` was
  // dropped there, because a column needs no rebuild.
  phase: text('phase', { enum: ['secrets', 'history', 'connections'] }).notNull().default('secrets'),
  secretsCursor: text('secrets_cursor'),
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
}, (t) => [
  // Single-flight: the uniqueness only applies to the one live row, so the index is partial.
  uniqueIndex('key_rotations_one_running').on(t.status).where(sql`status = 'running'`),
])

export const keyRotationFailures = sqliteTable('key_rotation_failures', {
  rotationId: text('rotation_id').notNull(),
  // 'secret_history' likewise remains in the CHECK and therefore here, although the table is
  // gone and no row can name it again. Historical quarantine rows naming it may still exist.
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
  // No onDelete in the SQL, so deleting a creator is blocked by the reference. Issue #81.
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  lastVerifiedAt: text('last_verified_at'),
}, (t) => [
  index('integration_connections_org_idx').on(t.orgId),
  uniqueIndex('integration_connections_label_idx').on(t.orgId, t.provider, t.label),
  index('integration_connections_key_version_idx').on(t.keyVersion),
])

// ─────────────────────────────────────────────
// Secret sync (issue #40) — see migration 0011
// ─────────────────────────────────────────────

export const syncTargets = sqliteTable('sync_targets', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  envId: text('env_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  // Cascade: a target must not outlive its credential.
  connectionId: text('connection_id').notNull().references(() => integrationConnections.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  resourceJson: text('resource_json').notNull().default('{}'),
  nameFilterJson: text('name_filter_json').notNull().default('{}'),
  deleteRemoved: integer('delete_removed', { mode: 'boolean' }).notNull().default(false),
  fingerprintSalt: text('fingerprint_salt').notNull(),
  status: text('status', { enum: ['active', 'needs_attention'] }).notNull().default('active'),
  lastRunAt: text('last_run_at'),
  // Automatic triggers (migration 0012). scheduleMinutes is 15, 60, 360 or 1440; null = no schedule.
  syncOnChange: integer('sync_on_change', { mode: 'boolean' }).notNull().default(false),
  scheduleMinutes: integer('schedule_minutes'),
  // No onDelete in the SQL — issue #81, as above.
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  deletedAt: text('deleted_at'),
}, (t) => [
  index('sync_targets_org_idx').on(t.orgId, t.deletedAt),
  index('sync_targets_env_idx').on(t.envId),
  index('sync_targets_connection_idx').on(t.connectionId),
])

// Ledger of names HushVault wrote to a target. Fingerprint is an HMAC, never the value.
export const syncItems = sqliteTable('sync_items', {
  targetId: text('target_id').notNull().references(() => syncTargets.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  fingerprint: text('fingerprint').notNull(),
  lastPushedAt: text('last_pushed_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.targetId, t.name] }),
])

export const syncRuns = sqliteTable('sync_runs', {
  id: text('id').primaryKey(),
  targetId: text('target_id').notNull().references(() => syncTargets.id, { onDelete: 'cascade' }),
  trigger: text('trigger', { enum: ['manual', 'change', 'schedule'] }).notNull(),
  status: text('status', { enum: ['queued', 'running', 'succeeded', 'partial', 'failed'] }).notNull(),
  attempt: integer('attempt').notNull().default(1),
  countsJson: text('counts_json').notNull().default('{}'),
  errorCode: text('error_code'),
  actorId: text('actor_id'), // no reference: a run may be triggered by cron or a deleted user
  startedAt: text('started_at').notNull(),
  finishedAt: text('finished_at'),
  nextRetryAt: text('next_retry_at'),
  leaseUntil: text('lease_until'),
}, (t) => [
  // History reads page newest-first, so the index is descending — expressible only as raw SQL
  // here, since the SQLite index builder has no .desc() on columns.
  index('sync_runs_target_idx').on(t.targetId, sql`${t.startedAt} desc`),
  index('sync_runs_retry_idx').on(t.nextRetryAt).where(sql`next_retry_at IS NOT NULL`),
  uniqueIndex('sync_runs_one_active').on(t.targetId).where(sql`status IN ('queued', 'running')`),
])

// One pending row per target: changes coalesce while it waits for the cron sweep (migration 0012).
// Carries ids only, never values. org_id is denormalised for the per-org budget, with no reference.
export const syncOutbox = sqliteTable('sync_outbox', {
  id: text('id').primaryKey(),
  targetId: text('target_id').notNull().references(() => syncTargets.id, { onDelete: 'cascade' }),
  orgId: text('org_id').notNull(),
  createdAt: text('created_at').notNull(),
  // Last change seen while this row was pending. A run completes the row only if nothing landed
  // after it claimed it, otherwise the change would be lost.
  changedAt: text('changed_at').notNull(),
  dueAt: text('due_at').notNull(),
  claimedAt: text('claimed_at'),
  doneAt: text('done_at'),
}, (t) => [
  uniqueIndex('sync_outbox_one_pending').on(t.targetId).where(sql`done_at IS NULL`),
  index('sync_outbox_due_idx').on(t.dueAt).where(sql`done_at IS NULL`),
])

// ─────────────────────────────────────────────
// GitHub Actions OIDC pull (migration 0013, issue #43)
// ─────────────────────────────────────────────

// A rule grants read-only access to exactly one environment. Matching is on individual OIDC
// claims, never on the `sub` string, which a repository can customise.
export const oidcRepoRules = sqliteTable('oidc_repo_rules', {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id, { onDelete: 'cascade' }),
  envId: text('env_id').notNull().references(() => environments.id, { onDelete: 'cascade' }),
  provider: text('provider', { enum: ['github'] }).notNull().default('github'),
  repository: text('repository').notNull(), // "owner/name", lowercased, exact match
  repositoryId: text('repository_id'),      // GitHub's immutable id; when set it must match too
  ref: text('ref'),                         // e.g. "refs/heads/main"
  environment: text('environment'),         // a GitHub environment name
  // No onDelete in the SQL — issue #81, as for the other created_by columns.
  createdBy: text('created_by').references(() => users.id),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
}, (t) => [
  index('oidc_repo_rules_org_idx').on(t.orgId),
  index('oidc_repo_rules_lookup_idx').on(t.repository),
  // One rule per (environment, repository, constraint). COALESCE because NULLs are distinct in a
  // SQLite unique index, so without it the same grant could be added twice.
  uniqueIndex('oidc_repo_rules_unique_idx')
    .on(t.envId, t.repository, sql`COALESCE(${t.ref}, '')`, sql`COALESCE(${t.environment}, '')`),
  // Exactly one subject constraint. The migration's CHECK is unnamed; SQLite exposes no PRAGMA
  // for table constraints, so the drift test compares this predicate against the replayed DDL.
  check('oidc_repo_rules_one_constraint', sql`(ref IS NOT NULL) <> (environment IS NOT NULL)`),
])

// ─────────────────────────────────────────────
// Cron bookkeeping (migration 0016, issue #87)
// ─────────────────────────────────────────────

/**
 * Small keyed scratchpad for state the minute cron needs between ticks: the last failed
 * key-rotation bootstrap attempt, and the orphaned-blob sweep's KV list cursor. Nothing
 * secret is ever stored here.
 */
export const systemState = sqliteTable('system_state', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

/**
 * First time a `secret:` KV blob was seen with no live row pointing at it. The orphaned-blob
 * sweep only deletes a blob still unreferenced a grace period after this, which is what keeps
 * it from deleting a blob whose row is about to be committed. See lib/housekeeping.ts.
 */
export const orphanBlobCandidates = sqliteTable('orphan_blob_candidates', {
  kvKey: text('kv_key').primaryKey(),
  firstSeenAt: text('first_seen_at').notNull(),
}, (t) => [index('orphan_blob_candidates_seen_idx').on(t.firstSeenAt)])

/**
 * A durable record that an account erasure happened (issue #81, migration 0020). Anchored to
 * nothing — no foreign key — so it outlives the user and orgs it refers to, which is the whole
 * point: a sole-member erasure takes its org's `audit_log` with it, so the only surviving trail of
 * that deletion lives here. Holds only what demonstrates the act, never the personal data erased:
 * the opaque user id (links to nothing once the user row is gone), a timestamp, a count, an enum.
 * Never an email, name, IP or user agent — see 0020 and `.claude/rules/audit-log.md` in spirit.
 */
export const erasureLog = sqliteTable('erasure_log', {
  id: text('id').primaryKey(),
  erasedUserId: text('erased_user_id').notNull(),
  erasedAt: text('erased_at').notNull(),
  orgsErased: integer('orgs_erased').notNull().default(0),
  actorType: text('actor_type').notNull(),
}, (t) => [index('erasure_log_user_idx').on(t.erasedUserId), index('erasure_log_at_idx').on(t.erasedAt)])
