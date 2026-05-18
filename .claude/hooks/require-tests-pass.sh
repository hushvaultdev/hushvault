#!/bin/bash
# Claude Code TaskCompleted hook — BLOCKING gate (exit 2 = block task completion)
# Verifies that the Vitest test suite passes before Claude marks a task complete.
# Exit 2 causes Claude Code to block the task and show the failure output.

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$PROJECT_DIR"

# Skip if pnpm is not available
if ! command -v pnpm &>/dev/null; then
  echo "[tests] pnpm not found — skipping test gate" >&2
  exit 0
fi

# Skip if node_modules are not installed
if [ ! -d "node_modules" ]; then
  echo "[tests] node_modules missing — skipping test gate (run pnpm install first)" >&2
  exit 0
fi

# Skip if no `test` script is defined in package.json (Vitest not set up yet)
if ! node -e "process.exit(require('./package.json').scripts?.test ? 0 : 1)" 2>/dev/null; then
  echo "[tests] no 'test' script in package.json — skipping test gate (Vitest not configured yet)" >&2
  exit 0
fi

echo "[tests] Running Vitest unit test suite..." >&2

if pnpm test --run --silent 2>&1; then
  echo "[tests] ✅ All tests passed" >&2
  exit 0
else
  echo "[tests] ❌ Tests failed — task blocked until tests pass" >&2
  echo "[tests] Run 'pnpm test' to see full output and fix failures" >&2
  # Exit code 2 signals Claude Code to block task completion
  exit 2
fi
