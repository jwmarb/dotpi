#!/usr/bin/env bash
#
# Set this config up to run under Pi-Bolt (https://github.com/opensec-git/Pi-Bolt), the
# ahead-of-time compiled pi, while keeping plain `pi` working. Both share
# ~/.pi/agent (settings, sessions, extensions), so you can switch between `pi`
# and `pi-bolt` at any time.
#
#     bash scripts/migrate-pi-bolt.sh             # install/verify Pi-Bolt, apply the settings, compile
#     bash scripts/migrate-pi-bolt.sh --check     # report what is and is not set up; change nothing
#     bash scripts/migrate-pi-bolt.sh --no-compile
#     bash scripts/migrate-pi-bolt.sh --undo      # Pi-Bolt-only settings out, compiled build off
#
# What it does, each step idempotent:
#   1. Pi-Bolt: installs it with its signed installer when `pi-bolt` is missing
#      (PIBOLT_YES=1, no start, no optional extensions offered).
#   2. pi stays: checks the bun-installed `pi` is still there. Pi-Bolt does not
#      replace it, and this config still needs it: the kanban board script and
#      the tests resolve @earendil-works/* through the repo-root node_modules link.
#   3. settings.json, written directly (`pi-bolt install` would put the package in
#      the shared `packages` list, which plain pi then loads too):
#        - extensions: "-builtin:herdr". Pi-Bolt's own herdr reporter calls the pane
#          `pi-bolt`, which makes `herdr agent start --kind pi` (subagents) refuse it.
#          Ignored by plain pi, which has no such built-in.
#        - piBolt.packages: "-npm:@ff-labs/pi-fff", "npm:opensec-pi-fff@<pin>". Only
#          Pi-Bolt reads this overlay: it drops pi-fff (needs bun:ffi, i.e. the JIT)
#          for OpenSec's JIT-free build. Plain pi keeps @ff-labs/pi-fff.
#      A timestamped backup is written next to the file first.
#   4. opensec-pi-fff: installed into agent/npm (where `pi install` puts packages)
#      without touching the settings `packages` list.
#   5. Compile: runs scripts/pi-bolt-compile.sh (verifies and rolls back on failure).
#
# The extension-side compatibility (kanban, subagents, ralph-loop, auto-update,
# pi-blackhole) lives in agent/extensions and needs no setup: it switches on only
# when it detects it is running under Pi-Bolt (agent/extensions/lib/runtime.ts).
set -euo pipefail

OPENSEC_FFF="opensec-pi-fff@0.11.1"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"

mode=apply
compile=1
for arg in "$@"; do
	case "$arg" in
	--check) mode=check ;;
	--undo) mode=undo ;;
	--no-compile) compile=0 ;;
	-h | --help)
		sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "migrate-pi-bolt: unknown argument: $arg (see --help)" >&2
		exit 1
		;;
	esac
done

if [ -t 1 ]; then B=$'\033[1m' R=$'\033[0m' G=$'\033[32m' Y=$'\033[33m' X=$'\033[31m'; else B= R= G= Y= X=; fi
step() { printf '%s==>%s %s\n' "$B" "$R" "$*"; }
ok() { printf '  %s✓%s %s\n' "$G" "$R" "$*"; }
todo() { printf '  %s•%s %s\n' "$Y" "$R" "$*"; }
die() {
	printf '  %s✗%s %s\n' "$X" "$R" "$*" >&2
	exit 1
}

command -v python3 >/dev/null || die "python3 is needed to edit settings.json safely"
[ -f "$SETTINGS" ] || die "no $SETTINGS: install this config first (install.sh)"

# settings.json edits, in one place. `$1`: check | apply | undo. Exit 3 from check = changes needed.
settings_edit() {
	python3 - "$1" "$SETTINGS" "npm:$OPENSEC_FFF" <<'PY'
import json, shutil, sys, time
mode, path, fff = sys.argv[1], sys.argv[2], sys.argv[3]
s = json.load(open(path))
want_ext = "-builtin:herdr"
want_pkgs = ["-npm:@ff-labs/pi-fff", fff]
src = lambda p: p if isinstance(p, str) else p.get("source", "")

ext = s.get("extensions") or []
pb = s.get("piBolt") or {}
own = pb.get("packages") or []
own_srcs = [src(p) for p in own]
shared = [src(p) for p in s.get("packages") or []]

if mode == "check":
    missing = []
    if want_ext not in ext: missing.append('extensions: "-builtin:herdr"')
    for p in want_pkgs:
        base = p.split("@0")[0] if p.startswith("npm:opensec") else p
        if not any(o == p or o.startswith(base) for o in own_srcs): missing.append(f"piBolt.packages: {p}")
    if any(x.startswith("npm:opensec-pi-fff") for x in shared):
        missing.append("packages (shared) lists opensec-pi-fff: plain pi would load both fff builds")
    for m in missing: print(m)
    sys.exit(3 if missing else 0)

new = json.loads(json.dumps(s))
if mode == "apply":
    if want_ext not in ext: new["extensions"] = ext + [want_ext]
    keep = [p for p in own if not src(p).startswith("npm:opensec-pi-fff") and src(p) != "-npm:@ff-labs/pi-fff"]
    new["piBolt"] = {**pb, "packages": keep + want_pkgs, "packagesOverlay": True}
    new["packages"] = [p for p in s.get("packages") or [] if not src(p).startswith("npm:opensec-pi-fff")]
elif mode == "undo":
    new["extensions"] = [e for e in ext if e != want_ext]
    keep = [p for p in own if not src(p).startswith("npm:opensec-pi-fff") and src(p) != "-npm:@ff-labs/pi-fff"]
    if keep: new["piBolt"] = {**pb, "packages": keep}
    else:
        rest = {k: v for k, v in pb.items() if k not in ("packages", "packagesOverlay")}
        if rest: new["piBolt"] = rest
        else: new.pop("piBolt", None)

if new == s:
    print("unchanged")
    sys.exit(0)
backup = f"{path}.{time.strftime('%Y%m%d-%H%M%S')}.bak"
shutil.copy2(path, backup)
with open(path + ".tmp", "w") as f:
    json.dump(new, f, indent=2)
    f.write("\n")
shutil.move(path + ".tmp", path)
print(f"updated (backup: {backup})")
PY
}

# --- check: report, change nothing -----------------------------------------
if [ "$mode" = check ]; then
	step "Pi-Bolt setup"
	gaps=0
	if command -v pi-bolt >/dev/null; then ok "pi-bolt $(pi-bolt --version 2>/dev/null)"; else todo "pi-bolt not installed"; gaps=1; fi
	if command -v pi >/dev/null; then ok "pi $(pi --version 2>/dev/null) (kept for plain-pi use and the repo's tests)"; else todo "pi (bun) not found: the kanban board and tests need it"; gaps=1; fi
	set +e
	out=$(settings_edit check)
	rc=$?
	set -e
	if [ "$rc" -eq 0 ]; then ok "settings.json has the Pi-Bolt entries"; else while IFS= read -r l; do todo "$l"; done <<<"$out"; gaps=1; fi
	if [ -d "$AGENT_DIR/npm/node_modules/${OPENSEC_FFF%@*}" ]; then ok "${OPENSEC_FFF%@*} installed"; else todo "${OPENSEC_FFF%@*} not installed"; gaps=1; fi
	if command -v pi-bolt >/dev/null; then
		status=$(pi-bolt compile --status 2>/dev/null | head -1)
		case "$status" in No\ extensions*) todo "no extensions compiled in (optional: scripts/pi-bolt-compile.sh)" ;; *) ok "${status:0:90}…" ;; esac
	fi
	[ "$gaps" -eq 0 ] && ok "ready: run pi-bolt (or pi; both work)" || todo "run: bash scripts/migrate-pi-bolt.sh"
	exit 0
fi

# --- undo -------------------------------------------------------------------
if [ "$mode" = undo ]; then
	step "Removing the Pi-Bolt-only settings"
	ok "$(settings_edit undo)"
	if command -v pi-bolt >/dev/null; then
		step "Turning the compiled build off"
		pi-bolt compile --off >/dev/null 2>&1 && ok "back to the release executable" || todo "nothing to turn off"
	fi
	ok "plain pi is unaffected. Pi-Bolt itself stays installed; to remove it, re-run its installer (it offers uninstall)"
	exit 0
fi

# --- apply ------------------------------------------------------------------
step "Pi-Bolt"
if command -v pi-bolt >/dev/null; then
	ok "pi-bolt $(pi-bolt --version)"
else
	command -v curl >/dev/null || die "curl is needed to run Pi-Bolt's installer"
	curl -fsSL https://pi-bolt.opensec.in/install.sh | PIBOLT_YES=1 PIBOLT_NO_START=1 PIBOLT_EXTENSIONS=no sh ||
		die "Pi-Bolt's installer failed (see its output above)"
	command -v pi-bolt >/dev/null || die "installed, but pi-bolt is not on PATH; add ~/.local/bin to PATH and re-run"
	ok "pi-bolt $(pi-bolt --version)"
fi

step "Plain pi (kept)"
if command -v pi >/dev/null; then
	ok "pi $(pi --version)"
else
	todo "no \`pi\` on PATH. This config still needs it beside Pi-Bolt: bun add -g @earendil-works/pi-coding-agent"
fi

step "settings.json"
ok "$(settings_edit apply)"

step "${OPENSEC_FFF%@*}"
if [ -d "$AGENT_DIR/npm/node_modules/${OPENSEC_FFF%@*}" ]; then
	ok "installed"
else
	command -v npm >/dev/null || die "npm is needed to install $OPENSEC_FFF"
	# Into pi's own package dir, as `pi install` would, but without its settings edit.
	(cd "$AGENT_DIR/npm" && npm install --no-audit --no-fund --ignore-scripts "$OPENSEC_FFF" >/dev/null) ||
		die "npm install $OPENSEC_FFF failed"
	ok "installed into $AGENT_DIR/npm"
fi

if [ "$compile" -eq 1 ]; then
	step "Compiling extensions into Pi-Bolt"
	if bash "$HERE/pi-bolt-compile.sh" >"${TMPDIR:-/tmp}/pi-bolt-compile.$$.log" 2>&1; then
		grep '^pi-bolt-compile' "${TMPDIR:-/tmp}/pi-bolt-compile.$$.log" | sed 's/^pi-bolt-compile: /  /'
	else
		grep '^pi-bolt-compile' "${TMPDIR:-/tmp}/pi-bolt-compile.$$.log" | sed 's/^pi-bolt-compile: /  /' >&2
		todo "compile failed (rolled back); Pi-Bolt still works with extensions loaded at run time. Retry: bash scripts/pi-bolt-compile.sh"
	fi
	rm -f "${TMPDIR:-/tmp}/pi-bolt-compile.$$.log"
fi

step "Done"
ok "run \`pi-bolt\` (inside herdr for the kanban board and subagents); \`pi\` keeps working as before"
ok "check any time: bash scripts/migrate-pi-bolt.sh --check"
