# CLI Publishing & Distribution

**Priority:** P2 — user activation path
**Status:** CLI scaffolded, publish workflow pending

---

## npm Package

- Package name: `hushvault` (claimed on npm)
- Binary names: `hushvault` and `hv` (short alias)
- Publish: public, `latest` tag
- Node requirement: `>=18.0.0`

---

## Version Management (Changesets)

```bash
# Install
pnpm add -Dw @changesets/cli

# Init
pnpm changeset init
```

Add `.changeset/config.json`:
```json
{
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["@hushvault/web", "@hushvault/shared"]
}
```

Workflow:
1. Developer runs `pnpm changeset` → picks `hushvault` CLI package → writes change description
2. PR includes `.changeset/*.md` file
3. On merge to `main`, Changesets Action creates a "Version Packages" PR
4. Merging that PR bumps `apps/cli/package.json` version + publishes to npm

---

## npm Publish Workflow

```yaml
# .github/workflows/publish-cli.yml
name: Publish CLI

on:
  push:
    branches: [main]

jobs:
  publish:
    name: Publish to npm
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          registry-url: 'https://registry.npmjs.org'
          cache: 'pnpm'
      - run: pnpm install
      - name: Create Release Pull Request or Publish
        uses: changesets/action@v1
        with:
          publish: pnpm --filter @hushvault/cli publish --access public
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`NPM_TOKEN` set in GitHub Secrets (automation token from npmjs.com).

---

## node-keytar Native Binary

`node-keytar` requires native compilation. Handle gracefully:

```typescript
// apps/cli/src/config/auth.ts
async function getKeytar() {
  try {
    const keytar = await import('keytar')
    return keytar.default
  } catch {
    return null  // keytar not available (e.g., Linux without libsecret)
  }
}

export async function storeToken(token: string) {
  const keytar = await getKeytar()
  if (keytar) {
    await keytar.setPassword('hushvault', 'auth-token', token)
  } else {
    // Fallback: encrypted file at ~/.hushvault/credentials
    await writeCredentialsFile(token)
  }
}
```

Fallback credentials file:
- Path: `~/.hushvault/credentials`
- Permissions: `0600` (owner read/write only)
- Content: AES-256-GCM encrypted with a machine-specific key (derived from machine ID)

---

## Auto-Update Check

```typescript
// apps/cli/src/lib/update-check.ts
export async function checkForUpdate(currentVersion: string) {
  try {
    const res = await fetch('https://registry.npmjs.org/hushvault/latest', {
      signal: AbortSignal.timeout(2000)  // don't block for >2s
    })
    const { version: latest } = await res.json<{ version: string }>()

    if (latest !== currentVersion) {
      console.warn(`\n  Update available: ${currentVersion} → ${latest}`)
      console.warn(`  Run: npm install -g hushvault\n`)
    }
  } catch {
    // Silently fail — update check should never break CLI usage
  }
}
```

Called once per day (track last-check timestamp in `~/.hushvault/update-check`).

---

## Platform Matrix

| Platform | Keychain Storage | CLI binary | Status |
|----------|-----------------|------------|--------|
| macOS arm64 | macOS Keychain | ✅ via npm | Primary dev platform |
| macOS x64 | macOS Keychain | ✅ via npm | Supported |
| Ubuntu/Debian | libsecret (GNOME) | ✅ via npm | Requires `libsecret-1-dev` |
| Ubuntu (no GUI) | File fallback | ✅ via npm | Document in README |
| Windows 11 | Windows Credential Manager | ✅ via npm | Test in CI |
| Windows WSL | File fallback | ✅ via npm | Document in README |

---

## `npx` Zero-Install Usage

For CI environments that don't have `hushvault` globally installed:
```bash
npx hushvault run --env production -- npm run build
```

Ensure `apps/cli/package.json` has correct `bin` field and the package is self-contained.

---

## Homebrew Tap (Post-MVP)

After 500+ npm installs/week, add Homebrew formula:

```ruby
# hushvaultdev/homebrew-hushvault/Formula/hushvault.rb
class Hushvault < Formula
  desc "Secrets manager CLI for the edge"
  homepage "https://hushvault.dev"
  url "https://registry.npmjs.org/hushvault/-/hushvault-X.Y.Z.tgz"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end
end
```

Install: `brew tap hushvaultdev/hushvault && brew install hushvault`
