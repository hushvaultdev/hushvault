# Web MVP Implementation Plan

**Priority:** P1 — immediate execution plan for `apps/web`
**Status:** Ready for implementation
**Date:** 2026-05-18

---

## Goal

Translate the frontend strategy into a concrete implementation plan for the Next.js app in `apps/web`.

This plan covers:
- route structure
- layout boundaries
- shared components
- page delivery order
- dependencies between marketing, auth, onboarding, and dashboard surfaces

---

## Constraints

- Current `apps/web` is a minimal Next.js 14 App Router app.
- The product must support both marketing and authenticated product surfaces.
- The first implementation pass should prioritize product clarity and shell quality over feature completeness.
- The UI should reflect the approved frontend direction in `docs/plans/frontend-experience-and-design-system.md`.

---

## Target Route Structure

Recommended route groups:

```text
apps/web/src/app/
  (marketing)/
    page.tsx
    pricing/page.tsx
    security/page.tsx
  (auth)/
    sign-in/page.tsx
    sign-up/page.tsx
  (dashboard)/
    dashboard/page.tsx
    onboarding/page.tsx
    projects/[projectId]/environments/[envId]/page.tsx
    integrations/page.tsx
    billing/page.tsx
    audit/page.tsx
```

Shared layout boundaries:
- marketing layout for header, footer, and wide editorial sections
- auth layout for focused conversion pages
- dashboard layout for app shell, sidebar, top bar, and command surfaces

---

## Shared UI Foundation

Build these first before page-level work expands:

### Design Tokens

Create global CSS variables for:
- colors
- spacing
- radii
- borders
- shadows
- typography
- transitions

These tokens should live close to the root layout and support both marketing and product surfaces.

### Base Primitives

Create reusable primitives for:
- `Button`
- `Badge`
- `Card`
- `Section`
- `Input`
- `Select`
- `Tabs`
- `Table`
- `EmptyState`
- `UsageMeter`
- `StatusDot`

### Shell Primitives

Create reusable shell pieces for:
- `MarketingHeader`
- `MarketingFooter`
- `DashboardSidebar`
- `DashboardTopbar`
- `PageHeader`
- `CommandPaletteTrigger`
- `EnvironmentSwitcher`
- `ProjectSwitcher`

---

## Delivery Phases

## Phase 1: Foundation And Homepage

### Outcome

Establish brand, layout, and design system direction with a strong homepage and reusable shell pieces.

### Files And Areas

- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/globals.css` or equivalent global stylesheet
- `apps/web/src/app/(marketing)/page.tsx`
- shared components under `apps/web/src/components/`

### Deliverables

- root typography and color tokens
- marketing header and footer
- hero section with composed product scene
- trust band
- workflow storytelling sections
- competitor-aware pricing teaser
- primary CTA flow

### Notes

The homepage should show enough product context that a visitor understands what HushVault does before scrolling deep.

---

## Phase 2: Pricing And Auth Surfaces

### Outcome

Support conversion and basic self-serve account entry.

### Files And Areas

- `apps/web/src/app/(marketing)/pricing/page.tsx`
- `apps/web/src/app/(auth)/sign-in/page.tsx`
- `apps/web/src/app/(auth)/sign-up/page.tsx`

### Deliverables

- pricing table aligned to Free / Pro / Team / Enterprise
- plan comparison rows
- sign-up page with GitHub and Google first
- sign-in page with password fallback affordance
- trust copy around encryption and self-hosting where appropriate

### Notes

Pricing must answer who each plan is for and what operational pain it removes.

---

## Phase 3: Dashboard Shell And Onboarding

### Outcome

Make the app feel real even before every backend feature exists.

### Files And Areas

- `apps/web/src/app/(dashboard)/dashboard/page.tsx`
- `apps/web/src/app/(dashboard)/onboarding/page.tsx`
- dashboard layout and shell components

### Deliverables

- dashboard sidebar and top bar
- project and environment switching patterns
- onboarding stepper
- create-project panel
- add-first-secret panel
- CLI installation panel
- success and completion states

### Notes

The onboarding flow should be treated as a product tour with real setup actions, not a modal wizard bolted on late.

---

## Phase 4: Secrets Management Core Screen

### Outcome

Build the product's center-of-gravity screen.

### Files And Areas

- `apps/web/src/app/(dashboard)/projects/[projectId]/environments/[envId]/page.tsx`
- secrets table and detail components

### Deliverables

- secrets table with filtering and badges
- inherited/computed/overridden indicators
- row action patterns
- detail drawer or side panel
- recent version and activity history blocks
- sync status region
- empty state for first secret creation

### Notes

This screen should prioritize readability and speed over ornamental design. It is where trust and daily workflow converge.

---

## Phase 5: Billing, Integrations, And Audit Views

### Outcome

Expose the freemium model clearly inside the product.

### Files And Areas

- `apps/web/src/app/(dashboard)/billing/page.tsx`
- `apps/web/src/app/(dashboard)/integrations/page.tsx`
- `apps/web/src/app/(dashboard)/audit/page.tsx`

### Deliverables

- billing summary and usage cards
- feature availability and upgrade CTA surfaces
- integration status cards
- recent sync events and failure states
- audit log feed with actor and source context

### Notes

These pages should reinforce why paid tiers exist by showing operational leverage rather than marketing copy alone.

---

## Component Breakdown

### Marketing Components

- `HeroProductScene`
- `TrustBand`
- `WorkflowSection`
- `ComparisonStrip`
- `PricingTeaser`

### Auth Components

- `OAuthButtonGroup`
- `AuthCard`
- `AuthDivider`

### Dashboard Components

- `DashboardShell`
- `SidebarSection`
- `TopbarSearch`
- `UsageCard`
- `SyncStatusCard`
- `ActivityFeed`

### Secrets Components

- `SecretsTable`
- `SecretRow`
- `SecretBadge`
- `SecretDetailPanel`
- `SecretVersionList`

### Billing And Governance Components

- `PlanCard`
- `FeatureGateCard`
- `IntegrationStatusCard`
- `AuditEventRow`

---

## Implementation Order Recommendation

1. Root design tokens and typography
2. Marketing header, footer, and homepage
3. Shared button, card, badge, and section primitives
4. Pricing page
5. Auth pages
6. Dashboard shell
7. Onboarding flow
8. Secrets screen
9. Billing page
10. Integrations page
11. Audit log page

This order gives the product a credible public face first, then a believable self-serve flow, then the in-app surfaces that reinforce the freemium model.

---

## Risks To Avoid

- importing a heavy admin theme that conflicts with the intended brand
- building page-by-page without shared tokens and primitives
- over-optimizing dark mode before the primary visual direction is solid
- hiding plan logic until billing pages instead of surfacing it in-product
- letting the onboarding flow become visually disconnected from the dashboard shell

---

## Validation Criteria

The implementation plan is successful if the first shipped web pass:
- looks clearly differentiated from common template SaaS products
- makes the product understandable from the homepage quickly
- makes sign-up and first-run setup feel low-friction
- makes the dashboard feel like a real operational tool
- creates natural placement for freemium upgrade signals

---

## Immediate Next Action

Begin implementation with:
1. route-group restructuring for marketing, auth, and dashboard shells
2. global design tokens and typography
3. homepage build using real product-composition sections instead of placeholder copy

That is the smallest slice that proves the visual direction and gives the web app a usable foundation.