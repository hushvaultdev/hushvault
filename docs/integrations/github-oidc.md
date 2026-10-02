# GitHub Actions: read secrets with OIDC (no stored HushVault token)

**Status: beta. Not yet verified against a live GitHub Actions run** — see "Unverified" at the end.

A workflow proves who it is with a short-lived token GitHub signs for it. HushVault verifies that signature and, if an
admin has granted that exact repository and branch (or GitHub environment) access, returns a token that can do exactly
one thing for ten minutes: read one environment. **No HushVault credential is ever stored in the repository.**

## 1. Grant the repository access

Admin or owner only, from the dashboard or the API:

```bash
curl -X POST "$HUSHVAULT_API_URL/api/ci-access/github/rules" \
  -H "Authorization: Bearer $SESSION_JWT" -H 'Content-Type: application/json' \
  -d '{"envId":"env_...","repository":"acme/app","repositoryId":"123456","ref":"refs/heads/main"}'
```

- `repository` is `owner/name`, matched exactly (case-insensitively).
- `repositoryId` is GitHub's immutable numeric id. **Set it.** Without it, renaming or transferring the repository away
  leaves the rule matching whoever takes the old name.
- Exactly one of `ref` (e.g. `refs/heads/main`) or `environment` (a GitHub environment name). Both are matched exactly,
  so a rule for `refs/heads/main` does not cover `refs/heads/main-hotfix`, a tag, or a pull request.

Matching uses GitHub's **individual claims**, never the `sub` string, because a repository can customise how `sub` is
built but cannot change `repository`, `repository_id`, `ref` or `environment`.

## 2. Use it in a workflow

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      id-token: write        # required: without it GitHub mints no token
      contents: read
    steps:
      - uses: hushvaultdev/secrets-action@v0
        with:
          environment-id: env_...
          api-url: https://api.hushvault.dev
      - run: ./deploy.sh      # secrets are environment variables here
```

The action masks every value before it can reach the log, writes values only to `$GITHUB_ENV`, and outputs the secret
**names** only. It has no third-party dependencies.

## What the API does

`POST /api/auth/github-oidc` with `{ token, envId }` (unauthenticated — the signed GitHub token is the credential):

1. Verifies RS256 against GitHub's published keys (cached one hour; an unknown key id triggers at most one refetch per
   minute, so junk tokens cannot become an outbound flood).
2. Checks the issuer, the audience and the time window (60 s clock skew) **before** reading any claim for authorisation.
3. Finds a rule for `envId` whose claims match exactly.
4. Returns a 10-minute token scoped to that one environment and audits `auth.oidc.exchange` as the `system` actor.

Every verification failure returns the same opaque `401 OIDC_REJECTED`, so a forger learns nothing about which part was
wrong; the reason is logged (never the token). A key-server outage is `503`, not `401`. No rule is `403 NOT_ALLOWED`.

The issued token reaches exactly one endpoint — `GET /api/environments/<its own env>/resolved` — enforced in the auth
middleware as an allowlist, so any other route is refused by default.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `GITHUB_OIDC_ISSUER` | `https://token.actions.githubusercontent.com` | Override for GitHub Enterprise Server. |
| `GITHUB_OIDC_JWKS_URL` | `https://token.actions.githubusercontent.com/.well-known/jwks` | Key set. |
| `GITHUB_OIDC_AUDIENCE` | `API_PUBLIC_URL`, else `https://api.hushvault.dev` | The audience a token must carry. A HushVault-specific audience stops a token minted for another service being replayed here, so the workflow must request the same value. |

## Limits and caveats

- Read-only, one environment per token, ten minutes.
- A rule grants a *branch or GitHub environment*, not a repository as a whole. There is no wildcard, by design.
- Fork pull requests: GitHub does not give a fork's workflow `id-token: write` for the base repository, and a
  `refs/pull/N/merge` ref does not match a branch rule anyway. **Not verified in a live run.**
- The JWKS cache lives in the secrets KV namespace under `jwks:` keys. It holds public keys only.

## Unverified

Egress to GitHub is blocked from the environment this was written in, so the following come from the code's defaults and
must be confirmed on the first live run (they are configuration, not code changes):

- The issuer and `jwks_uri` values above, and the key-set shape.
- The exact token-request protocol the action uses (`ACTIONS_ID_TOKEN_REQUEST_URL` + `&audience=`, `Bearer` on
  `ACTIONS_ID_TOKEN_REQUEST_TOKEN`, `api-version=2.0`, response `{ "value": "<jwt>" }`).
- The default audience when a workflow requests no audience.
- Token lifetime, and whether `environment` appears only for jobs declaring `environment:`.
- Whether `repository_id` is sent as a string or a number (the rule compares strings).
