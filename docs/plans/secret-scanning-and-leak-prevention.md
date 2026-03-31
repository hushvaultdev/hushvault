# Secret Scanning & Leak Prevention

**Priority:** P1 — trust and differentiation
**Status:** Design approved, Phase 2 implementation

---

## API Key Leak Detection (Automatic — GitHub Native)

GitHub's secret scanning automatically detects `hv_live_*` and `hv_test_*` patterns if registered with GitHub's secret scanning partner program.

**Action items:**
1. Register `hv_live_[a-zA-Z0-9]{44}` pattern with GitHub Secret Scanning Partner Program (free, requires `security@hushvault.dev` contact)
2. Implement `POST /api/integrations/secret-scanner/github` callback endpoint
3. On callback: find matching API key in D1, revoke it, notify org owner via email + Slack

```typescript
// apps/api/src/routes/secret-scanner.ts
router.post('/github', async (c) => {
  // Verify GitHub's signature (ECDSA)
  const isValid = await verifyGitHubSignature(c)
  if (!isValid) return c.json({ error: 'UNAUTHORIZED' }, 401)

  const alerts = await c.req.json<GitHubSecretAlert[]>()

  for (const alert of alerts) {
    if (alert.type === 'hushvault_api_key') {
      // Hash the leaked token and look up in D1
      const keyHash = await sha256(alert.token)
      const apiKey = await db.select().from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash)).get()

      if (apiKey) {
        // Revoke immediately
        await db.update(apiKeys).set({ revokedAt: new Date().toISOString() })
          .where(eq(apiKeys.id, apiKey.id))

        // Notify org owner
        await sendEmail(orgOwnerEmail, 'API key leaked — revoked automatically', ...)
        await sendSlackAlert(orgId, '🚨 API key was found in a public GitHub repo and has been automatically revoked')

        writeAuditLog(c, { action: 'auth.api_key_revoke', metadata: { reason: 'leaked_in_github' } })
      }
    }
  }

  return c.json({ accepted: alerts.length })
})
```

---

## Entropy Validation (Warn on Low-Entropy Values)

Warn (not block) if a stored value looks like a non-secret:

```typescript
function calculateEntropy(str: string): number {
  const freq = new Map<string, number>()
  for (const char of str) {
    freq.set(char, (freq.get(char) ?? 0) + 1)
  }
  return -[...freq.values()]
    .map(f => (f / str.length) * Math.log2(f / str.length))
    .reduce((a, b) => a + b, 0)
}

// In secret create/update route:
const entropy = calculateEntropy(value)
if (entropy < 3.0 && value.length > 8) {
  // Return 200 but include advisory
  return c.json({
    data: created,
    warning: 'LOW_ENTROPY',
    hint: 'This value has low entropy and may not be a secret. Confirm it is intentional.',
  })
}
```

---

## Common Test Value Detection

Block storing obviously-invalid test values that get committed by mistake:

```typescript
const BLOCKED_VALUES = [
  'changeme', 'password', 'secret', 'example', 'placeholder',
  'your_api_key_here', 'REPLACE_ME', 'TODO', 'xxx',
]

if (BLOCKED_VALUES.some(v => value.toLowerCase().includes(v))) {
  return c.json({
    error: 'VALIDATION_ERROR',
    message: 'Value appears to be a placeholder. Please provide the actual secret value.',
  }, 400)
}
```

---

## Secret Drift Detection

(See `webhook-and-integrations.md` for full implementation)

Daily cron compares HushVault values against CF Pages/Workers deployed values.
Alerts on divergence via Slack + audit log entry.

Pro+ feature (`secretDriftDetection: true` in tiers.ts).

---

## Canary Tokens (Enterprise Roadmap)

A synthetic "honeypot" secret injected alongside real secrets. If this specific value is used outside HushVault (API call detected from unexpected origin), it triggers an alert.

Implementation: enterprise-only feature using Cloudflare Workers with a unique webhook URL as the canary value. When that URL is fetched, it triggers the breach alert.

Document as Phase 5 roadmap item.
