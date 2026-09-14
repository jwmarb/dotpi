#!/usr/bin/env bash
#
# Verify every extension source file actually loads, then run the test suite.
#
#     ./scripts/check.sh
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
ROOT=$(pwd)

red=$'\e[31m'; green=$'\e[32m'; dim=$'\e[2m'; bold=$'\e[1m'; off=$'\e[0m'
fails=0
note() { printf '  %s%s%s %s\n' "$1" "$2" "$off" "$3"; }

echo "${bold}Checking every extension source file${off} ${dim}(a parse error here is startup-fatal)${off}"

# Every .ts under agent/extensions, including shared modules like herdr/ and
# lib/ that are not extensions themselves but are imported by ones that are —
# a syntax error in those is just as fatal. Tests are excluded: they are run
# below by the test runner, which reports failures far better than an import.
#
# Two kinds of file need two different checks.
#
# A module is IMPORTED, which is the stronger check: it catches a syntax error, a
# bad import path, a missing export, and anything that throws at module
# initialisation. That is safe because a pi extension's top level only registers
# things — its side effects happen when pi calls it.
#
# A CLI entrypoint (`plan/board.ts`, `subagent/mirror.ts`) is spawned as a
# subprocess with arguments and *runs* on import, exiting with a usage error when
# it finds none. Importing those reports a failure that is really the script
# working correctly, so they are only PARSED. Detecting them by content rather
# than by a hardcoded list means a new one is handled without editing this file.
while IFS= read -r file; do
	case "$file" in
	*.test.ts | *.d.ts) continue ;;
	esac
	# A top-level `process.argv[N]` read outside a function means it expects to be
	# invoked, not imported.
	if grep -qE '^(const|let|var)[^=]*=[^=]*process\.argv' "$file"; then
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
done < <(find agent/extensions -name '*.ts' -not -path '*/node_modules/*' | sort)

echo
echo "${bold}Running this repo's tests${off} ${dim}(agent/git is vendored and gitignored, so it is excluded)${off}"

# Scoped deliberately. A bare `bun test` sweeps in the vendored pi-blackhole
# checkout under agent/git/, which fails 136 of its own tests for reasons that
# have nothing to do with this repo — noise that would train anyone to ignore
# this script's output.
mapfile -t tests < <(find agent/extensions -name '*.test.ts' -not -path '*/node_modules/*' | sort)
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
