#!/usr/bin/env bash
#
# Verify every extension source file actually loads, then run the test suite.
#
#     ./scripts/check.sh
#
# With CHECK_STAGED=1 (set by the pre-commit hook) it checks the git INDEX —
# what the commit is about to record — instead of the working tree. Checking
# the working tree would let a partially staged file pass here and ship
# broken, and the index is exactly what the commit contains.
#
# ## Why this exists
#
# A commit shipped `dynamic-prompt.ts` with bare backticks inside a template
# literal. The file could not be parsed at all, so pi refused to start the
# extension and greeted the user with a ParseError. Everything else in that
# commit had been checked exhaustively — the plan extension was type-checked
# against a baseline and covered by 41 tests — but the one file edited last was
# never loaded even once.
#
# The lesson is not "remember to check". It is that a file which cannot be
# parsed is the cheapest possible failure to detect and the most expensive to
# ship, because it takes the whole extension down at startup rather than
# misbehaving somewhere specific. So detection belongs in a script, not in
# anybody's memory.
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

echo "${bold}Checking every extension source file${off} ${dim}(a parse error here is startup-fatal)${off}"

# Every .ts under agent/extensions, including shared modules like herdr/ and
# lib/ that are not extensions themselves but are imported by ones that are —
# a syntax error in those is just as fatal. Tests are excluded: they are run
# below by the test runner, which reports failures far better than an import.
#
# In staged mode the list comes from the index itself (git ls-files), not
# from the disk: a deleted file must not be checked, and an untracked file
# is not part of this commit.
#
# Two kinds of file need two different checks.
#
# A module is IMPORTED, which is the stronger check: it catches a syntax error, a
# bad import path, a missing export, and anything that throws at module
# initialization. That is safe because a pi extension's top level only registers
# things — its side effects happen when pi calls it.
#
# A CLI entrypoint (`plan/board.ts`, `subagent/mirror.ts`) is spawned as a
# subprocess with arguments and *runs* on import, exiting with a usage error when
# it finds none. Importing those reports a failure that is really the script
# working correctly, so they are only PARSED. The marker is a shebang on line 1:
# that is how every real entrypoint is marked, and it is stable — "reads
# process.argv" is an implementation detail that an indent, a wrapper, or a
# refactor can make a formatting-sensitive regex misclassify both ways. A new
# entrypoint without a shebang is imported and "fails" the check; the fix is to
# add the shebang it needs to be executable anyway.
while IFS= read -r file; do
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

echo
echo "${bold}Running this repo's tests${off} ${dim}(agent/git is vendored and gitignored, so it is excluded)${off}"

# Scoped deliberately. A bare `bun test` sweeps in the vendored pi-blackhole
# checkout under agent/git/, which fails 136 of its own tests for reasons that
# have nothing to do with this repo — noise that would train anyone to ignore
# this script's output.
if [ "$staged" -eq 1 ]; then
	mapfile -t tests < <(git -C "$REPO" ls-files -- 'agent/extensions' | grep -E '\.test\.ts$')
else
	mapfile -t tests < <(find agent/extensions -name '*.test.ts' -not -path '*/node_modules/*' | sort)
fi
if [ ${#tests[@]} -eq 0 ]; then
	note "$dim" "none" "no test files found"
else
	# Captured rather than piped so the exit code is the runner's, not `tail`'s.
	out=$(bun test "${tests[@]}" 2>&1)
	test_status=$?
	printf '%s\n' "$out" | tail -5
	[ "$test_status" -eq 0 ] || fails=$((fails + 1))
fi

echo
if [ "$fails" -eq 0 ]; then
	echo "${green}${bold}All checks passed.${off}"
else
	echo "${red}${bold}$fails check(s) failed.${off} Do not commit: a file that cannot load takes pi's startup with it."
fi
exit $((fails == 0 ? 0 : 1))
