#!/usr/bin/env bash
#
# Verify this repo loads, type-checks and passes its tests.
#
#     ./scripts/check.sh
#
# With CHECK_STAGED=1 (set by the pre-commit hook) it checks the git INDEX —
# what the commit is about to record — instead of the working tree. Checking the
# working tree would let a partially staged file pass here and ship broken, and
# the index is exactly what the commit contains.
#
# ## Why this exists
#
# A commit shipped `dynamic-prompt.ts` with bare backticks inside a template
# literal. The file could not be parsed at all, so pi refused to start the
# extension and greeted the user with a ParseError. Everything else in that
# commit had been checked exhaustively; the one file edited last was never loaded
# even once.
#
# The lesson is not "remember to check". It is that a file which cannot be parsed
# is the cheapest possible failure to detect and the most expensive to ship,
# because it takes the whole extension down at startup rather than misbehaving
# somewhere specific. So detection belongs in a script, not in anybody's memory.
#
# ## Why it exists *again*
#
# This script was deleted in `7a54a3b` as collateral damage, along with the
# herdr/plan/subagent extensions it had been written beside. `.githooks/pre-commit`
# still invoked it, guarded by `[ -x "$check" ] || exit 0` — so for every commit
# after that, the guard against silent startup failure silently did nothing,
# while `git-hooks.ts` went on telling the user their commits were protected.
# That is the exact failure mode the hook's own header argues against. A guard
# that can vanish without a sound is worse than no guard, because it also removes
# the reason to look. The hook now *fails* when this file is missing.
#
# Importing is a deliberately stronger check than parsing. It catches a syntax
# error, a bad import path, a missing export and anything that throws at module
# initialisation — all of which are startup-fatal in exactly the same way. It is
# safe to do because a pi extension's top level only registers things; its side
# effects happen when pi calls it, not when it loads.
#
# Exits non-zero the moment anything fails, so it is usable as a pre-commit hook.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
REPO=$(pwd)

staged=0
[ "${CHECK_STAGED:-0}" = "1" ] && staged=1

# Scratch materialisation of the index; removed on exit even on failure.
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

if [ "$staged" -eq 1 ]; then
	# Materialise the index — not the working tree — and check that: the
	# commit records the index, so that is what must load.
	#
	# The scratch dir sits INSIDE the repo, not in /tmp. Module resolution
	# walks up from the imported file, and the pi packages live in a
	# node_modules above the repo root; a /tmp copy would resolve nothing and
	# fail every import for a reason its error message cannot express.
	TMP="$REPO/.git-check"
	rm -rf "$TMP"
	mkdir -p "$TMP"
	git checkout-index -a --prefix="$TMP/"
	# node_modules is gitignored, so the checkout lacks it. Link each top-level
	# one back from the working tree (nested ones come along through it) so bare
	# imports resolve the way they will on the real machine. (agent/git is a
	# vendored checkout, excluded like everywhere else in this script.)
	while IFS= read -r -d '' nm; do
		rel="${nm#"$REPO/"}"
		if [ ! -e "$TMP/$rel" ]; then
			mkdir -p "$TMP/$(dirname "$rel")"
			ln -s "$nm" "$TMP/$rel"
		fi
	done < <(find agent -name node_modules -type d -not -path 'agent/git/*' -not -path '*/node_modules/*' -print0)
	cd "$TMP" || exit 1
	ROOT=$(pwd)
else
	cd "$REPO" || exit 1
	ROOT=$(pwd)
fi

red=$'\e[31m'; green=$'\e[32m'; dim=$'\e[2m'; bold=$'\e[1m'; off=$'\e[0m'
fails=0
note() { printf '  %s%s%s %s\n' "$1" "$2" "$off" "$3"; }

# ---------------------------------------------------------------------------
# 1. Every extension source loads
# ---------------------------------------------------------------------------
echo "${bold}Checking every extension source file${off} ${dim}(a parse error here is startup-fatal)${off}"

# Every .ts under agent/extensions, including shared modules like lib/ that are
# not extensions themselves but are imported by ones that are — a syntax error
# in those is just as fatal. Tests are excluded: they are run below by the test
# runner, which reports failures far better than an import.
#
# In staged mode the list comes from the index itself (git ls-files), not from
# the disk: a deleted file must not be checked, and an untracked file is not
# part of this commit.
#
# Two kinds of file need two different checks.
#
# A module is IMPORTED, which is the stronger check: it catches a syntax error, a
# bad import path, a missing export, and anything that throws at module
# initialization. That is safe because a pi extension's top level only registers
# things — its side effects happen when pi calls it.
#
# A CLI entrypoint is spawned as a subprocess with arguments and *runs* on
# import, exiting with a usage error when it finds none. Importing those reports
# a failure that is really the script working correctly, so they are only PARSED.
# The marker is a shebang on line 1: that is how every real entrypoint is marked,
# and it is stable — "reads process.argv" is an implementation detail that an
# indent, a wrapper, or a refactor can make a formatting-sensitive regex
# misclassify both ways. A new entrypoint without a shebang is imported and
# "fails" the check; the fix is to add the shebang it needs to be executable
# anyway.
#
# A test file directly under agent/extensions/ is a bug in its own right: pi
# auto-discovers every top-level `.ts` there as an extension, so `foo.test.ts` is
# loaded at startup, fails on `bun:test`, and pi refuses to start — the same
# startup-fatal shape this script exists to catch. Tests belong in a
# subdirectory (`lib/`, `ralph-loop/`, `subagent-herdr/`), which pi enters only
# via `index.ts`. Checked before the loop so the message names the cause.
while IFS= read -r file; do
	case "$file" in
	agent/extensions/*.test.ts)
		if [ "$(dirname "$file")" = "agent/extensions" ]; then
			fails=$((fails + 1))
			note "$red" "FAIL" "$file"
			printf '        %s\n' "a top-level test file is auto-loaded as an extension and will break pi's startup"
			printf '        %s\n' "move it into a subdirectory, e.g. agent/extensions/lib/foo.test.ts"
		fi
		continue
		;;
	esac
	case "$file" in
	*.test.ts | *.d.ts) continue ;;
	*.ts) ;;
	*) continue ;;
	esac
	# A shebang on line 1 marks an entrypoint: invoked, not imported.
	if [ "$(head -c 2 "$file" 2>/dev/null)" = "#!" ]; then
		if err=$(bun build --target=bun --no-bundle "$file" 2>&1 >/dev/null); then
			note "$green" "parse" "$file ${dim}(cli entrypoint; parsed, not run)${off}"
			continue
		fi
	elif err=$(bun -e "await import('$ROOT/$file')" 2>&1); then
		note "$green" "ok   " "$file"
		continue
	fi
	fails=$((fails + 1))
	note "$red" "FAIL" "$file"
	# Only the `error:` lines. Bun leads with a source excerpt and a caret, which
	# loses its column alignment once indented here and says nothing on its own.
	printf '%s' "$err" | grep -E '^(error|SyntaxError|.*Error):' | head -2 |
		while IFS= read -r line; do printf '        %s\n' "$line"; done
done < <(
	if [ "$staged" -eq 1 ]; then
		git -C "$REPO" ls-files -- 'agent/extensions'
	else
		find agent/extensions -name '*.ts' -not -path '*/node_modules/*' | sort
	fi
)

# ---------------------------------------------------------------------------
# 2. Every typecheck scope passes
# ---------------------------------------------------------------------------
# There is no root tsconfig; each subdirectory extension with one owns its own
# scope. Discovered rather than listed, so a fourth scope is covered the day it
# is added — the drift that let `rundir.ts` sit outside the declared scope of the
# module it belongs to.
#
# Skipped in staged mode: tsc needs the real node_modules and the running pi's
# bundle, and the scratch index copy resolves neither reliably.
echo
echo "${bold}Type-checking every scope${off} ${dim}(no root tsconfig — one per subdirectory extension)${off}"
TSC="$REPO/agent/extensions/subagent-herdr/node_modules/.bin/tsc"
if [ ! -x "$TSC" ]; then
	note "$dim" "skip " "tsc not installed (run: bash scripts/setup-deps.sh)"
elif [ "$staged" -eq 1 ]; then
	note "$dim" "skip " "staged mode checks loadability only"
else
	while IFS= read -r cfg; do
		dir=$(dirname "$cfg")
		if err=$(cd "$dir" && "$TSC" -p tsconfig.json 2>&1); then
			note "$green" "ok   " "$dir"
		else
			fails=$((fails + 1))
			note "$red" "FAIL" "$dir"
			printf '%s' "$err" | head -5 | while IFS= read -r line; do printf '        %s\n' "$line"; done
		fi
	done < <(find agent/extensions -name tsconfig.json -not -path '*/node_modules/*' | sort)
fi

# ---------------------------------------------------------------------------
# 3. The test suite
# ---------------------------------------------------------------------------
echo
echo "${bold}Running this repo's tests${off} ${dim}(agent/git is vendored and gitignored, so it is excluded)${off}"

# Scoped deliberately. A bare `bun test` sweeps in the vendored checkouts under
# agent/git/, which fail hundreds of their own tests for reasons that have
# nothing to do with this repo — noise that would train anyone to ignore this
# script's output. Discovered rather than listed so a new suite is picked up.
#
# Run against the WORKING TREE even in staged mode, deliberately. The scratch
# copy symlinks each `node_modules` back to the real one, and bun resolves a bare
# import by walking up from the *importing file*: in the real tree
# `model-fallback/lib.test.ts` reaches the running pi's 1.0.0 bundle, while from
# the scratch root the same import walks to the 0.75.4 copy in `~/node_modules`
# and dies on an export that version does not have. That is an artifact of the
# materialisation, not a defect in the commit — and a gate that cries wolf is a
# gate people learn to bypass. Loadability is what staged mode exists to check
# (it is the startup-fatal class, and it *is* checked against the index above);
# a test failure is not file-local, so the working tree is the honest subject.
cd "$REPO" || exit 1
mapfile -t tests < <(find agent/extensions -name '*.test.ts' -not -path '*/node_modules/*' | sort)
if [ ${#tests[@]} -eq 0 ]; then
	# Not "nothing to do": this repo has suites, so finding none means the
	# discovery broke.
	note "$red" "FAIL" "no test files found — discovery is broken"
	fails=$((fails + 1))
else
	# Captured rather than piped so the exit code is the runner's, not `tail`'s.
	out=$(bun test "${tests[@]}" 2>&1)
	test_status=$?
	# Named failures first. Also surface an "Unhandled error between tests": a
	# suite that fails to *load* reports no `(fail)` line at all, so grepping only
	# for those prints a bare "1 fail" with nothing to act on — which is how the
	# resolution skew above cost an hour to find.
	printf '%s\n' "$out" | grep -E '^\(fail\)' | head -10 | while IFS= read -r line; do printf '        %s\n' "$line"; done
	printf '%s\n' "$out" | grep -E '^(SyntaxError|TypeError|ReferenceError|error):|^# Unhandled error' | head -5 | while IFS= read -r line; do printf '        %s\n' "$line"; done
	printf '%s\n' "$out" | grep -E '^ *[0-9]+ (pass|fail|error)' | while IFS= read -r line; do printf '       %s\n' "$line"; done
	[ "$test_status" -eq 0 ] || fails=$((fails + 1))
fi

echo
if [ "$fails" -eq 0 ]; then
	echo "${green}${bold}All checks passed.${off}"
else
	echo "${red}${bold}$fails check(s) failed.${off} Do not commit: a file that cannot load takes pi's startup with it."
fi
exit $((fails == 0 ? 0 : 1))
