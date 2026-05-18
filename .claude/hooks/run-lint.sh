#!/bin/bash
# Claude Code PostToolUse hook: Edit|Write
# Runs TypeScript type-check after every file edit.
# Runs async (non-blocking) — reports violations but does not block Claude.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$PROJECT_DIR"

# Only run if pnpm and node_modules are available
if ! command -v pnpm &>/dev/null; then
  exit 0
fi

if [ ! -d "node_modules" ]; then
  exit 0
fi

# No ESLint configured in this project yet — typecheck only.
# When an ESLint config is added, append: pnpm lint --no-fix 2>&1 | head -60 >&2 || true
echo "[typecheck] Running tsc --noEmit..." >&2
pnpm typecheck 2>&1 | head -60 >&2 || true

exit 0
