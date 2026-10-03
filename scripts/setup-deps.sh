#!/usr/bin/env bash
#
# Install the npm dependencies of everything in this repo that declares them.
#
# node_modules/ is git-ignored, so a fresh clone has sources without their
# dependencies. Two kinds of tree declare some:
#
#   - an extension (`agent/extensions/<name>/`), where what is left is dev-only
#     (typescript + @types/node for the typecheck scope) since MCP moved to pi's
#     built-in extension -- every extension LOADS without this script. It is
#     still run automatically so `tsc -p` works in a fresh clone.
#   - a skill (`agent/skills/<category>/<name>/`), where the dependency is what
#     the skill's own tool imports at run time, so a missing tree is a skill that
#     fails when invoked rather than one that merely cannot be type-checked.
#
# Both roots are scanned because the interface this script advertises is "install
# every dependency set this repo declares", and a glob naming only one of them
# made that false silently: `git mv`-ing the create-readme skill into a category
# left its 232 MB tree orphaned at the old path, and `check_mermaid.mjs` failed
# with `Cannot find package 'jsdom'` while this script reported success.
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
	echo "setup-deps: npm not found on PATH; skipping dependency install" >&2
	exit 0
fi

status=0
found=0

# Every tracked package.json under the two roots that own one. `git ls-files`
# rather than a find: it excludes the vendored checkouts under agent/git/ (whose
# own manifests are not ours to install) and every generated node_modules tree,
# without this script having to restate either exclusion. The fallback keeps a
# non-git export working, and prunes the same two shapes by hand.
if manifests=$(git ls-files -- 'agent/extensions/*/package.json' 'agent/skills/*/package.json' 'agent/skills/*/*/package.json' 2>/dev/null) && [ -n "$manifests" ]; then
	:
else
	manifests=$(find agent/extensions agent/skills -name package.json \
		-not -path '*/node_modules/*' -not -path 'agent/git/*' 2>/dev/null | sort)
fi

for pkg in $manifests; do
	[ -e "$pkg" ] || continue
	found=$((found + 1))
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

# A run that discovered nothing means the globs stopped matching the tree -- the
# exact silent failure this script had when it looked at extensions only. Report
# it instead of exiting 0 on an empty loop.
if [ "$found" -eq 0 ]; then
	echo "setup-deps: no package.json found under agent/extensions or agent/skills" >&2
	status=1
fi
exit $status
