#!/bin/bash
# Fails on NEW migration-numbering collisions vs origin/main:
#   1. new file reuses a number the branch already has under a different name
#   2. two new files share a prefix
#   3. new plain-numbered file is <= the branch's max sequential number
# Historical files are grandfathered — only new violations fail, so adoption
# never blocks on cleanup.

set -euo pipefail
DEFAULT_BRANCH="main"                      # integration branch
MIGRATIONS_DIR="apps/api/migrations"       # D1 sequential migrations (NNNN_name.sql)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
FAIL=0

prefix() { grep -oE '^[0-9]+[a-z]?' <<<"$1" || true; }

git fetch origin "$DEFAULT_BRANCH" --quiet 2>/dev/null || true
git rev-parse --verify "origin/$DEFAULT_BRANCH" &>/dev/null || { echo "⚠️  origin/$DEFAULT_BRANCH unavailable — skipping"; exit 0; }

DEV_FILES="$(git ls-tree --name-only "origin/$DEFAULT_BRANCH" "$MIGRATIONS_DIR/" | grep -E '\.sql$' | xargs -r -n1 basename)"
DEV_MAX="$(echo "$DEV_FILES" | grep -oE '^[0-9]+' | awk '$1 < 1000' | sort -n | tail -1)"

NEW_FILES="$( (git diff --name-only --diff-filter=AR "origin/$DEFAULT_BRANCH...HEAD" -- "$MIGRATIONS_DIR/*.sql" 2>/dev/null; \
               git ls-files --others --exclude-standard "$MIGRATIONS_DIR/*.sql") | xargs -r -n1 basename | sort -u)"

[ -z "$NEW_FILES" ] && { echo "✅ No new migrations — nothing to check."; exit 0; }

for base in $NEW_FILES; do
  p="$(prefix "$base")"; [ -z "$p" ] && continue
  n="$(grep -oE '^[0-9]+' <<<"$p")"
  CLASH="$(echo "$DEV_FILES" | grep -E "^${p}_" | grep -vx "$base" || true)"
  if [ -n "$CLASH" ]; then
    echo "❌ $base reuses prefix '$p' already taken by: $CLASH"; FAIL=1; continue
  fi
  SELF_CLASH="$(echo "$NEW_FILES" | grep -E "^${p}_" | grep -vx "$base" || true)"
  if [ -n "$SELF_CLASH" ]; then
    echo "❌ $base and $SELF_CLASH share prefix '$p' in this change set"; FAIL=1; continue
  fi
  if [ "$p" = "$n" ] && [ "$n" -le "${DEV_MAX:-0}" ]; then
    echo "❌ New migration $base is numbered $n but branch is already at $DEV_MAX — renumber to $((DEV_MAX + 1))+"; FAIL=1
  fi
done

[ "$FAIL" -eq 0 ] && echo "✅ New migration(s) numbered cleanly (branch max: ${DEV_MAX:-?})."
exit "$FAIL"
