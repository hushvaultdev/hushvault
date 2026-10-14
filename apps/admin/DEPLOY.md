# Deploying the platform admin app (Cloudflare Workers, OpenNext)

The admin app is Next.js 15 deployed as a Cloudflare Worker with `@opennextjs/cloudflare`, the
same mechanism as the customer dashboard (`apps/web`) — see
[apps/web/DEPLOY.md](../web/DEPLOY.md) for background on why OpenNext over vinext/Pages. CI/CD is
**Cloudflare Workers Builds**; see [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md) for the full
pipeline and the Worker/command table.

## Cloudflare Access — mandatory, not optional

This app manages every tenant's plan. Signing in with a HushVault account and being a
`platform_admins` row (`requireAuth` + `requirePlatformAdmin`, see `apps/api/src/routes/admin.ts`)
authenticates *who* a caller is; it is not what decides *whether this origin is reachable at all*.
**The admin Worker's route must sit behind a Cloudflare Access application before it is reachable
by anyone but the owner**, and the API additionally re-verifies the Access JWT itself
(`requireAccessJwt` + `requireAccessBinding`, issue #108 finding 1) so a stolen or XSS'd admin
session token alone cannot call `/api/admin/*` directly on the public API host.

Owner setup (cannot be done from code):

1. **Zero Trust > Access > Applications** — create a **Self-hosted** application for
   `admin.beta.hushvault.dev` (dev) and `admin.hushvault.dev` (production). Each needs its own
   application (separate AUD tags), matching the separate Workers below.
2. Add a policy restricting access to the account(s) that should hold platform admin — Access is
   the outer gate; `platform_admins` is the inner one. Do not rely on either alone.
3. Note each application's **AUD tag** and the account's **team domain**
   (`https://<team>.cloudflareaccess.com`).
4. Set on the **API** Worker (not this one) for each environment:
   - `CF_ACCESS_TEAM_DOMAIN` = the team domain above
   - `CF_ACCESS_AUD` = that environment's admin application's AUD tag

   These are plain vars (not secrets — an AUD tag is not sensitive), but until they are set in
   production `requireAccessJwt` fails closed with a 503 on every `/api/admin/*` call (see
   `apps/api/src/middleware/access-jwt.ts`) — this is deliberate, not a bug to work around.
5. Insert the first `platform_admins` row (`INSERT INTO platform_admins (user_id, granted_at) ...`
   via `wrangler d1 execute`, following the same one-off-value pattern as
   [docs/OPERATIONS.md §8](../../docs/OPERATIONS.md#8-setting-an-organisations-plan)) for the
   owner's own account before anyone can sign in to this app and do anything.

Until all five steps are done, this Worker should not have a public route at all — leave it on
`workers.dev` or unrouted.

## Build model

- `pnpm --filter @hushvault/admin build` = plain `next build` (needs no Cloudflare credentials).
- `pnpm --filter @hushvault/admin build:cf` = OpenNext bundle -> `.open-next/worker.js` + `.open-next/assets`.
- `pnpm --filter @hushvault/admin preview` builds and runs the Worker locally.
- `pnpm --filter @hushvault/admin run deploy:dev` / `deploy:production` =
  `opennextjs-cloudflare deploy --env <env>` (run after `build:cf`; this is the Workers Builds
  deploy command).
- `pnpm --filter @hushvault/admin run verify` = type-check + lint + test.
- `NEXT_PUBLIC_API_URL` is **not needed by the browser** in this app (issue #108 finding 2: the
  browser only ever calls this Worker's own same-origin `/api/**` routes, proxied server-side —
  see `src/lib/proxy.ts`). The proxy itself needs a **server-only** `API_INTERNAL_URL` build/runtime
  variable naming the real API origin; never expose it as `NEXT_PUBLIC_*`, which would inline it
  into client bundles for no reason.

## Workers

| Worker | Env | Branch | `API_INTERNAL_URL` |
|---|---|---|---|
| `hushvault-admin-dev` | `dev` | `dev` | `https://api-beta.hushvault.dev` |
| `hushvault-admin` | `production` | `main` | `https://api.hushvault.dev` |

Worker names must match `apps/admin/wrangler.toml` exactly. Root directory: `apps/admin`.

**Build watch paths**: this Worker also depends on `packages/web-kit/**` and
`packages/shared/**` (it imports both as TypeScript source via `transpilePackages` — see
`next.config.mjs`). Add both to the Worker's build watch paths, the same requirement
`apps/web`'s kit-extraction commit noted for the dashboard Worker — otherwise a kit-only change
does not trigger a rebuild here either.

## Deploying by hand

Follow the same pattern as `apps/web/DEPLOY.md`'s "Deploying by hand" section — the known #93
asset-upload 401 (a build token without Workers Scripts edit cannot
`POST /accounts/<account>/workers/assets/upload`) applies identically here, since both apps use
the same OpenNext static-asset upload path. Resolve that token issue once; it unblocks both apps.

```bash
API_INTERNAL_URL=https://api-beta.hushvault.dev pnpm --filter @hushvault/admin run build:cf
```

## Manual steps

1. Create the two Workers via Workers & Pages > Import a repository (see DEPLOYMENT.md step 2).
2. Add the custom domain in the dashboard (Worker > Settings > Domains & Routes) — **after**
   the Cloudflare Access application above exists and is attached to that same route, not before.
3. Set `API_INTERNAL_URL` as a build variable (see table above) — a server-only var, never
   `NEXT_PUBLIC_API_URL`.
4. On the API Worker, set `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` for the matching environment
   (see "Cloudflare Access" above).

## Security headers

Set in `next.config.mjs` `headers()`: CSP, HSTS, nosniff, X-Frame-Options, Referrer-Policy,
Permissions-Policy, and `Cache-Control: no-store` on every route (this app must never serve a
tenant list from a shared cache or bfcache after sign-out). `connect-src` is `'self'` only — the
browser never talks to the API origin directly (issue #108 finding 2). Verify headers on the
deployed Worker with `curl -I`.
