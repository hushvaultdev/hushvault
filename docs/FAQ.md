# HushVault FAQ

## What is HushVault?

HushVault is an open source secrets manager designed for Cloudflare-native self-hosting. It combines browser-friendly workflows, computed secrets, branch inheritance, and encrypted temporary share links with a strong security model built around envelope encryption.

## How did HushVault start?

HushVault began as an engineering-side project to solve the common pain points teams face with managed secrets platforms:

- pricing that grows with every secret and team member
- lock-in to hosted infrastructure
- missing advanced workflows like computed secrets and environment inheritance
- insecure or cumbersome secret sharing

The project was created to deliver a self-hostable alternative with a polished developer experience and built-in Cloudflare compatibility.

## How do I use HushVault?

1. Build the CLI from source. **It is not published to npm yet** — the `hushvault` package name
   is unclaimed, so do not run `npm install -g hushvault`.

   ```bash
   git clone https://github.com/hushvaultdev/hushvault
   cd hushvault && pnpm install
   pnpm --filter @hushvault/cli build
   # then run it as: node apps/cli/dist/index.js <command>
   ```

   See [docs/CLI.md](CLI.md).

2. Authenticate with your HushVault host:

   ```bash
   hushvault login
   ```

3. Initialize your local project:

   ```bash
   cd my-project
   hushvault init
   ```

4. Add secrets:

   ```bash
   hushvault set DATABASE_URL "postgres://..."
   ```

5. Run your app with secrets injected:

   ```bash
   hushvault run -- npm run dev
   ```

6. Use the same CLI in CI or GitHub Actions to inject secrets into deployments.

## What is branch inheritance?

Environments are organized as a tree. Child environments inherit all values from their parent and only override the secrets that change. That makes staging, production, and multi-region deployments easier to manage without duplicating every value.

## Can I self-host for free?

Yes — HushVault runs entirely on Cloudflare Workers, D1 and KV (the dashboard is a Worker too,
via OpenNext). Note that the API Worker needs a Durable Object and a minute Cron Trigger, so
check current Workers pricing for your own usage rather than assuming $0.

## How do I rotate the master key?

HushVault uses envelope encryption:

- secret values are encrypted with per-secret DEKs
- each DEK is wrapped with a key-encryption key (KEK)

**Do not overwrite `ENCRYPTION_MASTER_KEY`.** That is `v1` of the key ring, and every DEK
still wrapped under `v1` can only be unwrapped with it. Replacing its value destroys every
secret that has not already been re-wrapped, with no way back — a Worker secret cannot be
read again once it is overwritten.

Rotation adds a new key alongside the old one and re-wraps in the background:

1. Generate the new key and back it up offline **before** installing it.
2. `wrangler secret put ENCRYPTION_KEY_V2 --env <env>` — the old key stays exactly as it is.
3. Set `ENCRYPTION_ACTIVE_KEY_VERSION = "v2"` in `wrangler.toml` and deploy.
4. The Cron Trigger verifies both keys, then re-wraps the stored DEKs in batches. Watch
   `GET /api/security/key-rotation`.
5. Retire `v1` only once no row uses it and every backup you might restore has aged out.

Every row stays decryptable with whichever key version it was wrapped under, which is what
makes this zero downtime and reversible. The ciphertext in KV is never touched: only the
wrapped DEKs in D1 change.

The full procedure, including rollback and the retirement conditions, is in
[docs/ENCRYPTION.md](ENCRYPTION.md#key-rotation). Follow it rather than this summary.

## How do API tokens rotate?

For API tokens (for example CLI login tokens or automation secrets), the recommended pattern is:

1. Create a new token or secret.
2. Update the consuming environment or workflow to use the new token.
3. Revoke the old token once the new value is working.

API auth tokens are separate from encryption keys. HushVault stores encrypted secret material in KV/D1 while authentication tokens are used only for access.

## Where are secrets stored?

- metadata and secret references are stored in Cloudflare D1
- encrypted secret values are stored in Cloudflare KV

Secrets are never stored in plaintext in the database or repository.

## Where can I find more documentation?

- `README.md` for status, local development and self-hosting
- `docs/ENCRYPTION.md` for encryption details and key rotation
- `docs/DEPLOYMENT.md` for self-hosted deployment and Cloudflare setup
