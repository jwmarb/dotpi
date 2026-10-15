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

# Resolve THIS repo, not the caller's. git-hooks.ts runs this script at every pi
# startup, in whatever workspace pi was opened in -- so a bare `git rev-parse`
# answers about that workspace instead: in another git repo it resolved to that
# repo's root, the globs matched nothing, and the found==0 guard below cried
# "no package.json found" on every startup outside this clone. Anchoring git to
# the script's own directory asks the question that was always meant: where is
# the repo containing this script? (It is the same repo, so the symlinked ~/.pi
# path resolves identically.)
#
# The repo-locating env must go first, for the same reason (see
# agent/extensions/lib/git-env.ts). post-checkout/post-merge run this script,
# and in a LINKED worktree git runs those hooks with GIT_DIR exported; with
# GIT_DIR set, `git -C "$here" rev-parse --show-toplevel` answers the current
# directory (scripts/) instead of the repo root — measured — so the link below
# landed in scripts/node_modules and the manifest scan found nothing. This
# script only ever means the repo it lives in, so it never inherits them.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY \
	GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_PREFIX GIT_CONFIG
here=$(cd "$(dirname "$0")" && pwd)
root=$(git -C "$here" rev-parse --show-toplevel 2>/dev/null) || root=$(dirname "$here")
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

# pi's own packages (@earendil-works/*, typebox) are NOT npm dependencies of
# this repo: at run time pi supplies them from its global install. Outside pi --
# `bun test`, scripts/check.sh, the pre-commit hook -- a bare import resolves by
# walking up from the importing file, so without a node_modules above the
# extensions every suite importing them dies with "Cannot find package
# 'typebox'". (This used to work by accident via a stray ~/node_modules; when it
# went away, 53 tests and the commit hook failed on a clean HEAD.) Link the
# running pi's node_modules at the repo root -- the same copy pi uses, so tests
# see the exact version that loads the extensions. NODE_PATH is not an
# alternative: `bun test` ignores it. Repaired when the link is missing or stale.
#
# Two layouts are recognised, in order: (a) a bun/npm global tree, found by
# readlink-ing `pi` on PATH into .../@earendil-works/pi-coding-agent/...; (b) pi's
# managed install, where `pi` is a shell launcher that execs
# <agent>/install/releases/<install/current-version>/node_modules/.bin/pi. For (b)
# the agent dir is this repo's own agent/, then ${PI_CODING_AGENT_DIR:-~/.pi/agent}
# (a worktree lacks the untracked install/) -- never `command -v pi`, which may
# belong to another install.
pi_cli=$(command -v pi 2>/dev/null) && pi_cli=$(readlink -f "$pi_cli")
pi_mods=${pi_cli%%/@earendil-works/pi-coding-agent/*}
if ! { [ -n "$pi_cli" ] && [ "$pi_mods" != "$pi_cli" ] && [ -d "$pi_mods/typebox" ]; }; then
	pi_mods=
	seen=
	for agent_dir in "$root/agent" "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"; do
		agent_dir=$(cd "$agent_dir" 2>/dev/null && pwd -P) || continue
		case " $seen " in *" $agent_dir "*) continue ;; esac
		seen="$seen $agent_dir"
		version=
		IFS= read -r version 2>/dev/null < "$agent_dir/install/current-version" || continue
		# Same validation as pi's launcher: a single safe path segment.
		case "$version" in
		"" | . | .. | *[!0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz._+-]*) continue ;;
		esac
		candidate="$agent_dir/install/releases/$version/node_modules"
		if [ -d "$candidate/typebox" ]; then
			pi_mods=$candidate
			break
		fi
	done
fi
if [ -n "$pi_mods" ]; then
	if [ -L node_modules ] && [ "$(readlink node_modules)" != "$pi_mods" ]; then
		rm node_modules
	fi
	if [ ! -e node_modules ]; then
		ln -s "$pi_mods" node_modules && echo "setup-deps: linked node_modules -> $pi_mods"
	elif [ ! -L node_modules ]; then
		echo "setup-deps: ./node_modules exists and is not a link; leaving it" >&2
	fi
else
	echo "setup-deps: could not locate pi's node_modules (bun global tree or managed install); tests importing pi packages will fail" >&2
	status=1
fi

# A run that discovered nothing means the globs stopped matching the tree -- the
# exact silent failure this script had when it looked at extensions only. Report
# it instead of exiting 0 on an empty loop.
if [ "$found" -eq 0 ]; then
	echo "setup-deps: no package.json found under agent/extensions or agent/skills" >&2
	status=1
fi
exit $status
