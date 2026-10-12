# GitLab CI/CD variables (beta)

One-way push of a HushVault environment to the **project- or group-level CI/CD variables** of one **gitlab.com** project (or group), scoped to a
single `environment_scope`. Provider id `gitlab`, module `apps/api/src/integrations/providers/gitlab.ts`. Overview: [../INTEGRATIONS.md](../INTEGRATIONS.md).

> **Status: beta.** Verified live end-to-end against a real gitlab.com project on 2026-10-12 (issue #99, drill
> `scripts/phase3-gitlab-e2e-drill.mjs`: 30/30 — connect, preview, create, update, deleteRemoved off/on prune, masked create, and a
> bad-project failure, each checked against GitLab's own variables API). Self-managed GitLab instances (custom base URLs) are out of scope —
> only `gitlab.com` is called (SSRF).

## Setup

1. In GitLab, create a **project access token** on the target project with the **Maintainer** role and the **`api`** scope. Managing
   project CI/CD variables requires Maintainer; a lower role returns `403` (`PROVIDER_AUTH`). A group access token works for a project in
   that group with the same role/scope. *Verify the exact role/scope in the current GitLab docs if a run reports `PROVIDER_AUTH`.*
2. Find the project's **numeric id** (project home page, under the title, or `GET /projects`). Only the numeric id is accepted — not the
   `group/project` path.
3. Create a connection (admin, signed in as a user):
   `POST /api/integrations/connections` with `{ "provider": "gitlab", "label": "prod", "credential": "<token>", "config": {} }`.
   The config is empty: the token is the whole credential. It is verified with a read-only call and stored encrypted; never shown again.
4. Create a target: `POST /api/integrations/targets` with
   `{ projectId, envId, connectionId, resource: { projectId: "<numeric id>", environmentScope: "*", masked: false, protected: false } }`.
   `environmentScope` defaults to `*`, `masked` and `protected` default to `false`. One target = one project + one scope.
   **Group variables:** use `resource: { groupId: "<numeric group id>", ... }` instead of `projectId` (exactly one of the two).
   `environment_scope` on a *group's* variables is a GitLab **Premium/Ultimate** feature — on a Free-tier group leave it `*`.
5. `POST /api/integrations/targets/:id/preview`, then `POST /api/integrations/targets/:id/run`.

## What is pushed

The environment as resolved by `GET /environments/:id/resolved` (branch inheritance, computed secrets evaluated), after the name filter
(`prefix` keeps only matching names, `deny` removes names) and minus the reserved names (every secret-typed key of HushVault's own Env:
`ENCRYPTION_*`, `JWT_SECRET`, `GITHUB_CLIENT_SECRET`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`). A variable key
must match GitLab's rule `[A-Za-z0-9_]{1,255}` (letters, digits, underscore; a leading digit is allowed — unlike the Cloudflare provider),
and may not be `__proto__`, `constructor` or `prototype`: those are `NAME_INVALID` blockers. Because GitLab keys forbid `-` and `.`, a
HushVault secret named `db-url` is a `NAME_INVALID` blocker. The plan surfaces a **rename suggestion** for each such name
(`db-url` → `db_url`, case preserved) in the preview (dashboard and `hushvault sync preview`); you rename the secret yourself —
HushVault never silently renames or transforms a key (the auto-transform was rejected in review; see issue #99). Empty values are an `EMPTY_VALUE` blocker. Every write sets **`raw=true`** so a value containing `$...` is
stored literally and never expanded by GitLab as a reference to another variable.

Each variable is written to the target's one `environment_scope`. Updates use `PUT .../variables/:key?filter[environment_scope]=<scope>`;
a key absent in that scope is created with `POST .../variables`. Unchanged values are skipped using an HMAC fingerprint kept in HushVault
(the value is never stored).

## Limits (conservative)

| Limit | Value used | Source |
|-------|-----------|--------|
| Names per target | 200 | HushVault's conservative cap; GitLab's real per-project limit is higher and is the final authority. Counted as *(keys already in this scope) union (keys to create) minus deletes*. |
| Value size | 10 KB | HushVault's conservative cap; GitLab is the final authority (and enforces its own masked-value rules). |
| Name length | 255 | GitLab's documented key limit. |
| Operations per request | 20 (sequential) | GitLab has **no bulk endpoint**, so each op is one request (a create is two: a `PUT` that 404s, then a `POST`). The engine chunks to 20 ops and allows a 60 s push window per chunk. |
| Rate limiting | `429` → `PROVIDER_RATE_LIMIT` | The run stops on the first `429` and retries at least 5 minutes later, or after `Retry-After` when longer (capped at 24 h). |

## Masked and protected

`masked` and `protected` are per-target flags on the `resource`. GitLab enforces its **own** masked-value content rules (minimum length,
allowed characters), which are version-dependent and not restated here; HushVault does **not** pre-validate them. A masked value GitLab
rejects comes back as `PROVIDER_VALIDATION` for that name (a blocker on the run), with no value ever logged. Set `masked: false` if a value
cannot satisfy GitLab's masking rules.

## Delete toggle and conflicts

- `deleteRemoved` is **off by default**. When on, a secret removed from the environment is deleted from the project **in the target's scope**,
  but only if HushVault itself created that key (the ledger). Variables you created in GitLab by hand are never deleted.
- A key already in the target's scope that HushVault never wrote is a **conflict** and left untouched. The same key in a *different*
  `environment_scope` is invisible to this target and never touched.
- Deletes are idempotent: a `404` (already gone) counts as success.
- **Intent first.** Before each request HushVault records the key it is about to set as *pending* in its ledger and replaces that with the
  real fingerprint once GitLab confirmed. A lost response (timeout, network, 5xx) keeps the pending marker so the next run rewrites the key
  rather than reporting a permanent conflict; a definite failure removes the marker.
- Deleting a target or connection removes nothing from GitLab. Changing a target's `resource` clears its ledger.

## Safety

- The only host called is `https://gitlab.com/api/v4`. The project id is numeric, the key matches `[A-Za-z0-9_]{1,255}`, and the
  `environment_scope` matches a conservative charset; all are URL-encoded. Hosts, URLs and custom base URLs are never accepted. Redirects
  are not followed.
- The credential (sent in the `PRIVATE-TOKEN` header), secret values and GitLab response bodies are never logged, stored or returned;
  failures are mapped to fixed codes (`PROVIDER_AUTH`, `PROVIDER_RATE_LIMIT`, `PROVIDER_VALIDATION`, `PROVIDER_ERROR`, `TARGET_NOT_FOUND`,
  `TIMEOUT`). A `404` body is read transiently only to tell a missing *variable* (create fallback / idempotent delete) from a missing
  *project* (`TARGET_NOT_FOUND`); it is never stored.

## Verified vs unverified

Verified from the GitLab primary docs (2026-10-12, `doc/api/project_level_variables.md`, and the CI/CD variables permission doc):

- Endpoints `GET/POST /projects/:id/variables`, `PUT/DELETE /projects/:id/variables/:key`; offset pagination (`page`, `per_page`,
  `X-Next-Page`); `filter[environment_scope]` disambiguates a key present in multiple scopes on update/delete.
- Create requires `key`, `value`; optional `environment_scope` (default `*`), `masked`/`protected` (default false), `raw` (default true),
  `variable_type` (default `env_var`). Key rule `[A-Za-z0-9_]`, ≤255 chars.
- Managing project variables requires the **Maintainer** role (UI + API), so a successful list is read-only proof of write capability.

**Not** verified (no live run yet, and not stated in the API reference): GitLab's masked-value content rules (min length / alphabet); the
exact per-project variable count limit; the exact value-size limit; whether a group access token behaves identically for a project in the
group. These are deferred to the live E2E on issue #99. **Do not promote this provider to `beta` until that run is recorded.**

## Live E2E (owner action, needed to promote to beta)

Run against a throwaway gitlab.com project with a scoped Maintainer token, and record the output on issue #99:

1. Connect: `POST /api/integrations/connections` `{ provider: "gitlab", label, credential: "<glpat>", config: {} }`.
2. Target: `POST /api/integrations/targets` `{ projectId, envId, connectionId, resource: { projectId: "<id>", environmentScope: "*" } }`.
3. `preview` → confirm create/update/skip/conflict names (no values).
4. `run` → confirm create, then change a secret and `run` again → confirm update; check the values in GitLab.
5. Set `deleteRemoved: true`, remove a secret, `run` → confirm delete in that scope only.
6. Try `masked: true` with a GitLab-valid and a GitLab-invalid value → confirm the invalid one is `PROVIDER_VALIDATION` and the others sync.
7. Confirm the audit rows (`sync.run.started/succeeded/failed`, `secret.read_bulk`) and that no value appears in any log or response.
