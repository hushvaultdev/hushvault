# GitHub Actions: read secrets with OIDC (no stored HushVault token)

**Status: beta. Not yet verified against a live GitHub Actions run** — see "Unverified" at the end. The claim
formats and the token-request protocol below were checked against the GitHub documentation source
(`github/docs`, `content/actions/reference/security/oidc.md`) and `actions/toolkit`; the live discovery and key-set
endpoints could not be reached from the environment this was written in.

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
- Adding a rule that differs only by `repositoryId` is rejected as a conflict **and the unpinned rule stays live**.
  To pin an existing rule, delete it first, then create the pinned one.
- Exactly one of `ref` (e.g. `refs/heads/main`) or `environment` (a GitHub environment name). Both are matched exactly,
  so a rule for `refs/heads/main` does not cover `refs/heads/main-hotfix`, a tag, or a pull request.

**Pull-request runs never match any rule.** A `pull_request_target` job runs in the *base* repository's privileged
context, so its `ref` is the trusted branch and its `environment` is a real environment, while it executes code
influenced by an untrusted fork pull request. HushVault refuses `pull_request` and `pull_request_target` outright
rather than relying on the ref to look untrustworthy.

Matching uses GitHub's **individual claims**, never the `sub` string. A repository or organisation admin can
reconfigure the `sub` template (`include_claim_keys`) so that `sub` does not even begin with `repo:` — for example
`repository_owner:monalisa` — and GitHub moved repositories created after 2026-07-15 to an immutable
`repo:owner@123/repo@456:...` form that a renamed repository also adopts. The individual claims are stable under all of
that, so matching them is both simpler and safer than any `sub` prefix rule.

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

### You choose which variables the job gets (required)

`export-env` needs either `prefix` or `names`:

```yaml
with:
  environment-id: env_...
  prefix: APP_          # every secret becomes APP_<NAME>; the prefix must end in "_"
# or
  names: DB_URL API_KEY # only these, and the run fails if one is missing
```

This is a hard requirement, not a recommendation. Writing a variable like `PATH`, `LD_PRELOAD`, `CC`, `MAKE`,
`CDPATH` or `npm_config_script_shell` into `$GITHUB_ENV` is arbitrary code execution on the runner, and creating a
secret needs only the `member` role — far below the admin who granted the repository access. Without a prefix or an
explicit list, **whoever can add a secret would be choosing variable names your job reads.**

Two reviews tried to solve this with a list of dangerous names instead; both enumerated bypasses (the second found
~145, including `CC`, `MAKE`, `MAKEFLAGS` and `CDPATH` with working proofs). "Variables that change how a process
runs" is an open-ended set that every compiler and runtime extends, so the list is kept only to catch a prefix that
is itself dangerous (`prefix: LD_` with a secret named `PRELOAD`). The control is that you pick the names.

Use `export-env: false` if you only want the `names` output and will read values yourself.

## What the API does

`POST /api/auth/github-oidc` with `{ token, envId }` (unauthenticated — the signed GitHub token is the credential):

1. Verifies RS256 against GitHub's published keys (cached one hour; an unknown key id triggers at most one refetch per
   minute, so junk tokens cannot become an outbound flood).
2. Checks the issuer, the audience and the time window (60 s clock skew) **before** reading any claim for authorisation.
3. Finds a rule for `envId` whose claims match exactly, and whose event is allow-listed.
4. Returns a 10-minute token scoped to that one environment and audits `auth.oidc.exchange` as the `system` actor.

Every verification failure returns the same opaque `401 OIDC_REJECTED`, so a forger learns nothing about which part was
wrong; the reason is logged (never the token). A key-server outage — or a flood of unknown key ids exhausting the
refetch budget — is `503`, not `401`, so an outage is never mistaken for a bad token. No rule is `403 NOT_ALLOWED`,
logged with the repository, ref and environment so an operator can tell a typo from a probe.

The issued token reaches exactly one endpoint — `GET /api/environments/<its own env>/resolved` — enforced in the auth
middleware as an allowlist, so any other route is refused by default.

## Configuration

| Var | Default | Purpose |
|---|---|---|
| `GITHUB_OIDC_ISSUER` | `https://token.actions.githubusercontent.com` | Override for GitHub Enterprise Server. |
| `GITHUB_OIDC_JWKS_URL` | `https://token.actions.githubusercontent.com/.well-known/jwks` | Key set. |
| `GITHUB_OIDC_AUDIENCE` | `API_PUBLIC_URL`, else `https://api.hushvault.dev` | The audience a token must carry, compared with exact equality. **This matters:** GitHub's default audience is the repository owner's URL (e.g. `https://github.com/acme`), which is minted for *every* workflow in that organisation that asks for a token. Requiring a HushVault-specific audience means a token minted for something else cannot be replayed here. The action requests this value. |

## Limits and caveats

- Read-only, one environment per token, ten minutes.
- **Inherited secrets are included.** Reading an environment resolves branch inheritance, so a token for `staging`
  also returns everything `staging` inherits from its parent. Grant the narrowest environment, not a leaf of a deep
  chain, if that matters to you.
- Deleting a rule revokes the tokens it already issued, so it is a real kill switch rather than a ten-minute wait.
- Only these events may mint a token: `push`, `workflow_dispatch`, `schedule`, `release`, `merge_group`,
  `deployment`, `deployment_status`. Anything else — including `issue_comment`, `workflow_run` and the pull-request
  triggers — is refused, because those run in the base repository's context with a trusted-looking ref.
- A rule grants a *branch or GitHub environment*, not a repository as a whole. There is no wildcard, by design.
- Pull requests are refused by event name (above), so neither a fork PR nor `pull_request_target` can mint a token.
  **Not verified in a live run.**
- GitHub Enterprise Server uses a different issuer (`https://HOSTNAME/_services/token`), and GitHub Enterprise Cloud
  can set a unique issuer per enterprise (`https://token.actions.githubusercontent.com/<slug>`). Both need
  `GITHUB_OIDC_ISSUER` and `GITHUB_OIDC_JWKS_URL` set; read `jwks_uri` from that issuer's
  `/.well-known/openid-configuration` rather than assuming the path. A unique enterprise issuer is a real security
  gain: only that enterprise's repositories can mint tokens with it.
- GitHub's tokens are short-lived (the documented example is 300 s) and carry a backdated `nbf`; HushVault allows 60 s
  of clock skew either way.
- The JWKS cache lives in the secrets KV namespace under `jwks:` keys. It holds public keys only.

## Unverified

Egress to GitHub is blocked from the environment this was written in, so the following come from the code's defaults and
must be confirmed on the first live run (they are configuration, not code changes):

- The live `jwks_uri` value and the key-set shape (`kty`/`alg`/`use`/`kid`), and any key-rotation cadence — GitHub
  publishes none, which is why the verifier refetches on an unknown `kid` instead of pinning anything.
- The `api-version` literal already present in `ACTIONS_ID_TOKEN_REQUEST_URL`. The action appends `&audience=`, which
  matches `actions/toolkit`, so it does not need to know this.
- That `environment` appears only for jobs declaring `environment:`, and the exact token lifetime in practice.
- `repository_id` is documented as a string; the rule accepts a number too rather than failing open.
- The GitHub Enterprise Server `jwks_uri` path.
