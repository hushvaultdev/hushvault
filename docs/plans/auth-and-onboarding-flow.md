# Auth & Onboarding Flow

**Priority:** P0 — blocks all real user registrations
**Status:** Design approved, implementation pending

---

## Auth Strategy

**OAuth-first** (GitHub + Google), password as fallback.
- GitHub/Google cover 90%+ of target users (developers)
- Password registration still supported for enterprise/self-hosted deployments
- No magic links (adds email dependency complexity at MVP)

---

## Registration Flow

```
1. User hits /signup
2. Clicks "Continue with GitHub" or "Continue with Google"
3. OAuth redirect → provider callback → POST /api/auth/oauth/callback
4. Server verifies OIDC token, extracts email + name
5. D1 transaction (atomic):
   a. INSERT users (id=nanoid, email, name, provider, providerId)
   b. INSERT organisations (id=nanoid, name="Personal", slug=auto, plan='free')
   c. INSERT members (orgId, userId, role='owner')
6. Issue JWT (15min) + refresh token (7d httpOnly cookie)
7. Redirect to /dashboard/onboarding (first-run wizard)
```

**Email verification:** Required for password registrations; OAuth skips it (email already verified by provider).
**Duplicate email:** If email exists with different provider, merge accounts (link providers to same user row).

---

## Session Management

```
Access token:  JWT, 15min expiry, signed with JWT_SECRET
               Payload: { userId, orgId, role, iat, exp }
Refresh token: random 32-byte token, hashed with SHA-256 before storage in D1
               7-day expiry, rotated on use (sliding window)
               Stored in httpOnly + Secure + SameSite=Strict cookie
```

**Token refresh:** `POST /api/auth/refresh` — validates cookie, issues new access token + rotates refresh token.
**Logout:** `POST /api/auth/logout` — deletes refresh token from D1, clears cookie.

---

## Invite Flow

```
Owner sends:  POST /api/orgs/:id/invitations { email, role }
Server:       INSERT invitations (id, orgId, email, role, token=nanoid(), expiresAt=+7d)
              Send email via Resend: "You've been invited to {org} on HushVault"
Recipient:    Clicks link → GET /accept-invite?token={token}
Server:       Verify token, create user (if new) + member row, DELETE invitation
```

---

## API Key Scoping

API keys are scoped to a specific environment (not just org) to follow least-privilege:

```typescript
// Add to apiKeys table in schema.ts:
projectId: text('project_id').references(() => projects.id)
envId:     text('env_id').references(() => environments.id)
scopes:    text('scopes').default('["read"]')  // JSON: ["read","write","delete"]
```

Key format: `hv_live_{base58(32bytes)}` (production) / `hv_test_{base58(32bytes)}` (dev).
Prefix enables accidental-leak detection by GitGuardian, TruffleHog, GitHub secret scanning.

---

## Onboarding Wizard (Dashboard — 3 steps)

Shown once, after first login. Dismissed permanently on completion.

```
Step 1: Create your first project
  - Input: project name (pre-filled with org name)
  - Action: POST /api/projects → auto-creates 3 default environments: development, staging, production
  - Skip: create project silently with "My First Project"

Step 2: Add your first secret
  - Input: KEY + VALUE inline form
  - Action: POST /api/secrets
  - Shows: preview of "hushvault run -- npm run dev" with secret injected

Step 3: Install the CLI
  - Tabs: npm | macOS | Windows | Linux
  - npm:   npm install -g hushvault
  - Shows: hushvault login → hushvault init → hushvault run -- npm run dev
  - Button: "I've installed it" → completes onboarding, dismisses wizard
```

Onboarding state stored in `users.onboardingCompletedAt` (NULL = not done, timestamp = done).

---

## OAuth Routes

```
GET  /api/auth/github             → redirect to GitHub OAuth
GET  /api/auth/github/callback    → exchange code, create/login user
GET  /api/auth/google             → redirect to Google OAuth
GET  /api/auth/google/callback    → exchange code, create/login user
POST /api/auth/login              → email + password login
POST /api/auth/register           → email + password registration
POST /api/auth/refresh            → refresh JWT using httpOnly cookie
POST /api/auth/logout             → delete refresh token, clear cookie
POST /api/auth/forgot-password    → send reset email
POST /api/auth/reset-password     → verify token, update password hash
POST /api/auth/github-oidc        → GitHub Actions OIDC token exchange (CI/CD)
```

---

## D1 Schema Additions

```typescript
// Add to users table:
passwordHash:           text('password_hash')          // null for OAuth users
provider:               text('provider')               // 'github' | 'google' | 'password'
providerId:             text('provider_id')
onboardingCompletedAt:  text('onboarding_completed_at')

// New tables:
refreshTokens: { id, userId, tokenHash, expiresAt, createdAt }
invitations:   { id, orgId, email, role, token, expiresAt, createdAt }
```

**Migration:** `apps/api/migrations/0003_auth_tables.sql`
