# Frontend Experience & Design System

**Priority:** P1 — required to make product-led growth credible
**Status:** Design approved, implementation planning ready
**Date:** 2026-05-18

---

## Objective

Define how HushVault should look and feel across the marketing site, onboarding flow, dashboard shell, and core product surfaces so the frontend supports the product strategy:
- generous for developers
- affordable for startups
- credible for growing teams

The frontend should communicate speed, trust, and operational clarity without looking like a generic security SaaS or a consumer productivity app.

---

## Current State

The current web surface is intentionally minimal:
- `apps/web/src/app/page.tsx` renders a placeholder home page
- `apps/web/src/app/layout.tsx` only sets metadata and a bare HTML shell

This is an advantage. There is no existing design system debt to unwind.

---

## Research Summary

Recent design patterns across developer-facing infrastructure products such as Doppler, Infisical, Vercel, Linear, and Cloudflare show consistent shifts:

1. Product-led heroes outperform abstract brand visuals.
2. Trust signals appear near the top of the funnel, not buried in footers.
3. Operational dashboards are denser and more keyboard-oriented than older SaaS UIs.
4. Light-first visual systems are returning for infrastructure and B2B trust surfaces.
5. Motion is restrained and informative rather than decorative.
6. Upgrade paths are communicated inside workflows via usage, limits, and locked capability surfaces.
7. Product marketing is increasingly organized around workflows instead of feature grids.

HushVault should adopt the durable parts of those trends without copying any one competitor.

---

## Design Direction

HushVault should look like a calm, high-trust developer control plane with editorial product storytelling.

That means:
- marketing site: clear, product-led, comparative, high-confidence
- app UI: compact, legible, efficient, operational
- brand tone: technical and credible, not theatrical or cyberpunk

### What HushVault Should Not Look Like

- not neon hacker branding
- not glassy startup gradients with little product context
- not enterprise admin software with bloated forms and deep nesting
- not a clone of Doppler, Infisical, or Vercel

### Reference Mix

The intended feel is:
- Linear for precision, hierarchy, and speed
- Cloudflare for infrastructure credibility
- Vercel for product storytelling discipline

---

## Visual System

### Color

Use a light-first palette with dense dark utility surfaces for technical context.

Recommended palette direction:
- background: warm off-white or soft stone
- foreground: charcoal or deep slate
- primary action: oxidized teal or deep cyan
- success: muted green
- warning: amber
- destructive: restrained red
- utility dark panels: graphite, ink, deep blue-gray

Avoid a purple-heavy palette and avoid dark mode as the primary brand presentation.

### Typography

Use a sharper, more deliberate UI typography stack than default system or Inter-only styling.

Recommended direction:
- UI sans: Geist, IBM Plex Sans, Manrope, or similar
- mono: JetBrains Mono or IBM Plex Mono

Usage:
- sans for navigation, product copy, pricing, and interface labels
- mono for secret keys, CLI commands, diffs, version metadata, and integration identifiers

### Shape And Layout

- low-radius cards and panels
- crisp borders and separators
- limited shadows
- stronger use of grids and alignment than ornamental layering
- dense but breathable spacing for operational views

### Motion

Use motion to reinforce state changes and reading flow.

Recommended motion patterns:
- staggered hero reveal
- panel fade-slide on first load
- subtle diff highlight transitions
- status pulse for syncing or pending states

Avoid large ambient loops, floating blobs, or decorative parallax.

---

## Information Architecture

### Marketing Site

Top-level sections should be:
- Product
- Pricing
- Security
- Docs
- Self-Host
- Changelog
- Sign In
- Start Free

### App Navigation

Primary app shell:
- org switcher
- project navigation
- environments
- secrets
- integrations
- audit log
- billing
- settings

Global utilities:
- command palette
- search
- notifications or sync alerts
- user menu

The app should support quick switching between project and environment without forcing deep page reload patterns.

---

## Marketing Site Experience

### Hero

The hero should make the product legible in under ten seconds.

Hero content should include:
- a sharp value proposition tied to developer and startup teams
- primary CTA: Start Free
- secondary CTA: See Pricing or View Docs
- a composed product visualization showing:
  - environment selector
  - secrets table
  - recent diff or audit panel
  - integration sync card
  - CLI snippet

The hero should look like a working product, not a decorative mockup.

### Workflow Storytelling

The homepage should be organized around real usage flows:
- create and organize secrets
- inherit across environments
- sync to Cloudflare and GitHub
- share safely
- audit and govern as the team grows

Each section should show outcome, interface state, and operational benefit.

### Trust Layer

Place trust signals above the fold or immediately below it:
- encryption model
- open source
- self-host option
- Cloudflare-native runtime
- auditability
- pricing transparency

### Pricing Presentation

The pricing page should reinforce the operational maturity ladder:
- Free for serious personal and early startup use
- Pro for active operational workflows
- Team for governance and shared infrastructure
- Enterprise for formal requirements

Every pricing tier should answer:
- who it is for
- what pain it removes
- what unlocks next

---

## Application Experience

### App Shell

The product should use a compact left sidebar with a slim top bar.

Shell layout:
- left sidebar for primary navigation and hierarchy
- top bar for search, command palette, current environment, and account actions
- main content area for list-detail or board-detail workflows
- optional right-side context rail for sync health, usage, and recent activity

### Secrets Screen

The secrets screen is the product center of gravity.

It should include:
- table-first layout
- environment badge per secret
- indicators for computed, inherited, and overridden values
- inline filter and search
- fast row actions
- bulk selection for sync or delete actions where appropriate

The detail view should expose:
- versions
- reference relationships
- recent activity
- destinations synced to
- share-link actions

### Onboarding

The onboarding wizard already defined in `docs/plans/auth-and-onboarding-flow.md` should be visually implemented as a guided setup sequence, not a stack of generic modals.

Recommended behavior:
- step indicator with progress
- live preview of generated environments
- inline secret creation
- terminal-style CLI installation panel
- explicit success state after each step

### Billing And Usage

Billing surfaces should feel operational, not sales-driven.

Show:
- current plan
- seat and secret usage
- retention window
- feature availability
- upgrade benefits in context

Upgrade prompts should appear where they explain an immediate user need, such as hitting a limit or opening a locked governance feature.

### Integrations

Integrations pages should be state-driven cards rather than long settings forms.

Each integration card should show:
- status
- last sync
- target environment
- recent failure or drift signal
- primary action

---

## Core Interaction Principles

1. Show system state clearly.
Sync, drift, inheritance, history, and access changes must be visible at a glance.

2. Prefer list-detail patterns over deep navigation.
Users should not get lost drilling into basic secret management tasks.

3. Make powerful actions feel reversible.
Version history, confirmation language, and diff views should reduce fear.

4. Optimize for keyboard use.
Search, command palette, environment switching, row actions, and copy flows should be fast.

5. Use empty states to teach the product.
Every empty state should explain what comes next and why it matters.

6. Keep pricing and plan logic visible.
Freemium works better when users understand exactly what value each plan unlocks.

---

## Recommended Screens For MVP Design Coverage

1. Marketing homepage
2. Pricing page
3. Sign up and sign in
4. First-run onboarding wizard
5. Secrets list and detail view
6. Project and environment switcher
7. Integrations overview
8. Billing and usage page
9. Audit log view

These screens are enough to establish the product character and validate the plan-aware UX model.

---

## Implementation Guidance For Next.js App

### Initial Frontend Stack Direction

- App Router with route groups for marketing and authenticated app shells
- shared design tokens in CSS variables
- reusable primitives for cards, badges, tables, command surfaces, and empty states
- no dependency on a heavy admin template
- compose from small UI primitives rather than importing a full visual system wholesale

### Layout Structure

Suggested route groups:
- `src/app/(marketing)/...`
- `src/app/(auth)/...`
- `src/app/(dashboard)/...`

Suggested base pieces:
- `MarketingHeader`
- `HeroProductScene`
- `TrustBand`
- `WorkflowSection`
- `DashboardShell`
- `SecretsTable`
- `UsageCard`
- `IntegrationStatusCard`

### Responsiveness

The marketing site should feel composed and editorial on desktop while collapsing into narrative blocks on mobile.

The app shell should:
- collapse sidebar cleanly on tablet and mobile
- preserve fast access to project and environment switching
- avoid forcing full desktop table density on narrow screens

---

## Phased Implementation Plan

### Phase 1

Build the foundational brand and shell:
- global tokens
- typography and color system
- marketing homepage
- marketing navigation and footer
- dashboard shell

### Phase 2

Build the first product-critical surfaces:
- auth pages
- onboarding wizard
- secrets list and detail layout
- pricing page
- billing usage cards

### Phase 3

Build operational depth:
- integrations overview
- audit log views
- upgrade prompts
- plan-aware locked states

### Phase 4

Refine motion, accessibility, and polish:
- reduced motion handling
- focus states and keyboard traversal
- loading skeletons
- empty states and edge-case messaging

---

## Success Criteria

The frontend direction is successful if:
- a developer can understand the product from the homepage quickly
- the dashboard feels fast and operational, not generic
- the product communicates trust without looking corporate or stale
- plan upgrades make sense in context
- HushVault looks clearly differentiated from Doppler and Infisical

---

## Next Step

The next planning artifact should be a screen-by-screen implementation plan for:
- homepage sections
- pricing page
- onboarding flow
- dashboard shell
- secrets management screen

That plan should map directly to the Next.js files and components to build first.