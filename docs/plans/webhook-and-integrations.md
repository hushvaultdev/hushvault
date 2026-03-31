# Webhooks & Integrations

**Priority:** P2 — core product differentiation vs Doppler/Infisical
**Status:** Feature flags exist in tiers.ts, implementation pending

---

## The Gap We're Filling

| Integration | HushVault | Infisical | Doppler |
|-------------|-----------|-----------|---------|
| CF Pages sync (push-on-save, no re-deploy) | ✅ | ❌ | ❌ |
| CF Workers environment sync | ✅ | ❌ | ❌ |
| GitHub Environments sync | ✅ | Partial | ✅ |
| Outbound webhooks (HMAC signed) | ✅ | ✅ | ✅ |
| Slack alerts | ✅ (Pro+) | ✅ | ✅ |
| Secret drift detection | ✅ (Pro+) | ❌ | Partial |

**Key differentiator:** CF Pages sync is **push-on-save** — update a secret in HushVault, it appears in CF Pages environment variables immediately without a re-deploy. Infisical and Doppler are pull-based (require CI trigger).

---

## Cloudflare Pages Sync

Triggered after every `secret.create`, `secret.update`, `secret.delete` on an environment linked to a CF Pages project.

```typescript
// apps/api/src/integrations/cf-pages.ts
export async function syncToCfPages(
  env: Env,
  orgId: string,
  envId: string,
  secrets: Record<string, string>  // resolved plaintext map
) {
  // Get CF integration config for this org
  const config = await getCfIntegrationConfig(env, orgId)
  if (!config) return  // CF Pages not connected for this org

  // CF API: update deployment config variables
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/pages/projects/${config.projectName}/deployments`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${config.cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deployment_configs: {
          production: {
            env_vars: Object.fromEntries(
              Object.entries(secrets).map(([k, v]) => [k, { value: v }])
            ),
          },
        },
      }),
    }
  )

  if (!response.ok) {
    // Log failure but don't block the secret save
    console.error('CF Pages sync failed:', await response.text())
  }
}
```

CF integration config stored in a new `integrations` table:
```typescript
integrations: {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull(),
  type: text('type').notNull(),          // 'cf_pages' | 'cf_workers' | 'github' | 'slack'
  config: text('config').notNull(),      // JSON: accountId, projectName, apiToken (encrypted)
  createdAt: text('created_at').notNull(),
}
```

**CF API token** stored encrypted using `encryptSecret()` — never plaintext in D1.

---

## Cloudflare Workers Sync

Same pattern as CF Pages, using Workers secrets API:
```
PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/secrets
Body: { name: "KEY", text: "value", type: "secret_text" }
```

---

## Outbound Webhooks

Orgs register webhook endpoints:
```
POST /api/webhooks          → create webhook (url, secret, events[])
GET  /api/webhooks          → list webhooks
DELETE /api/webhooks/:id    → delete webhook
POST /api/webhooks/:id/test → send test payload
```

**Delivery via Workers Queues** (async, with retry):
```typescript
// On secret.update:
await env.WEBHOOK_QUEUE.send({
  orgId,
  event: 'secret.updated',
  payload: { secretId, key, envId, timestamp: new Date().toISOString() },
  // Never include: value
})
```

**HMAC signature** on each delivery:
```
X-HushVault-Signature: sha256=base64(HMAC-SHA256(body, webhookSecret))
X-HushVault-Event: secret.updated
X-HushVault-Delivery: {nanoid}
```

Retry: 3 attempts with exponential backoff (1min, 5min, 30min).
Dead letter: failed deliveries stored in `webhookDeliveries` table, viewable in dashboard.

---

## Slack Integration

```
POST /api/integrations/slack/connect   → OAuth flow start
GET  /api/integrations/slack/callback  → exchange code, store access_token (encrypted)
DELETE /api/integrations/slack/connect → disconnect
```

Alert triggers (Pro+):
- Secret approaching expiry (if `expiresAt` set on a secret)
- Plan limit at 80% (secrets count, project count)
- Secret drift detected (HushVault ≠ deployed value)
- Audit event: member removed, plan changed
- Payment failed (grace period started)

---

## Secret Drift Detection

Pro+ feature. Runs daily via Cron Trigger.

```typescript
// Compare HushVault secrets for an env against what's actually in CF Pages
export async function detectDrift(env: Env, orgId: string) {
  // 1. Get HushVault resolved secrets
  const hvSecrets = await resolveEnvironment(env, envId)

  // 2. Get CF Pages current env vars
  const cfVars = await fetchCfPagesVars(config.accountId, config.projectName, cfApiToken)

  // 3. Compare
  const drifted = Object.entries(hvSecrets).filter(
    ([key, value]) => cfVars[key] !== value
  )

  if (drifted.length > 0) {
    await sendSlackAlert(orgId, `⚠️ Secret drift detected: ${drifted.map(([k]) => k).join(', ')}`)
    writeAuditLog(c, { action: 'secret.drift_detected', metadata: { keys: drifted.map(([k]) => k) } })
  }
}
```

---

## GitHub Environments Sync

Sync secrets to GitHub repo/environment secrets via GitHub App (not PAT — apps don't expire):

```
POST /api/integrations/github/connect   → OAuth app install
POST /api/integrations/github/sync      → push all secrets to GitHub environment
```

Uses GitHub API: `PUT /repos/{owner}/{repo}/environments/{env_name}/secrets/{secret_name}` with libsodium-encrypted value (GitHub requires its own encryption format).

---

## wrangler.toml Addition

```toml
[[queues.producers]]
queue = "webhook-delivery"
binding = "WEBHOOK_QUEUE"

[[queues.consumers]]
queue = "webhook-delivery"
max_batch_size = 10
max_retries = 3
```
