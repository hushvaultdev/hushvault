# Deploying the web dashboard (Cloudflare Workers, OpenNext)

The dashboard is Next.js 15 deployed as a Cloudflare Worker with
`@opennextjs/cloudflare` (https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/).

Why OpenNext: Cloudflare recommends vinext for new apps, but it is beta and targets Next 16.
OpenNext is the documented path for an existing Next 15 app with dynamic routes
(`/projects/[projectId]`, `/share/[token]`). Static export to Pages is not viable.

## Build model

- `pnpm build` = plain `next build` (used by turbo/CI, needs no Cloudflare credentials).
- `pnpm --filter @hushvault/web build:cf` = OpenNext bundle -> `.open-next/worker.js` + `.open-next/assets`.
- `pnpm --filter @hushvault/web preview` builds and runs the Worker locally.
- `pnpm --filter @hushvault/web deploy` builds and deploys (top-level config = staging worker).
- `NEXT_PUBLIC_API_URL` is inlined at BUILD time. Set it in the build environment
  (GitHub environment variable), never in wrangler `[vars]`. It also feeds the CSP `connect-src`.

## Manual one-time setup

1. Cloudflare API token with "Workers Scripts: Edit" for the account; note the account ID.
2. GitHub: create Environments `staging` and `production` (add required reviewers on production).
   Per environment add secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and variables
   `NEXT_PUBLIC_API_URL` (the API origin for that env) and `WEB_URL` (deployed web URL, for the smoke test).
3. First deploy creates the Workers `hushvault-web-staging` and `hushvault-web`
   (`workers.dev` URL appears in the deploy output; put it into `WEB_URL`).
4. Custom domain: Cloudflare dashboard > Worker > Settings > Domains & Routes (not configured in repo).
5. The API must allow the web origin in its CORS config.

## CI/CD

`.github/workflows/deploy-web.yml`: PRs touching apps/web build the OpenNext bundle (no secrets);
pushes to main deploy to `production` only after the `CI` workflow succeeds (checks out its `head_sha`);
manual `workflow_dispatch` can deploy `staging`. A smoke test curls `$WEB_URL/sign-in` expecting 200.

## Security headers

Set in `next.config.mjs` `headers()` (CSP, HSTS, nosniff, X-Frame-Options, Referrer-Policy,
Permissions-Policy). `script-src` keeps `'unsafe-inline'` because Next's App Router emits inline
bootstrap scripts and a nonce would force dynamic rendering everywhere. Verify headers on the
deployed Worker with `curl -I`.
