#!/usr/bin/env bash
# OZ Browser — Safe smoke test runner.
#
# Backs up real userData/identities.json BEFORE running smoke tests, restores AFTER.
# Prevents accidental corruption of the user's real state if a test points at the
# real data dir instead of a tmpdir.
#
# Usage:
#   bash scripts/safe-test.sh [test-file]
#
# If no test file given, runs ALL smoke tests in tests/.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER_DATA="$HOME/Library/Application Support/OZ Browser"
BACKUP_DIR="/tmp/oz-safe-test-backups/$(date +%s)"

if [ -d "$USER_DATA" ]; then
  echo "→ Backing up $USER_DATA → $BACKUP_DIR"
  mkdir -p "$BACKUP_DIR"
  cp -R "$USER_DATA" "$BACKUP_DIR/"
  trap 'echo "→ Restoring $USER_DATA from $BACKUP_DIR"; rm -rf "$USER_DATA"; cp -R "$BACKUP_DIR/OZ Browser" "$USER_DATA"; echo "✓ Restored"' EXIT
else
  echo "→ No real $USER_DATA, no backup needed."
fi

cd "$REPO_ROOT"

if [ "$#" -gt 0 ]; then
  echo "→ Running test: $1"
  node "$1"
else
  echo "→ Running ALL smoke tests in tests/"
  for t in tests/*.smoketest.js; do
    [ -f "$t" ] || continue
    echo ""
    echo "================================================================"
    echo "  $t"
    echo "================================================================"
    node "$t"
  done
fi

echo ""
echo "✓ All tests done. (data restored on exit)"
