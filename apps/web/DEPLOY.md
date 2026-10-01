# Deploying the web dashboard (Cloudflare Workers, OpenNext)

The dashboard is Next.js 15 deployed as a Cloudflare Worker with
`@opennextjs/cloudflare` (https://developers.cloudflare.com/workers/framework-guides/web-apps/opennext/).
CI/CD is **Cloudflare Workers Builds**; see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md)
for the full pipeline, branch flow and the Worker/command table.

Why OpenNext: Cloudflare recommends vinext for new apps, but it is beta and targets Next 16.
OpenNext is the documented path for an existing Next 15 app with dynamic routes
(`/projects/[projectId]`, `/share/[token]`). Static export to Pages is not viable.

## Build model

- `pnpm build` = plain `next build` (needs no Cloudflare credentials).
- `pnpm --filter @hushvault/web build:cf` = OpenNext bundle -> `.open-next/worker.js` + `.open-next/assets`.
- `pnpm --filter @hushvault/web preview` builds and runs the Worker locally.
- `pnpm run deploy:dev` / `deploy:production` = `opennextjs-cloudflare deploy --env <env>`
  (run after `build:cf`; this is the Workers Builds deploy command).
- `pnpm run verify` = type-check + lint.
- `NEXT_PUBLIC_API_URL` is inlined at BUILD time. In Workers Builds set it as a
  **build variable** on each web Worker (build variables are not available at runtime);
  never in wrangler `[vars]`. It also feeds the CSP `connect-src`.

## Workers

| Worker | Env | Branch | Build variable `NEXT_PUBLIC_API_URL` |
|---|---|---|---|
| `hushvault-web-dev` | `dev` | `dev` | `https://api-beta.hushvault.dev` |
| `hushvault-web` | `production` | `main` | `https://api.hushvault.dev` |

Worker names must match `apps/web/wrangler.toml` exactly. Root directory: `apps/web`.

## Manual steps

1. Create the two Workers via Workers & Pages > Import a repository (see DEPLOYMENT.md step 2).
2. Add the custom domain in the dashboard (Worker > Settings > Domains & Routes);
   not configured in the repo.
3. Put the web origin in the API's `WEB_APP_URL` for the matching environment
   (the API trusts that origin for CORS).

## Security headers

Set in `next.config.mjs` `headers()` (CSP, HSTS, nosniff, X-Frame-Options, Referrer-Policy,
Permissions-Policy). `script-src` keeps `'unsafe-inline'` because Next's App Router emits inline
bootstrap scripts and a nonce would force dynamic rendering everywhere. Verify headers on the
deployed Worker with `curl -I` (including a `/_next/static` asset, which is unverified).
