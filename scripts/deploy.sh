#!/bin/bash
# Guarded deploy: makes deploy-from-dirty-tree and deploy-from-stale-branch impossible.
#   ./scripts/deploy.sh api                  # normal path (production Worker)
#   ./scripts/deploy.sh api --allow-branch   # explicit hotfix override
#   ./scripts/deploy.sh api-dev              # beta preview Worker (wrangler --env dev)
#
# The two guard checks are the point; deploy from CI on merge remains the gold
# standard (see .github/workflows/deploy-api.yml).

set -euo pipefail

DEFAULT_BRANCH="main"   # integration branch

TARGET="${1:?usage: deploy.sh <api|api-dev> [--allow-branch]}"
ALLOW_BRANCH="${2:-}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# 1. Clean tree — never ship code that isn't committed.
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working tree is dirty. Commit (or stash) before deploying:"
  git status --short | head -20
  exit 1
fi

# 2. At integration-branch tip — never ship code the team doesn't have.
git fetch origin "$DEFAULT_BRANCH" --quiet
if [ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$DEFAULT_BRANCH")" ]; then
  if [ "$ALLOW_BRANCH" = "--allow-branch" ]; then
    echo "⚠️  HEAD is not origin/$DEFAULT_BRANCH tip (--allow-branch override)."
  else
    echo "❌ HEAD ($(git rev-parse --short HEAD)) is not origin/$DEFAULT_BRANCH tip."
    echo "   Merge your PR first, then: git checkout $DEFAULT_BRANCH && git pull && $0 $TARGET"
    exit 1
  fi
fi

# 3. Deploy the HushVault API Worker.
echo "🚀 Deploying $TARGET from $(git rev-parse --short HEAD)…"
case "$TARGET" in
  api)     (cd apps/api && pnpm exec wrangler deploy) ;;
  api-dev) (cd apps/api && pnpm exec wrangler deploy --env dev) ;;
  *) echo "❌ unknown target '$TARGET' (expected: api | api-dev)"; exit 1 ;;
esac
echo "✅ Deployed $TARGET @ $(git rev-parse --short HEAD)"
