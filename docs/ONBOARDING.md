# Client onboarding — secret sync (Cloudflare Workers, GitHub Actions, GitLab)

A runbook for onboarding a client who wants HushVault to push secrets to many destinations: Cloudflare Workers, GitHub repositories and GitLab projects. Sync is **one way** (HushVault → target); targets are write-only, never read back. See [INTEGRATIONS.md](INTEGRATIONS.md) for status and the per-provider pages under [integrations/](integrations/).

> Status at time of writing: Cloudflare Workers and GitLab are **beta**; GitHub Actions is **planned** pending its live verification (issue #44). A provider becomes **available** only after the Phase 5 drills below are recorded (issue #100).

## 1. Concepts (2 minutes)

- A **connection** stores one provider credential (encrypted; never shown again). Admins create connections signed in as a user — API keys cannot.
- A **target** maps one HushVault **environment** to one destination resource (a Worker, a repo, a GitLab project/group + scope). One environment can feed many targets.
- A **run** pushes the environment's resolved secrets to the target. Runs are **manual**, **on-change** (debounced), or **scheduled**. A **preview** shows what a run would do (names only).
- Reserved names (`ENCRYPTION_*`, `JWT_SECRET`, OAuth and Stripe keys) are never pushed. A name a provider can't represent is a `NAME_INVALID` blocker with a rename suggestion — you rename the secret; HushVault never renames silently.

## 2. Minimal token scopes per provider

Create the **least-privileged** credential for each destination:

| Provider | Credential | Minimal scope | Notes |
|---|---|---|---|
| **Cloudflare Workers** | Account API token | **Workers Scripts: Edit**, scoped to the one account | Account-owned token preferred; add an expiry/IP restriction. Nothing else needed. You also need the 32-char **account id**. |
| **GitHub Actions** | Fine-grained PAT | **Repository permissions → Secrets: Read and write**, scoped to the target repo(s) | Classic `repo` also works. A GitHub App is a planned follow-up. |
| **GitLab** | Project or group access token | **Maintainer** role + **`api`** scope | Managing CI/CD variables needs Maintainer; a personal access token with `api` from a Maintainer also works. gitlab.com only. |

Each token is verified with a read-only call on connect and stored encrypted (per-row DEK, AAD-bound). It is never returned or logged.

## 3. Onboard — three ways

### a. Dashboard (interactive)
Integrations → **Connect** (pick provider, paste token, enter the provider's config) → **Add target** (choose project, environment, and the destination fields the form shows for that provider) → **Preview** → **Run**. Repeat per target. Good for a handful of targets.

### b. CLI (per target, idempotent)
Connections are set up in the dashboard. Then, per target:
```
hushvault sync add <resource> --connection <connectionId> [--env <env>] [--on-change] [--delete-removed]
#   Cloudflare Workers : <resource> = Worker script name
#   GitHub Actions     : <resource> = owner/repo
#   GitLab             : <resource> = numeric project id   (group id with --gitlab-group; --scope, --masked, --protected)
hushvault sync preview <target>
hushvault sync run <target>
```
`sync add` is idempotent (re-running reports "already exists"), so it is safe in a loop over many repos.

### c. Scripted (many targets at once)
`scripts/phase5-onboarding.mjs` connects every provider and bulk-creates all targets from one JSON config, idempotently:
```
node scripts/phase5-onboarding.mjs onboarding.json            # create connections + targets
node scripts/phase5-onboarding.mjs onboarding.json --preview  # + preview every target (writes nothing)
node scripts/phase5-onboarding.mjs onboarding.json --run      # + run every target (pushes)
```
Config schema:
```json
{
  "api": "https://api-beta.hushvault.dev",
  "login": { "email": "admin@client.com", "password": "..." },
  "connections": [
    { "provider": "cloudflare-workers", "label": "cf", "credential": "<token>", "config": { "accountId": "<id>" },
      "targets": [ { "project": "web", "env": "production", "resource": { "scriptName": "web-prod" }, "onChange": true } ] },
    { "provider": "github-actions", "label": "gh", "credential": "<token>", "config": {},
      "targets": [ { "project": "web", "env": "production", "resource": { "owner": "acme", "repo": "web" } } ] },
    { "provider": "gitlab", "label": "gl", "credential": "<token>", "config": {},
      "targets": [ { "project": "api", "env": "production", "resource": { "projectId": "12345" } } ] }
  ]
}
```
`project` is a HushVault project id or name; `env` is the environment name. The script prints only providers, labels, resource names, counts and statuses — never a secret or token. Keep the config file (it holds tokens) out of version control and delete it after onboarding.

## 4. Verify (the Phase 5 drills — run once per client, record the results on #100)

1. **Change propagation.** Change one secret in a mapped environment. Confirm it lands on a CF Worker, a GitHub repo's Actions secrets, and a GitLab project's CI/CD variables within the on-change debounce window. Record the timings.
2. **Failure + recovery.** Revoke one provider token mid-flight. Confirm the affected targets flip to **needs_attention** and the owners are emailed. Rotate the credential (PUT the connection's credential); confirm the parked targets reactivate and re-sync without a manual run.
3. **Scale.** Onboard ≥30 targets with ≥64 secrets on at least one target. Confirm one scheduled reconcile window completes with zero silent deferrals (check `GET /coverage` and run history).
4. **Drift.** On each target, manually edit one HushVault-managed name and one foreign name (one HushVault never created). Confirm the next reconcile restores the managed one and never touches the foreign one (it stays a `conflict`).

## 5. Day-two operations

- **Rotate a provider token:** dashboard → the connection → rotate; parked targets recover automatically.
- **Stop syncing a target:** delete the target (nothing is removed from the destination). Delete the connection to remove its credential and all its targets.
- **A target needs attention:** open its run history for the error code; fix the cause (bad name → rename per the suggestion; rejected credential → rotate); it resumes on its schedule or the next change.
- **Never** put `ENCRYPTION_MASTER_KEY` or `JWT_SECRET` in a synced environment — they are refused by design.

---
*This guide is written from the shipped provider behaviour. Per-provider details and limits: [integrations/cloudflare-workers.md](integrations/cloudflare-workers.md), [integrations/github-actions.md](integrations/github-actions.md), [integrations/gitlab.md](integrations/gitlab.md).*
