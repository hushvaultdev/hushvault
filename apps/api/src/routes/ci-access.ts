import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import type { Env } from '../index'
import { createPrefixedId } from '../lib/auth'
import { getRequestIp, writeAuditLog } from '../lib/security'
import { integrationWriteRateLimit, requireAuth, requireCurrentAdmin, requireHuman, requireRole } from '../middleware/auth'

// Which GitHub Actions workflow may read which environment (issue #43). Managing these rules is the whole of the
// access control for the OIDC pull, so it is human-only (API keys and CI tokens are refused), admin+, the caller's
// current membership is re-read, and every change is audited. No credential is involved: GitHub proves identity
// with a signed token, so there is nothing secret to store here.
export const ciAccessRouter = new Hono<{ Bindings: Env }>()

ciAccessRouter.use('*', requireAuth)

const adminOnly = [requireHuman, requireRole('admin'), requireCurrentAdmin] as const

/** "owner/name" as GitHub reports it in the `repository` claim. Compared lowercased. */
const REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const MAX_RULES_PER_ORG = 100

const ruleSchema = z.object({
  envId: z.string().min(1).max(64),
  repository: z.string().min(3).max(140).regex(REPOSITORY, 'Repository must look like owner/name'),
  // GitHub's immutable numeric id. Optional, but without it a repository rename or transfer changes who matches.
  repositoryId: z.string().regex(/^[0-9]{1,20}$/, 'Repository id must be numeric').optional(),
  ref: z.string().min(1).max(256).regex(/^refs\/[A-Za-z0-9._\-/]+$/, 'Ref must look like refs/heads/main').optional(),
  environment: z.string().min(1).max(255).optional(),
}).strict().refine((v) => (v.ref === undefined) !== (v.environment === undefined), {
  message: 'Provide exactly one of ref or environment',
})

type RuleRow = {
  id: string; env_id: string; repository: string; repository_id: string | null
  ref: string | null; environment: string | null; created_at: string; last_used_at: string | null
}

const COLUMNS = 'id, env_id, repository, repository_id, ref, environment, created_at, last_used_at'

function toDto(row: RuleRow) {
  return {
    id: row.id, envId: row.env_id, repository: row.repository, repositoryId: row.repository_id,
    ref: row.ref, environment: row.environment, createdAt: row.created_at, lastUsedAt: row.last_used_at,
  }
}

const validationHook = (result: { success: boolean; error?: { issues: { message: string }[] } }, c: { json: (body: unknown, status: 400) => Response }) => {
  if (!result.success) return c.json({ error: 'VALIDATION_ERROR', message: result.error?.issues[0]?.message ?? 'Invalid request' }, 400)
  return undefined
}

// GET /api/ci-access/github/rules
ciAccessRouter.get('/github/rules', ...adminOnly, async (c) => {
  const auth = c.get('auth')
  const rows = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM oidc_repo_rules WHERE org_id = ? ORDER BY created_at DESC LIMIT 200`).bind(auth.orgId).all<RuleRow>()
  return c.json({ data: (rows.results ?? []).map(toDto) })
})

// POST /api/ci-access/github/rules
ciAccessRouter.post('/github/rules', ...adminOnly, integrationWriteRateLimit, zValidator('json', ruleSchema, validationHook), async (c) => {
  const auth = c.get('auth')
  const body = c.req.valid('json')

  // The environment must belong to the caller's organisation (cross-org grants are the obvious attack).
  const environment = await c.env.DB.prepare(
    'SELECT e.id FROM environments e INNER JOIN projects p ON p.id = e.project_id WHERE e.id = ? AND p.org_id = ? LIMIT 1',
  ).bind(body.envId, auth.orgId).first<{ id: string }>()
  if (!environment) return c.json({ error: 'NOT_FOUND', message: 'Environment not found' }, 404)

  const id = createPrefixedId('ocr')
  const now = new Date().toISOString()
  let inserted
  try {
    // The cap is enforced inside the INSERT so concurrent requests cannot exceed it.
    inserted = await c.env.DB.prepare(
      'INSERT INTO oidc_repo_rules (id, org_id, env_id, provider, repository, repository_id, ref, environment, created_by, created_at) SELECT ?, ?, ?, \'github\', ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM oidc_repo_rules WHERE org_id = ?) < ?',
    ).bind(id, auth.orgId, body.envId, body.repository.toLowerCase(), body.repositoryId ?? null, body.ref ?? null, body.environment ?? null, auth.userId, now, auth.orgId, MAX_RULES_PER_ORG).run()
  } catch (err) {
    if (/UNIQUE/i.test(err instanceof Error ? err.message : String(err))) {
      // Deliberately specific: the unique index ignores repository_id, so an admin hardening an existing rule by
      // pinning the id lands here and must know the old, unpinned rule is still live and still granting access.
      return c.json({ error: 'CONFLICT', message: 'A rule for this environment, repository and ref/environment already exists. Delete it first — adding a second rule would leave the existing one granting access.' }, 409)
    }
    throw err
  }
  void inserted
  const row = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM oidc_repo_rules WHERE id = ? AND org_id = ? LIMIT 1`).bind(id, auth.orgId).first<RuleRow>()
  if (!row) return c.json({ error: 'LIMIT_REACHED', message: 'This organisation has reached its rule limit' }, 409)

  await writeAuditLog(c.env, {
    orgId: auth.orgId, actorId: auth.userId, actorType: auth.actorType, action: 'ci.rule.create',
    resourceType: 'oidc_repo_rule', resourceId: id, ip: getRequestIp(c), userAgent: c.req.header('user-agent'),
  })
  return c.json({ data: toDto(row) }, 201)
})

// DELETE /api/ci-access/github/rules/:id
ciAccessRouter.delete('/github/rules/:id', ...adminOnly, integrationWriteRateLimit, async (c) => {
  const auth = c.get('auth')
  const { id } = c.req.param()
  const result = await c.env.DB.prepare('DELETE FROM oidc_repo_rules WHERE id = ? AND org_id = ?').bind(id, auth.orgId).run()
  if (Number(result.meta.changes ?? 0) !== 1) return c.json({ error: 'NOT_FOUND', message: 'Rule not found' }, 404)
  await writeAuditLog(c.env, {
    orgId: auth.orgId, actorId: auth.userId, actorType: auth.actorType, action: 'ci.rule.delete',
    resourceType: 'oidc_repo_rule', resourceId: id, ip: getRequestIp(c), userAgent: c.req.header('user-agent'),
  })
  return c.json({ data: { deleted: true } })
})
