---
name: ci-cd-manager
description: Manage and debug CI/CD pipelines from Claude Code. View workflow status, debug failed runs, re-run jobs, manage Dependabot PRs, check Cloudflare Pages deployment status, and parse Lighthouse CI results.
allowed-tools: Bash, Read, Grep, Glob
---

# CI/CD Manager Skill

## Purpose

Centralised CI/CD pipeline management for the Educ4te.website repository. Provides workflow monitoring, failure debugging, Dependabot PR triage, Cloudflare Pages deployment tracking, and Lighthouse CI score analysis — all from within Claude Code.

---

## When to Use

- A GitHub Actions workflow has failed and you need to diagnose the cause
- You want to check the status of recent workflow runs before merging
- Dependabot has opened PRs that need reviewing, approving, or merging
- You need to confirm a Cloudflare Pages deployment completed successfully
- You want to review Lighthouse CI performance scores after a deployment
- A build is stuck or behaving unexpectedly and you need pipeline logs

---

## 1. Workflow Status

### List Recent Runs

```bash
# Show last 10 workflow runs across all workflows
gh run list --limit 10

# Filter by workflow name
gh run list --workflow "build.yml" --limit 5

# Filter by branch
gh run list --branch main --limit 5
gh run list --branch dev --limit 5