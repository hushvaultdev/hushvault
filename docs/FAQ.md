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

1. Install the CLI:

   ```bash
   npm install -g hushvault
   ```

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

Yes. HushVault is built to run on Cloudflare Workers, D1, KV, and Pages, and it can fit inside Cloudflare's free tier for many small teams and MVPs.

## How do I rotate the master key?

HushVault uses envelope encryption:

- secret values are encrypted with per-secret DEKs
- each DEK is wrapped with a master key

To rotate the master key:

1. Generate a new 32-byte base64 key.
2. Re-wrap each secret's DEK with the new master key.
3. Update `ENCRYPTION_MASTER_KEY` in Cloudflare.
4. Deploy the updated worker.

The ciphertext stored in KV does not need to be re-encrypted during master key rotation.

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

- `README.md` for quick start and architecture overview
- `docs/ENCRYPTION.md` for encryption details and key rotation
- `docs/DEPLOYMENT.md` for self-hosted deployment and Cloudflare setup
