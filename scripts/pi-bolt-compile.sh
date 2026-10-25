#!/usr/bin/env bash
#
# Compile this config's extensions into Pi-Bolt, the AOT-compiled pi
# (https://github.com/opensec-git/Pi-Bolt), leaving out the ones known not to
# survive it, then smoke-test the result and roll back if it is broken.
#
#     bash scripts/pi-bolt-compile.sh            # compile, verify, keep or roll back
#     bash scripts/pi-bolt-compile.sh --status   # what is compiled in now
#     bash scripts/pi-bolt-compile.sh --off      # back to the release's executable
#
# Why not a bare `pi-bolt compile` (measured on Pi-Bolt 1.0.2, 2026-10-25):
#   - @ff-labs/pi-fff: imports @sinclair/typebox without depending on it, so the
#     build stops; shimmed in, it then needs bun:ffi, which the JIT-off build
#     cannot call ("bun:ffi requires the JIT"), so fffind/ffgrep break. Pi-Bolt
#     runs opensec-pi-fff instead (settings.json piBolt.packages, which this
#     script checks); that one is a core.cjs Bun build `pi-bolt compile` passes
#     over by itself, and it stays run-time loaded (~14 ms).
#   - The program's top-level code is ~270 KB of bytecode with these extensions,
#     over the 256 KB default AOT limit, so the limit is raised (compile.json
#     keeps it, so `pi-bolt update` re-compiles with it too). Override with
#     PIBOLT_AOT_LIMIT=<bytes>.
#
# The smoke test loads every extension in the new executable and compares the
# tool count with the executable it replaced, without calling a model. Add a
# name to EXCLUDE when a future extension refuses to compile or to load.
set -euo pipefail

EXCLUDE=(ff-labs-pi-fff)
AOT_LIMIT="${PIBOLT_AOT_LIMIT:-300000}"
SETTINGS="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/settings.json"

die() {
	echo "pi-bolt-compile: $*" >&2
	exit 1
}
command -v pi-bolt >/dev/null || die "pi-bolt is not on PATH (install: curl -fsSL https://pi-bolt.opensec.in/install.sh | sh)"

case "${1:-}" in
--status) exec pi-bolt compile --status ;;
--off) exec pi-bolt compile --off ;;
"") ;;
*) die "unknown argument: $1 (use --status, --off, or nothing)" ;;
esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A throwaway extension: report the tool count once every extension has loaded,
# then exit before the prompt reaches a model.
cat >"$work/probe.ts" <<'PROBE'
export default function (pi: any) {
	pi.on("session_start", () => {
		console.log(`PIBOLT_PROBE_TOOLS ${pi.getAllTools().length}`);
		process.exit(0);
	});
}
PROBE

# Prints the tool count (empty on failure); the full output goes to $work/$1.log.
count_tools() {
	(cd "$work" && timeout 120 pi-bolt --no-session -e "$work/probe.ts" -p probe >"$work/$1.log" 2>&1) || true
	sed -n 's/^PIBOLT_PROBE_TOOLS //p' "$work/$1.log" | tail -1
}

# Pi-Bolt should run the JIT-free fff, not the one that breaks without the JIT.
if [ -f "$SETTINGS" ] && command -v python3 >/dev/null; then
	fff_ok=0
	python3 - "$SETTINGS" <<'PY' || fff_ok=$?
import json, sys
own = (json.load(open(sys.argv[1])).get("piBolt") or {}).get("packages") or []
srcs = [p if isinstance(p, str) else p.get("source", "") for p in own]
ok = "-npm:@ff-labs/pi-fff" in srcs and any(s.startswith("npm:opensec-pi-fff") for s in srcs)
sys.exit(0 if ok else 1)
PY
	if [ "$fff_ok" -ne 0 ]; then
		echo "pi-bolt-compile: warning: settings.json piBolt.packages does not swap @ff-labs/pi-fff for npm:opensec-pi-fff; fffind/ffgrep will be slow or fail under Pi-Bolt" >&2
	fi
fi

before=$(count_tools before)
[ -n "$before" ] || die "the current pi-bolt does not start cleanly; fix that first (see: pi-bolt --no-session -p hi)"

exclude=$(
	IFS=,
	echo "${EXCLUDE[*]}"
)
echo "pi-bolt-compile: compiling (excluding: $exclude; AOT limit: $AOT_LIMIT bytes; $before tools now)"
if ! BUN_JSC_maximumAOTCandidateBytecodeSize="$AOT_LIMIT" pi-bolt compile --exclude "$exclude"; then
	die "the build failed and the installed executable is unchanged; the compiler's output is in ~/.pi-bolt/compile.log"
fi

echo "pi-bolt-compile: verifying the new executable"
after=$(count_tools after)
if [ -z "$after" ] || [ "$after" -lt "$before" ] || grep -qiE "failed to load extension|bun:ffi requires the JIT" "$work/after.log"; then
	grep -iE "error|fail|ffi" "$work/after.log" | head -20 >&2 || true
	pi-bolt update --rollback || true
	die "the compiled executable loaded ${after:-no} tools (before: $before) or an extension failed; rolled back. Add the culprit to EXCLUDE"
fi

echo "pi-bolt-compile: $after tools load (before: $before)"
pi-bolt compile --status
echo "pi-bolt-compile: done. Restart pi-bolt to use it; undo with: pi-bolt update --rollback"
