# GitHub Actions Action — hushvaultdev/secrets-action

**Priority:** P1 — primary CI/CD integration and growth channel
**Status:** Repo created at hushvaultdev/secrets-action, not yet scaffolded

---

## Overview

Two auth modes:
1. **API key mode** — `hushvault-token: ${{ secrets.HUSHVAULT_TOKEN }}` (works everywhere)
2. **OIDC mode** — keyless, preferred (no static token stored in GitHub Secrets)

OIDC mode is the killer feature: zero secrets in GitHub, short-lived tokens, auditable per-repo access.

---

## action.yml

```yaml
# hushvaultdev/secrets-action/action.yml
name: HushVault Secrets
description: Inject secrets from HushVault into GitHub Actions environment
branding:
  icon: lock
  color: blue

inputs:
  env-id:
    description: HushVault environment ID to fetch secrets from
    required: true
  project-id:
    description: HushVault project ID
    required: true
  hushvault-token:
    description: HushVault API key (use OIDC mode instead when possible)
    required: false
  hushvault-url:
    description: HushVault API URL (for self-hosters)
    required: false
    default: https://api.hushvault.dev
  oidc-audience:
    description: Audience claim for OIDC token exchange (default: hushvault)
    required: false
    default: hushvault
  export-type:
    description: How to export secrets — "env" (GitHub env vars) or "dotenv" (write .env file)
    required: false
    default: env

outputs:
  secrets-injected:
    description: Number of secrets injected

runs:
  using: node20
  main: dist/index.js
```

---

## OIDC Token Exchange Flow

```
GitHub Actions job (needs: id-token: write)
  │
  ▼
actions/core.getIDToken('hushvault')
  → GitHub issues JWT signed by https://token.actions.githubusercontent.com
  → JWT sub: "repo:org/repo:environment:production"
  │
  ▼
POST https://api.hushvault.dev/api/auth/github-oidc
  Body: { oidcToken, envId, projectId }
  │
  ▼
Server verifies JWT:
  1. Fetch JWKS from https://token.actions.githubusercontent.com/.well-known/jwks
  2. Verify signature with WebCrypto
  3. Verify iss = "https://token.actions.githubusercontent.com"
  4. Verify aud = "hushvault"
  5. Check sub pattern against org's allowed repos setting
     (stored in: org.settings.allowedRepos JSON array, e.g. ["org/repo:*"])
  │
  ▼
Issues short-lived HushVault JWT:
  { userId: 'system', orgId, envId, scopes: ['read'], exp: now+3600 }
  │
  ▼
Action uses token to:
  GET /api/environments/{envId}/resolved → secrets map
  core.exportVariable(name, value)   → injects into downstream steps
  core.setSecret(value)              → masks value in GitHub logs
```

---

## src/index.ts (Actions source)

```typescript
import * as core from '@actions/core'
import * as github from '@actions/github'

async function run() {
  const envId = core.getInput('env-id', { required: true })
  const projectId = core.getInput('project-id', { required: true })
  const apiUrl = core.getInput('hushvault-url')
  let token = core.getInput('hushvault-token')

  // OIDC mode: exchange GitHub OIDC token for HushVault token
  if (!token) {
    const audience = core.getInput('oidc-audience')
    const oidcToken = await core.getIDToken(audience)

    const res = await fetch(`${apiUrl}/api/auth/github-oidc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oidcToken, envId, projectId }),
    })

    if (!res.ok) {
      throw new Error(`OIDC exchange failed: ${await res.text()}`)
    }

    const { token: hvToken } = await res.json<{ token: string }>()
    token = hvToken
  }

  // Fetch resolved secrets
  const res = await fetch(`${apiUrl}/api/environments/${envId}/resolved`, {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!res.ok) throw new Error(`Failed to fetch secrets: ${await res.text()}`)

  const { data: secrets } = await res.json<{ data: Record<string, string> }>()

  // Inject secrets
  let count = 0
  for (const [name, value] of Object.entries(secrets)) {
    core.exportVariable(name, value)  // available to downstream steps
    core.setSecret(value)             // masks in GitHub logs
    count++
  }

  core.setOutput('secrets-injected', String(count))
  core.info(`✅ Injected ${count} secrets from HushVault`)
}

run().catch(err => core.setFailed(err.message))
```

---

## Build & Release Workflow

```yaml
# .github/workflows/release.yml (in hushvaultdev/secrets-action)
name: Release

on:
  push:
    tags: ['v*']

jobs:
  build-and-release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm install
      - run: npm run build  # runs: ncc build src/index.ts -o dist
      - name: Commit dist
        run: |
          git config user.email "github-actions@github.com"
          git config user.name "github-actions"
          git add dist/
          git commit -m "chore: build dist for ${GITHUB_REF_NAME}"
      - name: Create Release
        run: gh release create ${GITHUB_REF_NAME} --notes "See CHANGELOG.md"
      - name: Float v1 tag
        run: |
          git tag -f v1
          git push origin v1 --force
```

**Why float the v1 tag:** Users pin `hushvaultdev/secrets-action@v1` — they get bug fixes without changing their workflows. Only move `v1` to a new major version for breaking changes.

---

## Example Usage (Consumer Workflow)

```yaml
# OIDC mode (recommended — no token stored in GitHub)
permissions:
  id-token: write
  contents: read

steps:
  - uses: hushvaultdev/secrets-action@v1
    with:
      project-id: proj_abc123
      env-id: env_xyz789
      # No hushvault-token needed — uses OIDC

  - run: npm run build   # DATABASE_URL, API_KEY etc. available here
```

```yaml
# API key mode (for self-hosted or older GitHub Enterprise)
steps:
  - uses: hushvaultdev/secrets-action@v1
    with:
      project-id: proj_abc123
      env-id: env_xyz789
      hushvault-token: ${{ secrets.HUSHVAULT_TOKEN }}
```

---

## OIDC Allowed Repos (Org Setting)

Orgs configure which GitHub repos are allowed to exchange OIDC tokens:

```typescript
// organisations.settings (JSON column):
{
  "allowedRepos": [
    "myorg/*",           // all repos in org
    "myorg/backend:*",   // specific repo, any branch
    "myorg/backend:environment:production"  // specific environment only
  ]
}
```

Stored as JSON in a new `organisations.settings` text column. Parsed on each OIDC exchange.

---

## Dogfood: alpeshnakar.github.io

Once action is shipped, update `.github/workflows/deploy.yml`:
```yaml
- uses: hushvaultdev/secrets-action@v1
  with:
    project-id: ${{ vars.HUSHVAULT_PROJECT_ID }}
    env-id: ${{ vars.HUSHVAULT_PROD_ENV_ID }}
    hushvault-token: ${{ secrets.HUSHVAULT_TOKEN }}

# Remove all individual NEXT_PUBLIC_* env: entries below
```

Only `HUSHVAULT_TOKEN` (or OIDC) stays in GitHub Secrets — replaces 7+ individual secrets.
