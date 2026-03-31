# HushVault — Subscription Service Layer

**Status:** Approved — Phase 4 implementation (Weeks 19–24)
**Date:** 2026-03-31
**Dogfood target:** alpeshnakar.github.io uses HushVault Free tier as first customer

---

## Context

HushVault has four pricing tiers: Free / Pro / Team / Enterprise.
Every API call must be checked against the requesting organisation's plan — enforcing limits (secret count, project count, user seats) and feature gates (SSO, custom domains, audit log retention, RBAC).

This plan defines the **five components** of the subscription service layer, the **Stripe integration**, the **dogfood migration path** for `alpeshnakar.github.io`, and the **billing dashboard UI**.

---

## Architecture Overview

```
Incoming API Request
        │
        ▼
┌─────────────────────────────────────────────────────┐
│  Auth Middleware (JWT / API Key)                     │
│  → resolves orgId + userId                          │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  SubscriptionMiddleware                              │
│  → loads OrgPlan (from D1, cached in KV 5min TTL)  │
│  → attaches planFeatures to context                 │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  Route Handler                                       │
│  → calls planEnforcer.assertFeature('sso')          │
│  → calls planEnforcer.assertLimit('secrets', count) │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  Stripe (billing events)                             │
│  Webhooks → update orgs.plan in D1                  │
│  Checkout → hosted payment page                     │
│  Portal → customer self-serve plan changes          │
└─────────────────────────────────────────────────────┘
```

---

## Five Core Components

### 1. SubscriptionTiers (`apps/api/src/billing/tiers.ts`)

Single source of truth for what each plan includes.

```typescript
export type Plan = 'free' | 'pro' | 'team' | 'enterprise'

export interface PlanLimits {
  maxProjects: number         // -1 = unlimited
  maxSecretsTotal: number     // across all projects
  maxUsers: number
  secretHistoryDays: number
  auditLogDays: number
}

export interface PlanFeatures {
  computedSecrets: boolean
  branchInheritance: boolean
  shareLinks: boolean
  cfPagesSync: boolean
  githubActionsSync: boolean
  slackAlerts: boolean
  secretDriftDetection: boolean
  sso: boolean                // Google + GitHub OAuth
  saml: boolean               // Enterprise only
  customDomain: boolean
  rbac: boolean               // Granular roles beyond owner/member
  complianceExport: boolean
  prioritySupport: boolean
}

export interface PlanDefinition {
  plan: Plan
  price: { monthly: number; annual: number }  // USD cents
  limits: PlanLimits
  features: PlanFeatures
}

export const PLANS: Record<Plan, PlanDefinition> = {
  free: {
    plan: 'free',
    price: { monthly: 0, annual: 0 },
    limits: {
      maxProjects: 3,
      maxSecretsTotal: 100,
      maxUsers: 2,
      secretHistoryDays: 30,
      auditLogDays: 7,
    },
    features: {
      computedSecrets: true,       // ← differentiator, free
      branchInheritance: true,     // ← differentiator, free
      shareLinks: true,            // ← differentiator, free
      cfPagesSync: true,           // ← differentiator, free
      githubActionsSync: true,
      slackAlerts: false,
      secretDriftDetection: false,
      sso: false,
      saml: false,
      customDomain: false,
      rbac: false,
      complianceExport: false,
      prioritySupport: false,
    },
  },

  pro: {
    plan: 'pro',
    price: { monthly: 1200, annual: 10800 },  // $12/user/mo, cap $60
    limits: {
      maxProjects: -1,
      maxSecretsTotal: 1000,
      maxUsers: 5,
      secretHistoryDays: 365,
      auditLogDays: 90,
    },
    features: {
      computedSecrets: true,
      branchInheritance: true,
      shareLinks: true,
      cfPagesSync: true,
      githubActionsSync: true,
      slackAlerts: true,
      secretDriftDetection: true,
      sso: false,
      saml: false,
      customDomain: false,
      rbac: false,
      complianceExport: false,
      prioritySupport: true,
    },
  },

  team: {
    plan: 'team',
    price: { monthly: 9900, annual: 89100 },  // $99/mo flat
    limits: {
      maxProjects: -1,
      maxSecretsTotal: -1,
      maxUsers: 20,
      secretHistoryDays: 730,
      auditLogDays: 365,
    },
    features: {
      computedSecrets: true,
      branchInheritance: true,
      shareLinks: true,
      cfPagesSync: true,
      githubActionsSync: true,
      slackAlerts: true,
      secretDriftDetection: true,
      sso: true,
      saml: false,
      customDomain: true,
      rbac: true,
      complianceExport: true,
      prioritySupport: true,
    },
  },

  enterprise: {
    plan: 'enterprise',
    price: { monthly: -1, annual: -1 },  // custom
    limits: {
      maxProjects: -1,
      maxSecretsTotal: -1,
      maxUsers: -1,
      secretHistoryDays: -1,
      auditLogDays: -1,
    },
    features: {
      computedSecrets: true,
      branchInheritance: true,
      shareLinks: true,
      cfPagesSync: true,
      githubActionsSync: true,
      slackAlerts: true,
      secretDriftDetection: true,
      sso: true,
      saml: true,
      customDomain: true,
      rbac: true,
      complianceExport: true,
      prioritySupport: true,
    },
  },
}

export function getPlan(plan: Plan): PlanDefinition {
  return PLANS[plan]
}
```

---

### 2. PlanEnforcer (`apps/api/src/billing/enforcer.ts`)

Central enforcer used inside route handlers to check features + limits.

```typescript
import { Context } from 'hono'
import { getPlan, Plan, PlanFeatures } from './tiers.js'
import type { Env } from '../index.js'

export class PlanEnforcer {
  private plan: Plan
  private features: PlanFeatures

  constructor(plan: Plan) {
    this.plan = plan
    this.features = getPlan(plan).features
  }

  // Throws 403 if feature not available on current plan
  assertFeature(feature: keyof PlanFeatures, c: Context<{ Bindings: Env }>): void {
    if (!this.features[feature]) {
      const upgradeTo = this.getUpgradeTier(feature)
      c.res = c.json({
        error: 'PLAN_LIMIT_EXCEEDED',
        message: `${feature} requires ${upgradeTo} plan or higher`,
        upgrade: `https://hushvault.dev/pricing`,
        currentPlan: this.plan,
        requiredPlan: upgradeTo,
      }, 403) as any
      throw new Error('plan_gate')  // caught by route handler
    }
  }

  // Throws 429 if count >= limit
  assertLimit(
    limitKey: 'maxProjects' | 'maxSecretsTotal' | 'maxUsers',
    currentCount: number,
    c: Context<{ Bindings: Env }>
  ): void {
    const limit = getPlan(this.plan).limits[limitKey]
    if (limit !== -1 && currentCount >= limit) {
      c.res = c.json({
        error: 'LIMIT_REACHED',
        message: `Your plan allows ${limit} ${limitKey.replace('max', '').toLowerCase()}`,
        upgrade: `https://hushvault.dev/pricing`,
        currentPlan: this.plan,
        limit,
        current: currentCount,
      }, 429) as any
      throw new Error('plan_limit')
    }
  }

  private getUpgradeTier(feature: keyof PlanFeatures): Plan {
    const tiers: Plan[] = ['free', 'pro', 'team', 'enterprise']
    for (const tier of tiers) {
      if (getPlan(tier).features[feature]) return tier
    }
    return 'enterprise'
  }
}
```

---

### 3. SubscriptionMiddleware (`apps/api/src/middleware/subscription.ts`)

Hono middleware that loads the org's plan and attaches `PlanEnforcer` to context.
Uses KV for 5-minute caching to avoid D1 queries on every request.

```typescript
import { createMiddleware } from 'hono/factory'
import { drizzle } from 'drizzle-orm/d1'
import { eq } from 'drizzle-orm'
import { organisations } from '../db/schema.js'
import { PlanEnforcer } from '../billing/enforcer.js'
import type { Plan } from '../billing/tiers.js'
import type { Env } from '../index.js'

declare module 'hono' {
  interface ContextVariableMap {
    planEnforcer: PlanEnforcer
    orgPlan: Plan
  }
}

export const subscriptionMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const user = c.get('user')  // set by auth middleware
  if (!user?.orgId) return next()

  const cacheKey = `plan:${user.orgId}`

  // Try KV cache first (5 min TTL)
  let plan = await c.env.SECRETS_KV.get(cacheKey) as Plan | null

  if (!plan) {
    const db = drizzle(c.env.DB)
    const org = await db.select({ plan: organisations.plan })
      .from(organisations)
      .where(eq(organisations.id, user.orgId))
      .get()

    plan = (org?.plan ?? 'free') as Plan
    await c.env.SECRETS_KV.put(cacheKey, plan, { expirationTtl: 300 })
  }

  c.set('orgPlan', plan)
  c.set('planEnforcer', new PlanEnforcer(plan))
  return next()
})
```

**Usage in route handlers:**
```typescript
router.post('/', requireAuth, subscriptionMiddleware, async (c) => {
  const db = drizzle(c.env.DB)
  const enforcer = c.get('planEnforcer')

  // Check project limit before creating
  const existingCount = await db.select({ count: count() }).from(projects)
    .where(eq(projects.orgId, user.orgId)).get()

  enforcer.assertLimit('maxProjects', existingCount?.count ?? 0, c)

  // ... create project
})
```

---

### 4. Stripe Integration (`apps/api/src/billing/stripe.ts`)

Stripe handles checkout, invoicing, and plan changes. Workers-compatible via `stripe-node` v11.10+.

```typescript
import Stripe from 'stripe'
import type { Env } from '../index.js'

export function getStripe(env: Env): Stripe {
  return new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20',
    httpClient: Stripe.createFetchHttpClient(),  // required for Workers
  })
}

// Stripe Price IDs (set in wrangler.toml [vars] or secrets)
export const STRIPE_PRICES = {
  pro_monthly: 'price_pro_monthly',      // replace with actual IDs
  pro_annual: 'price_pro_annual',
  team_monthly: 'price_team_monthly',
  team_annual: 'price_team_annual',
} as const
```

**Stripe routes (`apps/api/src/routes/billing.ts`):**

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/billing/checkout | Create Stripe Checkout session → redirect URL |
| POST | /api/billing/portal | Create Stripe Customer Portal session |
| POST | /api/billing/webhook | Handle Stripe events (plan changes, cancellations) |
| GET | /api/billing/status | Current plan, next invoice, usage summary |

**Webhook events handled:**
```typescript
// apps/api/src/routes/billing.ts
const HANDLED_EVENTS = [
  'checkout.session.completed',    // → upgrade org plan in D1, invalidate KV cache
  'customer.subscription.updated', // → plan change (upgrade/downgrade)
  'customer.subscription.deleted', // → downgrade to free
  'invoice.payment_failed',        // → grace period (3 days), then downgrade
]
```

**Webhook signature verification (WebCrypto — no Node.js needed):**
```typescript
// Stripe webhook signature uses HMAC-SHA256
// stripe-node handles this automatically when using Stripe.createFetchHttpClient()
const event = await stripe.webhooks.constructEventAsync(
  body,
  signature,
  env.STRIPE_WEBHOOK_SECRET,
  undefined,
  Stripe.createSubtleCryptoProvider()  // WebCrypto provider
)
```

---

### 5. Billing Dashboard UI (`apps/web/src/app/dashboard/billing/`)

Four sections, modeled on the marketing engine Settings UI pattern:

```
┌─────────────────────────────────────────────────────┐
│ 1. CURRENT PLAN                                      │
│    [Free] / [Pro $12/user] / [Team $99/mo]          │
│    Renewal date, next invoice amount                 │
│    [Manage Billing] → Stripe Portal                 │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ 2. USAGE                                            │
│    Projects: 2 / 3                                  │
│    Secrets: 47 / 100                                │
│    Users: 1 / 2                                     │
│    [progress bars with warning at 80%]              │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ 3. PLAN FEATURES                                    │
│    ✅ Computed secrets                              │
│    ✅ Branch inheritance                            │
│    ✅ Share links                                   │
│    ❌ Slack alerts     [Upgrade to Pro →]           │
│    ❌ SSO              [Upgrade to Team →]          │
│    ❌ SAML             [Contact Sales →]            │
└─────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────┐
│ 4. UPGRADE CTA                                      │
│    [Upgrade to Pro — $12/user/month]                │
│    → Opens Stripe Checkout                          │
│    "Includes Slack alerts, drift detection, 90-day  │
│     audit logs, and priority support."              │
└─────────────────────────────────────────────────────┘
```

**API calls from billing page:**
- `GET /api/billing/status` → plan, usage counts, renewal date
- `POST /api/billing/checkout` → returns `{ url }` → redirect to Stripe
- `POST /api/billing/portal` → returns `{ url }` → redirect to Stripe portal

---

## D1 Schema Additions

```typescript
// Add to organisations table in schema.ts
organisations: {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  plan: text('plan', { enum: ['free', 'pro', 'team', 'enterprise'] })
    .notNull()
    .default('free'),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubscriptionId: text('stripe_subscription_id'),
  planExpiresAt: text('plan_expires_at'),   // null = active
  gracePeriodEndsAt: text('grace_period_ends_at'),  // payment failure grace
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}

// Usage tracking (lightweight, updated on write operations)
usageSnapshots: {
  id: text('id').primaryKey(),
  orgId: text('org_id').notNull().references(() => organisations.id),
  periodStart: text('period_start').notNull(),  // ISO date
  secretsCreated: integer('secrets_created').notNull().default(0),
  apiCallsTotal: integer('api_calls_total').notNull().default(0),
}
```

**Migration:** `apps/api/migrations/0002_subscription_fields.sql`

---

## KV Cache Invalidation

When a Stripe webhook updates an org's plan:
```typescript
// Invalidate plan cache immediately so next request picks up new plan
await env.SECRETS_KV.delete(`plan:${orgId}`)
```

Cache TTL is 5 minutes — acceptable lag for non-webhook paths (e.g., admin overrides).

---

## Dogfood Plan: alpeshnakar.github.io → HushVault Free

**When:** After Phase 1 MVP ships (target: Week 8)
**What:** Replace all manual `.env.local` / GitHub Secrets for app secrets with HushVault

**Migration steps:**
1. `hushvault login` on dev machine
2. `hushvault init` in `c:/GitHub/alpeshnakar.github.io` → creates `.hushvault.json`
3. `hushvault set RESEND_API_KEY "..."` for each app secret
4. Replace `npm run dev` with `hushvault run -- npm run dev`
5. Update `.github/workflows/deploy.yml` to use `hushvaultdev/secrets-action`
6. Remove individual `env:` blocks from GitHub Actions workflow
7. Verify CF Pages sync pushes variables automatically on save

**Free tier is sufficient for alpeshnakar.github.io:**
- 1 project (portfolio)
- ~15 secrets (well under 100 limit)
- 1 user
- All differentiator features available (computed secrets, CF Pages sync, GitHub action)

---

## Implementation Order

### Phase 4A — Billing Foundation (Week 19)
- [ ] Create `apps/api/src/billing/tiers.ts` (PLANS constant)
- [ ] Create `apps/api/src/billing/enforcer.ts` (PlanEnforcer class)
- [ ] Create `apps/api/src/middleware/subscription.ts` (with KV cache)
- [ ] D1 migration: `0002_subscription_fields.sql`
- [ ] Wire `subscriptionMiddleware` into project + secret create routes

### Phase 4B — Stripe (Week 20)
- [ ] Create `apps/api/src/billing/stripe.ts`
- [ ] Create `apps/api/src/routes/billing.ts` (checkout, portal, webhook, status)
- [ ] Set up Stripe products + prices (matching PLANS)
- [ ] Webhook signature verification with `Stripe.createSubtleCryptoProvider()`
- [ ] `wrangler secret put STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`
- [ ] Test with Stripe CLI: `stripe listen --forward-to localhost:8787/api/billing/webhook`

### Phase 4C — Dashboard Billing UI (Week 21)
- [ ] `apps/web/src/app/dashboard/billing/page.tsx`
- [ ] Current Plan section (plan name, renewal, Manage Billing button)
- [ ] Usage section (progress bars, warning at 80%)
- [ ] Features section (✅/❌ per feature with upgrade CTA)
- [ ] Upgrade CTA (Stripe Checkout redirect)

### Phase 4D — Dogfood Migration (Week 22)
- [ ] Phase 1 MVP must be deployed and stable
- [ ] Migrate `alpeshnakar.github.io` secrets to HushVault Free
- [ ] Remove Infisical plan references entirely
- [ ] Document dogfood experience → use as case study for Product Hunt launch

---

## Feature Flag vs Limit vs Soft Gate

| Type | Example | Behaviour |
|------|---------|-----------|
| **Feature flag** | SSO, SAML, RBAC | Hard 403 — feature simply doesn't exist |
| **Hard limit** | maxProjects, maxSecretsTotal | Hard 429 with upgrade prompt |
| **Soft gate** | auditLogDays | Data exists, just truncated in UI |

Soft gates are simpler — store everything, filter on read. Reduces migration complexity when upgrading.

---

## Error Response Contract

All plan-gate errors return a consistent shape so the dashboard can render upgrade prompts:

```typescript
{
  "error": "PLAN_LIMIT_EXCEEDED" | "LIMIT_REACHED",
  "message": "Human-readable explanation",
  "upgrade": "https://hushvault.dev/pricing",
  "currentPlan": "free",
  "requiredPlan": "pro"  // lowest tier that unlocks this
}
```

The dashboard intercepts 403/429 responses with these fields and renders an upgrade modal automatically — no per-route UI logic needed.

---

## Open Questions

| Question | Decision |
|----------|----------|
| Grace period on payment failure? | 3 days, then downgrade to free |
| What happens to secrets over limit when downgrading? | Read-only (can read, not create new ones) |
| Usage-based vs seat-based billing for Pro? | Per-user for Pro, flat for Team |
| Annual discount? | 25% (monthly × 0.75 × 12) |
| Stripe Tax? | Enable from Stripe dashboard — no code changes |
| Self-hosters on free plan? | No billing layer runs for self-hosted — tiers.ts still enforces limits |

---

*This plan is the subscription service counterpart to the product plan in `cloudflare-secrets-manager-saas.md`. Read that document first for the full market context, tech stack rationale, and phase timeline.*
