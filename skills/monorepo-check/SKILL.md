# Monorepo Check Skill

Validate the health of the HushVault monorepo: dependencies, types, build, tests.

## When to Use

Use `/monorepo-check` when:
- Setting up a fresh clone
- After adding new packages or dependencies
- Before creating a PR
- After a merge conflict resolution

## Steps

### 1. Install Dependencies
```bash
pnpm install
```
Expected: no errors. If peer dependency warnings, note them but proceed.

### 2. Type Check
```bash
pnpm type-check
```
Expected: 0 errors across all packages.

### 3. Lint
```bash
pnpm lint
```
Expected: 0 errors. Warnings acceptable.

### 4. Build
```bash
pnpm build
```
Expected: all packages build successfully.

### 5. Test
```bash
pnpm test
```
Expected: all tests pass.

### 6. Check Cross-Package Imports

Verify no relative cross-package imports exist:
```bash
grep -r "from '../../packages" apps/
grep -r "from '../../../apps" packages/
```
Expected: no matches. Cross-package imports must use `@hushvault/shared`.

### 7. Check for Accidental Secret Files

```bash
ls apps/api/.dev.vars 2>/dev/null && echo "WARNING: .dev.vars exists (should be git-ignored)"
ls apps/api/.env 2>/dev/null && echo "WARNING: .env exists"
```

## Common Issues

| Error | Fix |
|-------|-----|
| `Cannot find module '@hushvault/shared'` | Run `pnpm install` — workspace symlinks not created |
| `Type error in packages/shared` | Build shared first: `pnpm --filter @hushvault/shared build` |
| `wrangler.toml missing database_id` | Add placeholder `REPLACE_WITH_ACTUAL_ID` — see docs/DEPLOYMENT.md |
| Worker type errors | Run `wrangler types` to regenerate `worker-configuration.d.ts` |

## Expected Output

```
✅ pnpm install — OK
✅ type-check — 0 errors
✅ lint — 0 errors
✅ build — all packages built
✅ test — N tests passed
✅ no cross-package relative imports
✅ no accidental secret files
```
