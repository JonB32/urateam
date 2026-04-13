#!/usr/bin/env bash
# Publish a single package tarball to npm via trusted publishing (OIDC).
# Exits 0 if the version already exists on npm (skip, not an error) so the
# workflow can publish all 4 packages on each tag even when some versions
# are unchanged.
#
# Usage: publish-package.sh <tarball-glob>
set -euo pipefail

TARBALL=$(ls $1)
if [ -z "$TARBALL" ]; then
  echo "error: no tarball found matching $1" >&2
  exit 1
fi

echo "Publishing $TARBALL"

# Capture stderr to detect the "already published" error without losing it.
if ! output=$(npx -y npm@latest publish "$TARBALL" --access public --provenance 2>&1); then
  if echo "$output" | grep -qi "cannot publish over the previously published versions"; then
    echo "$output"
    echo ""
    echo "ℹ️  Version already exists on npm — skipping (not an error)."
    exit 0
  fi
  echo "$output" >&2
  exit 1
fi

echo "$output"
