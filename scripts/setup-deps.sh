#!/usr/bin/env bash
#
# Install the npm dependencies of every extension that declares them.
#
# node_modules/ is git-ignored, so a fresh clone has extension sources
# without their dependencies: the mcp extension then fails to load with
# "Cannot find module '@modelcontextprotocol/sdk/...'". This script is the
# one step that turns a clone into a working config.
#
# Called three ways, all best-effort and quiet on success:
#   - .githooks/post-checkout and .githooks/post-merge, with --force —
#     the lockfile may have just changed, so the installed tree is
#     re-verified against it
#   - agent/extensions/git-hooks.ts at pi startup, without --force —
#     covers the initial clone, which no git hook sees; a no-op when
#     everything is already installed
#   - by hand, when an install went missing: bash scripts/setup-deps.sh
set -uo pipefail

force=0
[ "${1:-}" = "--force" ] && force=1

root=$(git rev-parse --show-toplevel 2>/dev/null) || root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root" || exit 0

if ! command -v npm >/dev/null 2>&1; then
	echo "setup-deps: npm not found on PATH; skipping extension dependency install" >&2
	exit 0
fi

status=0
for pkg in agent/extensions/*/package.json; do
	[ -e "$pkg" ] || continue
	dir=$(dirname "$pkg")
	# Skip trees that are present and non-empty (an empty node_modules is a
	# leftover of an interrupted install, and must be retried).
	if [ "$force" -eq 0 ] && [ -d "$dir/node_modules" ] && [ -n "$(ls -A "$dir/node_modules" 2>/dev/null)" ]; then
		continue
	fi
	echo "setup-deps: npm install in $dir"
	if ! (cd "$dir" && npm install --no-audit --no-fund --loglevel=error); then
		echo "setup-deps: dependency install failed for $dir" >&2
		status=1
	fi
done
exit $status
