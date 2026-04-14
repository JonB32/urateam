#!/usr/bin/env bash
# Verify that a packed tarball contains the files we expect *before* publish.
# Catches packaging regressions (like the 0.1.4 .gitignore ENOENT) before they
# reach npm consumers.
#
# Usage:
#   verify-tarball.sh <tarball> <package-name>
#
# Per-package expectations are encoded below. For create-urateam, the script
# additionally extracts the tarball, dynamically imports scaffold(), and runs
# it against a scratch directory to confirm the bundled template + inlined
# .gitignore content actually work end-to-end.
set -euo pipefail

TARBALL="${1:?usage: verify-tarball.sh <tarball> <package-name>}"
PKG_NAME="${2:?usage: verify-tarball.sh <tarball> <package-name>}"

if [ ! -f "$TARBALL" ]; then
  echo "error: tarball not found: $TARBALL" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

echo "Verifying $PKG_NAME from $TARBALL"
echo "  workdir: $WORK_DIR"

# Extract tarball — npm tarballs always have a top-level 'package/' directory.
tar -xzf "$TARBALL" -C "$WORK_DIR"
EXTRACTED="$WORK_DIR/package"

if [ ! -d "$EXTRACTED" ]; then
  echo "error: extracted tarball has no package/ directory" >&2
  exit 1
fi

require_file() {
  local rel="$1"
  if [ ! -e "$EXTRACTED/$rel" ]; then
    echo "  ✗ missing required file: $rel" >&2
    exit 1
  fi
  echo "  ✓ $rel"
}

case "$PKG_NAME" in
  "@urateam/core")
    require_file "package.json"
    require_file "dist/index.js"
    require_file "dist/db/migrations"
    ;;
  "@urateam/dashboard")
    require_file "package.json"
    require_file "dist/server.js"
    ;;
  "@urateam/cli")
    require_file "package.json"
    require_file "dist/index.js"
    ;;
  "create-urateam")
    require_file "package.json"
    require_file "dist/index.js"
    require_file "template"
    require_file "template/.urateam"
    require_file "template/.urateam/Dockerfile"
    require_file "template/.urateam/docker-compose.yml"
    require_file "template/CLAUDE.md"
    require_file "template/README.md"

    # End-to-end: import scaffold() from the extracted dist/ and run it.
    # This is the regression guard for the 0.1.4 .gitignore ENOENT — if
    # the inlined .gitignore content or template resolution breaks, this
    # step crashes before publish.
    SCRATCH="$WORK_DIR/scratch"
    mkdir -p "$SCRATCH"
    node --input-type=module -e "
      import { scaffold } from '$EXTRACTED/dist/index.js';
      scaffold({
        projectDir: '$SCRATCH/proj',
        projectName: 'verify-proj',
        linearApiKey: 'lin_api_test',
        linearTeamId: 'team-test',
        repoUrl: 'https://github.com/test/repo',
        defaultBranch: 'main',
      });
      import('node:fs').then(({ readFileSync, existsSync }) => {
        const must = [
          '$SCRATCH/proj/.urateam/package.json',
          '$SCRATCH/proj/.urateam/.env',
          '$SCRATCH/proj/.urateam/Dockerfile',
          '$SCRATCH/proj/.urateam/docker-compose.yml',
          '$SCRATCH/proj/CLAUDE.md',
          '$SCRATCH/proj/README.md',
          '$SCRATCH/proj/.gitignore',
        ];
        for (const f of must) {
          if (!existsSync(f)) {
            console.error('  ✗ scaffold did not produce: ' + f);
            process.exit(1);
          }
        }
        const ig = readFileSync('$SCRATCH/proj/.gitignore', 'utf-8');
        if (!ig.includes('.urateam/.env') || !ig.includes('# urateam sidecar')) {
          console.error('  ✗ .gitignore missing expected content');
          process.exit(1);
        }
        console.log('  ✓ scaffold() end-to-end check passed');
      });
    "
    ;;
  *)
    echo "error: unknown package name '$PKG_NAME'" >&2
    exit 1
    ;;
esac

echo "  ✓ $PKG_NAME tarball verified"
