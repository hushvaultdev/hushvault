#!/bin/bash
# Claude Code SessionStart hook — machine/cloud convergence.
# 1. Branch freshness: warn loudly when behind origin/main.
# 2. Web bootstrap: install deps so lint/tests work from the first minute.
# Fail-safe: never blocks the session on network/tooling errors.
# Scaffolded by bootstrap-session-protocol.sh.

set -uo pipefail

DEFAULT_BRANCH="main"

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$PROJECT_DIR" || exit 0

# ── 1. Branch freshness (all environments) ──────────────────────────────────
if command -v git &>/dev/null && git rev-parse --is-inside-work-tree &>/dev/null; then
  git fetch origin "$DEFAULT_BRANCH" --quiet 2>/dev/null || true
  if git rev-parse --verify "origin/$DEFAULT_BRANCH" &>/dev/null; then
    BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    BEHIND="$(git rev-list --count "HEAD..origin/$DEFAULT_BRANCH" 2>/dev/null || echo 0)"
    if [ "$BEHIND" -gt 0 ]; then
      echo "⚠️  SESSION PROTOCOL WARNING: branch '$BRANCH' is $BEHIND commit(s) behind origin/$DEFAULT_BRANCH."
      echo "   Rebase BEFORE writing code:  git fetch origin $DEFAULT_BRANCH && git rebase origin/$DEFAULT_BRANCH"
      echo "   (or re-cut the branch:       git checkout -B $BRANCH origin/$DEFAULT_BRANCH)"
    else
      echo "✅ Branch '$BRANCH' is up to date with origin/$DEFAULT_BRANCH."
    fi
    if [ -x scripts/check-migration-drift.sh ]; then
      scripts/check-migration-drift.sh 2>/dev/null | grep '^❌' && \
        echo "   Renumber before pushing — details: ./scripts/check-migration-drift.sh" || true
    fi
  fi
fi

# ── 2. Web-session dependency bootstrap ──────────────────────────────────────
if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  if command -v pnpm &>/dev/null && [ -f package.json ] && [ ! -d node_modules ]; then
    echo "Installing pnpm dependencies (first run in this container)…"
    pnpm install --frozen-lockfile 2>&1 | tail -1 || echo "⚠️  pnpm install failed — run it manually."
  fi
fi

exit 0
