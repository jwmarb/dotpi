#!/usr/bin/env bash
#
# dotpi installer — turns a bare machine into a working pi config.
#
#   curl -fsSL https://raw.githubusercontent.com/jwmarb/dotpi/master/install.sh | bash
#
# Prefer downloading and reading it first; piping a script from the internet
# straight into a shell is a habit worth not having:
#
#   curl -fsSL https://raw.githubusercontent.com/jwmarb/dotpi/master/install.sh -o install.sh
#   less install.sh && bash install.sh
#
# What it does, in order:
#   1. checks bun, git and npm are present (and pi, installing it if absent)
#   2. clones the repo to ~/.pi, or to --dir with ~/.pi symlinked at it
#   3. arms the git hooks (core.hooksPath -> .githooks)
#   4. installs the one extension that has real npm dependencies
#   5. installs the firecrawl CLI, which the librarian agent researches with
#   5b. installs the agent-browser CLI, which the agent-browser skill drives
#   5b2. builds catimg from source into ~/.local/bin (startup-panel image)
#   5b3. builds chafa from source into ~/.local/bin (finer image styles)
#   5c. offers to install the herdr CLI, which the subagent tool delegates through
#   5d. adds ~/.bun/bin and ~/.local/bin to your shell rc PATH, when missing
#   6. copies agent/.env.example to agent/.env for you to fill in
#   7. asks whether to set up Pi-Bolt (the AOT-compiled pi) beside pi —
#      recommended; --yes or no terminal means plain pi — via
#      scripts/migrate-pi-bolt.sh; pi keeps working either way
#
# It never writes credentials. Step 6 leaves placeholders; you edit the file.
#
# Flags:
#   --dir <path>   clone here and symlink ~/.pi at it (default: clone to ~/.pi)
#   --ref <ref>    branch or tag to check out (default: master)
#   --yes          assume yes for the backup and herdr prompts (unattended installs);
#                  picks plain pi at the Pi-Bolt question
#   --no-pi        do not install pi even if it is missing
#   --pi-bolt      set up Pi-Bolt without asking (scripts/migrate-pi-bolt.sh);
#                  pi stays the fallback
#   --no-pi-bolt   plain pi only, without asking
#   --help
#
# Exit codes: 0 ok · 1 usage/precondition · 2 refused to touch an existing ~/.pi
set -uo pipefail

REPO_URL="${DOTPI_REPO:-https://github.com/jwmarb/dotpi.git}"
PI_HOME="$HOME/.pi"
CLONE_DIR=""
REF="master"
ASSUME_YES=0
INSTALL_PI=1
PI_BOLT=""
PI_BOLT_WHY=""

# ---------------------------------------------------------------------------
# Output. Colour only when stdout is a terminal, so a piped log stays readable.
# ---------------------------------------------------------------------------
if [ -t 1 ]; then
	B=$'\033[1m'; R=$'\033[0m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'
else
	B=""; R=""; RED=""; GRN=""; YLW=""; DIM=""
fi
step() { printf '%s==>%s %s\n' "$B" "$R" "$*"; }
ok()   { printf '  %s✓%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '  %s!%s %s\n' "$YLW" "$R" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$RED" "$R" "$*" >&2; exit "${2:-1}"; }

# The header block above, minus the `#` prefix. Stops at the "Exit codes" line so
# the `set -uo pipefail` that follows it never leaks into the help output.
usage() {
	sed -n '3,/^# Exit codes/p' "$0" | sed 's/^# \{0,1\}//'
	exit 0
}

while [ $# -gt 0 ]; do
	case "$1" in
		--dir)   CLONE_DIR="${2:-}"; [ -n "$CLONE_DIR" ] || die "--dir needs a path"; shift 2 ;;
		--ref)   REF="${2:-}";       [ -n "$REF" ]       || die "--ref needs a ref";  shift 2 ;;
		--yes|-y) ASSUME_YES=1; shift ;;
		--no-pi) INSTALL_PI=0; shift ;;
		--pi-bolt) [ "$PI_BOLT" = 0 ] && die "--pi-bolt and --no-pi-bolt: pick one"; PI_BOLT=1; PI_BOLT_WHY="--pi-bolt"; shift ;;
		--no-pi-bolt) [ "$PI_BOLT" = 1 ] && die "--pi-bolt and --no-pi-bolt: pick one"; PI_BOLT=0; PI_BOLT_WHY="--no-pi-bolt"; shift ;;
		--help|-h) usage ;;
		*) die "unknown argument: $1 (try --help)" ;;
	esac
done

# Expand a leading ~ in --dir: quoting it on the command line is common and
# would otherwise create a literal './~/...' directory.
# shellcheck disable=SC2088  # the ~ here is a pattern to match, not a path to expand
case "$CLONE_DIR" in "~"|"~/"*) CLONE_DIR="$HOME${CLONE_DIR#\~}" ;; esac

# ---------------------------------------------------------------------------
# Prompting. stdin is the SCRIPT when curl-piped, so a bare `read` consumes the
# script's own bytes instead of the user's answer. Read from the terminal
# directly, and treat "no terminal" as "no consent" rather than assuming yes.
# ---------------------------------------------------------------------------
confirm() {
	local prompt="$1" reply=""
	[ "$ASSUME_YES" -eq 1 ] && return 0
	# `[ -r /dev/tty ]` is not enough: the device node can be readable by mode while
	# still failing to open, which is exactly what happens with no controlling
	# terminal (a detached process, cron, some CI). Prove it opens, quietly.
	( : < /dev/tty ) 2>/dev/null || return 1
	printf '%s [y/N] ' "$prompt" > /dev/tty 2>/dev/null || return 1
	read -r reply < /dev/tty 2>/dev/null || return 1
	case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}
# Pi-Bolt is its own question, separate from the yes/no prompts above, so it
# carries a tri-state: "" = ask if we can, 1 = set it up, 0 = plain pi. The
# question is conservative: --yes and no terminal both pick plain pi, and a
# read that fails is no terminal, not a consent. Reads /dev/tty, never stdin,
# exactly like confirm() — stdin is the script's own bytes when curl-piped.
choose_pi_bolt() {
	# A flag already decided it; nothing to ask.
	[ -n "$PI_BOLT" ] && return 0
	[ "$ASSUME_YES" -eq 1 ] && { PI_BOLT=0; PI_BOLT_WHY="--yes"; return 0; }
	# /dev/tty must open, not merely exist (the same test confirm() uses).
	( : < /dev/tty ) 2>/dev/null || { PI_BOLT=0; PI_BOLT_WHY="no terminal"; return 0; }

	step "Choosing pi or Pi-Bolt"
	# The shared prompt block. Identical to install.ps1 apart from the command
	# slots and option 2: that file adds the pi-shim non-port note (AGENTS.md
	# NOTES) under 1; under 2 the rationale lines after the heading differ entirely,
	# four in install.ps1 to our three (there: the compile upstream refuses, so
	# extensions run interpreted, plus one runtime instead of two; here: the
	# re-compile loop and its command). The whole block including the already-
	# installed note is DIM-wrapped as one write, so a failed write means
	# no terminal, which means plain pi.
	{
		printf '%s' "$DIM"
		cat <<'PI_BOLT_PROMPT'
  Run pi alone, or Pi-Bolt beside it? pi stays installed either way, and
  both share ~/.pi/agent, so this choice is not permanent.

    1) Pi-Bolt (recommended) - pi compiled ahead of time: it starts faster,
       streams with less CPU and uses less memory.
    2) plain pi - pick this if you are editing the harness itself
       (agent/extensions, settings). Pi-Bolt compiles the extensions in, so
       an edited one runs from its source with a warning until you
       re-compile: bash scripts/pi-bolt-compile.sh

  Add Pi-Bolt later:  bash scripts/migrate-pi-bolt.sh
  Undo it later:      bash scripts/migrate-pi-bolt.sh --undo
PI_BOLT_PROMPT
		# Only when pi-bolt is already on PATH: option 2 never uninstalls it.
		if command -v pi-bolt >/dev/null 2>&1; then
			printf '  Pi-Bolt is already installed here; 2 leaves it as it is (no uninstall).\n'
		fi
		printf '%s' "$R"
	} > /dev/tty 2>/dev/null || { PI_BOLT=0; PI_BOLT_WHY="no terminal"; return 0; }

	local reply="" attempt=0
	while [ "$attempt" -lt 3 ]; do
		attempt=$((attempt + 1))
		printf '  Choice [1/2, Enter = 1]: ' > /dev/tty 2>/dev/null || { PI_BOLT=0; PI_BOLT_WHY="no terminal"; return 0; }
		read -r reply < /dev/tty 2>/dev/null || { PI_BOLT=0; PI_BOLT_WHY="no terminal"; return 0; }
		# Trim, then match case-insensitively.
		reply="${reply#"${reply%%[![:space:]]*}"}"
		reply="${reply%"${reply##*[![:space:]]}"}"
		reply="$(printf '%s' "$reply" | tr '[:upper:]' '[:lower:]')"
		case "$reply" in
			""|1|b|bolt|pi-bolt) PI_BOLT=1; PI_BOLT_WHY="chosen"; return 0 ;;
			2|p|pi) PI_BOLT=0; PI_BOLT_WHY="chosen"; return 0 ;;
		esac
		printf '  Please answer 1 or 2 (Enter = 1).\n' > /dev/tty 2>/dev/null || true
	done
	warn "no clear answer to the Pi-Bolt question; picking plain pi"
	PI_BOLT=0
	PI_BOLT_WHY="no clear answer"
	return 0
}

# ---------------------------------------------------------------------------
# 1. Preconditions
# ---------------------------------------------------------------------------
step "Checking prerequisites"

for cmd in git curl; do
	command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required but not on PATH"
done
ok "git, curl"

if ! command -v bun >/dev/null 2>&1; then
	die "bun is required but not on PATH.
    Install it:  curl -fsSL https://bun.sh/install | bash
    Then reopen your shell (or source ~/.bashrc) and re-run this script."
fi
ok "bun $(bun --version 2>/dev/null)"

if ! command -v npm >/dev/null 2>&1; then
	warn "npm not found. Only the dev-only typecheck deps need it (tsc);"
	warn "pi itself runs fine without them. Install Node.js, then: bash scripts/setup-deps.sh"
else
	ok "npm $(npm --version 2>/dev/null)"
fi

# pi must come from bun's global bin. An older @mariozechner/pi-coding-agent on
# PATH has no @earendil-works/* aliases, so every extension fails at startup
# with a misleading "Cannot find module '@earendil-works/pi-tui'".
if command -v pi >/dev/null 2>&1; then
	ok "pi $(pi --version 2>/dev/null) ($(command -v pi))"
	case "$(command -v pi)" in
		"$HOME/.bun/bin/pi") ;;
		*) warn "pi is not from ~/.bun/bin. If extensions fail to load at startup,"
		   warn "that is why — put ~/.bun/bin first on PATH." ;;
	esac
elif [ "$INSTALL_PI" -eq 1 ]; then
	step "Installing pi"
	bun install -g @earendil-works/pi-coding-agent \
		|| die "failed to install pi. Install it by hand, then re-run with --no-pi."
	command -v pi >/dev/null 2>&1 \
		|| warn "pi installed but not on PATH. Add ~/.bun/bin to PATH and reopen your shell."
	ok "pi installed"
else
	warn "pi is not installed and --no-pi was given; install it yourself before running pi"
fi

# ---------------------------------------------------------------------------
# 2. Decide where the clone goes
# ---------------------------------------------------------------------------
TARGET="${CLONE_DIR:-$PI_HOME}"

# An existing ~/.pi may be someone's real config, with the only copy of their
# sessions and credentials in it. Never clobber it silently.
handle_existing() {
	local path="$1" desc="$2"

	# Already this repo? Then this is an update, not an install.
	if [ -d "$path/.git" ] && git -C "$path" remote get-url origin 2>/dev/null | grep -qi 'dotpi'; then
		step "Existing dotpi clone at $desc — updating instead"
		git -C "$path" fetch --quiet origin || die "fetch failed"
		if [ -n "$(git -C "$path" status --porcelain 2>/dev/null)" ]; then
			warn "local changes present; leaving them alone and not switching refs"
			warn "run 'git -C $path pull' yourself once the tree is clean"
		else
			git -C "$path" checkout --quiet "$REF" 2>/dev/null || true
			git -C "$path" pull --quiet --ff-only origin "$REF" 2>/dev/null \
				|| warn "could not fast-forward; resolve by hand in $path"
			ok "updated to $(git -C "$path" rev-parse --short HEAD)"
		fi
		return 0
	fi

	# Something else lives here. Offer a timestamped backup; refuse otherwise.
	# Declared before assignment so `local` cannot mask the date(1) exit status.
	local backup
	backup="${path%/}.backup.$(date +%Y%m%d-%H%M%S)"
	printf '\n'
	warn "$desc already exists and is not a dotpi clone."
	printf '  %sIt would be moved to:%s %s\n\n' "$DIM" "$R" "$backup"
	if confirm "  Back it up and continue?"; then
		mv "$path" "$backup" || die "could not move $path"
		ok "moved to $backup"
		return 1
	fi
	printf '\n'
	die "refusing to touch $desc. Either move it yourself, or install elsewhere:
    curl -fsSL .../install.sh | bash -s -- --dir ~/src/dotpi

  (If you meant to accept the backup but saw no prompt, stdin is the script
   when curl-piped — re-run with --yes, or download the script and run it.)" 2
}

CLONED=0
if [ -e "$TARGET" ] || [ -L "$TARGET" ]; then
	if handle_existing "$TARGET" "$TARGET"; then
		CLONED=1   # updated in place; nothing to clone
	fi
fi

if [ "$CLONED" -eq 0 ]; then
	step "Cloning $REPO_URL"
	mkdir -p "$(dirname "$TARGET")" || die "cannot create parent of $TARGET"
	git clone --quiet --branch "$REF" "$REPO_URL" "$TARGET" \
		|| die "clone failed (is '$REF' a real branch?)"
	ok "cloned to $TARGET at $(git -C "$TARGET" rev-parse --short HEAD)"
fi

# ---------------------------------------------------------------------------
# 3. Symlink ~/.pi when the clone lives elsewhere
#
# pi resolves its agent dir as ~/.pi/agent, so that path has to exist even when
# the checkout is somewhere else. This is exactly the two-names-one-tree setup
# the repo's own AGENTS.md describes.
# ---------------------------------------------------------------------------
if [ "$TARGET" != "$PI_HOME" ]; then
	step "Pointing ~/.pi at $TARGET"
	if [ -L "$PI_HOME" ] && [ "$(readlink "$PI_HOME")" = "$TARGET" ]; then
		ok "symlink already correct"
	else
		if [ -e "$PI_HOME" ] || [ -L "$PI_HOME" ]; then
			# shellcheck disable=SC2088  # display string, not a path being expanded
			handle_existing "$PI_HOME" "~/.pi" >/dev/null || true
		fi
		ln -s "$TARGET" "$PI_HOME" || die "could not symlink ~/.pi -> $TARGET"
		# shellcheck disable=SC2088  # display string, not a path being expanded
		ok "~/.pi -> $TARGET"
	fi
fi

cd "$TARGET" || die "cannot enter $TARGET"

# ---------------------------------------------------------------------------
# 4. Arm the git hooks
#
# A hook in .git/hooks/ is not version controlled, so it does not exist on a
# fresh clone. Pointing core.hooksPath at the tracked directory is what makes
# the guard survive cloning. pi self-arms this at startup too; doing it here
# means the very first commit is covered.
# ---------------------------------------------------------------------------
step "Arming git hooks"
if git config core.hooksPath .githooks 2>/dev/null; then
	ok "core.hooksPath -> .githooks"
else
	warn "could not set core.hooksPath; run: git -C $TARGET config core.hooksPath .githooks"
fi

# ---------------------------------------------------------------------------
# 5. Extension dependencies
#
# node_modules/ is gitignored, so a fresh clone has extension sources without
# their dependencies. These are dev-only now (typescript for the typecheck
# scope): every extension loads without them.
# ---------------------------------------------------------------------------
step "Installing extension dependencies"
if [ -x scripts/setup-deps.sh ] || [ -f scripts/setup-deps.sh ]; then
	if bash scripts/setup-deps.sh; then
		ok "dependencies installed"
	else
		warn "dependency install reported a failure; re-run: bash scripts/setup-deps.sh"
	fi
else
	warn "scripts/setup-deps.sh missing — unexpected; skipping"
fi

# ---------------------------------------------------------------------------
# 5b. The firecrawl CLI
#
# The librarian agent researches by running `firecrawl`, so without this binary
# that agent launches and then cannot do its job. Optional on purpose: pi and
# every other agent work without it, and a global npm install is not something
# to force on someone who only wanted a pi config.
#
# npm, not bun: the package publishes a `firecrawl` bin that resolves through
# npm's global prefix, which is also where `npm ls -g` can see it again.
# ---------------------------------------------------------------------------
step "Installing the firecrawl CLI"
if command -v firecrawl >/dev/null 2>&1; then
	ok "firecrawl $(firecrawl --version 2>/dev/null | tail -1)"
elif ! command -v npm >/dev/null 2>&1; then
	warn "npm not found, so the firecrawl CLI was not installed."
	warn "The librarian agent needs it: install Node.js, then: npm install -g firecrawl-cli"
else
	if npm install -g firecrawl-cli >/dev/null 2>&1; then
		ok "firecrawl $(firecrawl --version 2>/dev/null | tail -1)"
	else
		# A global install can fail on a root-owned prefix, which is a
		# permissions problem to fix deliberately rather than with sudo here.
		warn "could not install firecrawl-cli (a global npm prefix often needs a permission fix)."
		warn "The librarian agent needs it; install it yourself: npm install -g firecrawl-cli"
	fi
fi

# ---------------------------------------------------------------------------
# 5c. The agent-browser CLI
#
# The agent-browser skill drives browser automation through this CLI, and the
# browser binary it downloads is the other half of the install. Optional on
# purpose, like the firecrawl CLI: pi and every other agent work without it,
# and a global npm install plus a browser download is not something to force
# on someone who only wanted a pi config.
#
# `agent-browser install` is idempotent — a no-op when the browser binary is
# already present — so it runs even when the CLI was already on PATH.
# ---------------------------------------------------------------------------
step "Installing the agent-browser CLI"
if command -v agent-browser >/dev/null 2>&1; then
	ok "agent-browser $(agent-browser --version 2>/dev/null | tail -1 | sed 's/^agent-browser[[:space:]]*//')"
elif ! command -v npm >/dev/null 2>&1; then
	warn "npm not found, so the agent-browser CLI was not installed."
	warn "The agent-browser skill needs it: install Node.js, then: npm i -g agent-browser"
else
	if npm install -g agent-browser >/dev/null 2>&1; then
		ok "agent-browser $(agent-browser --version 2>/dev/null | tail -1 | sed 's/^agent-browser[[:space:]]*//')"
	else
		# A global install can fail on a root-owned prefix, which is a
		# permissions problem to fix deliberately rather than with sudo here.
		warn "could not install agent-browser (a global npm prefix often needs a permission fix)."
		warn "The agent-browser skill needs it; install it yourself: npm i -g agent-browser"
	fi
fi

# The browser binary itself — the CLI is a hollow shell without it.
if command -v agent-browser >/dev/null 2>&1; then
	if agent-browser install >/dev/null 2>&1; then
		ok "browser binaries"
	else
		warn "could not download the browser binaries; run: agent-browser install"
	fi
fi

# ---------------------------------------------------------------------------
# 5b2. catimg, built from source
#
# startup-fetch.ts draws the startup-panel image with catimg (truecolor
# half-blocks). Optional: without it the panel shows the ASCII distro logo.
# Built from a pinned commit by scripts/install-catimg.sh into ~/.local/bin —
# no sudo, no distro package. Needs git, cmake and a C compiler; missing ones
# are a warning, never fatal.
# ---------------------------------------------------------------------------
step "Building catimg from source"
if ! command -v cmake >/dev/null 2>&1 || ! { command -v cc || command -v gcc || command -v clang; } >/dev/null 2>&1; then
	warn "cmake and a C compiler are needed to build catimg; skipped."
	warn "The startup panel falls back to ASCII art. Later: bash scripts/install-catimg.sh"
elif out=$(bash scripts/install-catimg.sh 2>&1); then
	ok "$(printf '%s' "$out" | tail -1)"
else
	warn "catimg build failed; the startup panel falls back to ASCII art."
	printf '%s\n' "$out" | tail -5 | sed 's/^/    /' >&2
	warn "retry: bash scripts/install-catimg.sh"
fi

# ---------------------------------------------------------------------------
# 5b3. chafa, built from source
#
# The finer startup-image styles (quad, sextant, octant, braille, ascii) use
# chafa; without it they fall back to catimg half blocks. Static build into
# ~/.local/bin by scripts/install-chafa.sh. Needs autotools and glib headers;
# missing ones are a warning, never fatal.
# ---------------------------------------------------------------------------
step "Building chafa from source"
if out=$(bash scripts/install-chafa.sh 2>&1); then
	ok "$(printf '%s' "$out" | tail -1)"
else
	warn "chafa not built; the quad/sextant/octant/braille styles fall back to half blocks."
	printf '%s\n' "$out" | tail -3 | sed 's/^/    /' >&2
	warn "retry: bash scripts/install-chafa.sh"
fi

# ---------------------------------------------------------------------------
# 5c. The herdr CLI
#
# The subagent/subagent_tasks tools delegate by opening a herdr tab and running
# pi inside it, so without this binary that entire surface is inert. Unlike the
# two optionals above it is NOT an npm package — `npm install -g herdr` fetches
# an unrelated 0.0.0 placeholder. The real distribution is a static binary from
# herdr.dev, whose installer checksum-verifies the download against the same
# manifest `herdr update` uses and drops it in ~/.local/bin.
#
# Prompted rather than automatic, because this pipes a third-party script into
# sh: --yes accepts it unattended, and no terminal means no consent, exactly as
# the backup prompt treats it. Missing herdr is a warning, never fatal.
# ---------------------------------------------------------------------------
HERDR_BIN=""
HERDR_URL="https://herdr.dev/install.sh"

# `herdr --version` prints "herdr 0.9.3"; keep just the number.
herdr_version() { "$1" --version 2>/dev/null | tail -1 | sed 's/^[Hh]erdr[[:space:]]*//'; }

step "Installing the herdr CLI"
if command -v herdr >/dev/null 2>&1; then
	HERDR_BIN="$(command -v herdr)"
	ok "herdr $(herdr_version herdr)"
elif [ -x "$HOME/.local/bin/herdr" ]; then
	# Present, but this shell's PATH predates it. Step 5d writes the export.
	HERDR_BIN="$HOME/.local/bin/herdr"
	ok "herdr $(herdr_version "$HERDR_BIN") (in ~/.local/bin, not yet on this PATH)"
else
	printf '\n'
	printf '  %sThe subagent tool spawns every child agent in a herdr tab, so without%s\n' "$DIM" "$R"
	printf '  %sherdr that one tool cannot run. pi and every skill work without it.%s\n' "$DIM" "$R"
	printf '  %sThis runs:%s curl -fsSL %s | sh\n' "$DIM" "$R" "$HERDR_URL"
	printf '  %swhich verifies a checksum and installs into ~/.local/bin.%s\n\n' "$DIM" "$R"
	if confirm "  Install herdr now?"; then
		if curl -fsSL "$HERDR_URL" | sh >/dev/null 2>&1; then
			# Resolve by path too: the installer just created a binary in a
			# directory that may not be on this process's PATH yet.
			if command -v herdr >/dev/null 2>&1; then
				HERDR_BIN="$(command -v herdr)"
			elif [ -x "$HOME/.local/bin/herdr" ]; then
				HERDR_BIN="$HOME/.local/bin/herdr"
			fi
			if [ -n "$HERDR_BIN" ]; then
				ok "herdr $(herdr_version "$HERDR_BIN")"
			else
				warn "the herdr installer exited 0 but no binary turned up; install it by hand"
			fi
		else
			warn "could not install herdr. Install it yourself:"
			warn "  curl -fsSL $HERDR_URL | sh"
			warn "  (or: brew install herdr · mise use -g herdr)"
		fi
	else
		# Also the no-terminal path: confirm() treats "cannot ask" as "no".
		warn "skipping herdr; the subagent tool stays unavailable until you install it:"
		warn "  curl -fsSL $HERDR_URL | sh      (or re-run with --yes)"
	fi
fi

# ---------------------------------------------------------------------------
# 5d. PATH entries in the shell rc file
#
# Two binaries this script depends on land in directories a fresh machine often
# has not got on PATH: pi in ~/.bun/bin and herdr in ~/.local/bin. herdr's
# installer only *prints* the export line it needs, and bun's only patches the
# rc that existed when bun was installed — which is why "installed, but the
# shell cannot find it" is the most common thing left broken after an install.
#
# Idempotent, and deliberately matched on the directory suffix rather than the
# exact text we would write: an entry already in the file as
# /home/you/.bun/bin, ~/.bun/bin or $HOME/.bun/bin all name the same directory,
# and only a suffix match recognises all three instead of adding a duplicate.
# ---------------------------------------------------------------------------
step "Checking shell PATH"

# $SHELL is the user's login shell — the one that will actually read this file
# in the next terminal. It is not necessarily the shell running this script,
# which is bash whenever this was curl-piped into bash.
SHELL_RC=""
case "${SHELL:-}" in
	*/zsh)  SHELL_RC="${ZDOTDIR:-$HOME}/.zshrc" ;;
	*/bash) SHELL_RC="$HOME/.bashrc" ;;
	*)
		# Unknown or unset $SHELL: fall back to an rc that already exists.
		if   [ -f "$HOME/.zshrc" ];  then SHELL_RC="$HOME/.zshrc"
		elif [ -f "$HOME/.bashrc" ]; then SHELL_RC="$HOME/.bashrc"
		fi ;;
esac

PATH_LINES_ADDED=0
RC_DISPLAY=""

# Append one export, unless some form of that directory is already on PATH there.
ensure_path_line() {
	local rel="$1"
	# Require the line to mention PATH as well as the directory, and ignore
	# comments: a stray `# see ~/.local/bin/herdr` is not a PATH entry, and
	# treating it as one would silently leave PATH unset.
	if grep -v '^[[:space:]]*#' "$SHELL_RC" 2>/dev/null | grep -F "$rel" | grep -q 'PATH'; then
		ok "~/$rel already in $RC_DISPLAY"
		return 0
	fi
	# A final line with no trailing newline would otherwise get our export
	# glued onto the end of it, producing one broken line instead of two.
	if [ -s "$SHELL_RC" ] && [ -n "$(tail -c 1 "$SHELL_RC" 2>/dev/null)" ]; then
		printf '\n' >> "$SHELL_RC" 2>/dev/null || true
	fi
	# One header for the block, before the first line we add.
	if [ "$PATH_LINES_ADDED" -eq 0 ]; then
		printf '\n# added by dotpi install.sh\n' >> "$SHELL_RC" 2>/dev/null || true
	fi
	# $HOME stays unexpanded in the file, so the line survives being copied
	# to another account.
	if printf 'export PATH="$HOME/%s:$PATH"\n' "$rel" >> "$SHELL_RC" 2>/dev/null; then
		PATH_LINES_ADDED=$((PATH_LINES_ADDED + 1))
		ok "added ~/$rel to $RC_DISPLAY"
	else
		warn "could not write $RC_DISPLAY; add by hand:"
		warn "  export PATH=\"\$HOME/$rel:\$PATH\""
	fi
}

if [ -z "$SHELL_RC" ]; then
	warn "could not tell which shell rc to use (SHELL='${SHELL:-unset}'); add these by hand:"
	warn '  export PATH="$HOME/.bun/bin:$PATH"'
	warn '  export PATH="$HOME/.local/bin:$PATH"'
else
	# The ~ must be quoted: unquoted it is tilde-expanded back to $HOME, which
	# would substitute $HOME for $HOME and print the full path instead.
	RC_DISPLAY="${SHELL_RC/#$HOME/"~"}"
	if [ ! -f "$SHELL_RC" ] && ! touch "$SHELL_RC" 2>/dev/null; then
		warn "could not create $RC_DISPLAY; add the two PATH exports by hand"
	else
		# bun's bin first in the file, so ~/.local/bin ends up ahead of it on
		# PATH — each line prepends, so the last one written wins.
		ensure_path_line ".bun/bin"
		ensure_path_line ".local/bin"
	fi
fi

# ---------------------------------------------------------------------------
# 6. Credentials
#
# The template only. Writing real keys is the user's job: a script that prompts
# for secrets puts them in shell history and process listings, and this one is
# often run piped from curl where stdin is not even the user.
# ---------------------------------------------------------------------------
step "Setting up credentials"
ENV_WAS_CREATED=0
if [ -f agent/.env ]; then
	ok "agent/.env already exists — left untouched"
elif [ -f agent/.env.example ]; then
	cp agent/.env.example agent/.env || die "could not create agent/.env"
	chmod 600 agent/.env 2>/dev/null || true
	ENV_WAS_CREATED=1
	ok "created agent/.env from the template (placeholders, mode 600)"
else
	warn "agent/.env.example missing — create agent/.env by hand"
fi

# ---------------------------------------------------------------------------
# 7. Pi-Bolt (asked; --pi-bolt / --no-pi-bolt / --yes decide unattended)
#
# Pi-Bolt installs beside pi and shares agent/, so this only adds: the
# binary, two Pi-Bolt-only settings entries, opensec-pi-fff, and a compiled
# build - the general case, not a guarantee: upstream refuses the compile on
# win32, and refuses npm/brew-managed installs everywhere (see the --status
# gate in scripts/pi-bolt-compile.sh). Never fatal: a failure leaves pi
# working as before, and scripts/migrate-pi-bolt.sh --undo restores
# settings.json. The .ps1 twin says why its compile is skipped.
# ---------------------------------------------------------------------------
PI_BOLT_OK=0
PI_BOLT_FAILED=0
if [ ! -f scripts/migrate-pi-bolt.sh ]; then
	[ "$PI_BOLT" = 1 ] && warn "this ref has no scripts/migrate-pi-bolt.sh; Pi-Bolt skipped"
	PI_BOLT=0
	PI_BOLT_WHY="no migrate script at this ref"
else
	choose_pi_bolt
	if [ "$PI_BOLT" = 1 ]; then
		step "Setting up Pi-Bolt"
		if bash scripts/migrate-pi-bolt.sh; then
			PI_BOLT_OK=1
			ok "Pi-Bolt ready: run pi-bolt (pi still works)"
		else
			PI_BOLT_FAILED=1
			warn "Pi-Bolt setup did not finish; pi is unaffected. Retry: bash scripts/migrate-pi-bolt.sh"
		fi
	else
		ok "plain pi ($PI_BOLT_WHY)"
	fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
printf '\n%sInstalled.%s  %s\n\n' "$GRN$B" "$R" "$TARGET"

if [ "$ENV_WAS_CREATED" -eq 1 ]; then
	printf '%sOne step left — pi will not reach a model until you do it.%s\n' "$B" "$R"
	printf 'Fill in the two LITELLM_* values:\n\n'
	# shellcheck disable=SC2016  # $EDITOR is shown to the user, not expanded here
	printf '    %s${EDITOR:-nano} %s/agent/.env%s\n\n' "$DIM" "$TARGET" "$R"
	printf '  LITELLM_API_KEY    provider key   (Authorization: Bearer <key>)\n'
	printf '  LITELLM_BASE_URL   provider URL\n\n'
	printf '%sOptional — the librarian agent researches through this:%s\n' "$B" "$R"
	printf '  FIRECRAWL_API_URL  your Firecrawl endpoint, e.g. http://firecrawl.lan:3002\n'
	printf '  %sNo API key: a self-hosted URL makes the CLI skip key validation.%s\n\n' "$DIM" "$R"
fi

# A PATH line only takes effect in a *new* shell, so without this the user is
# told to run a command their current shell still cannot resolve.
if [ "$PATH_LINES_ADDED" -gt 0 ]; then
	printf '%sPATH updated in %s — reload it before running pi:%s\n\n' "$B" "$RC_DISPLAY" "$R"
	printf '    source %s\n' "$RC_DISPLAY"
	printf '  %sor just open a new terminal.%s\n\n' "$DIM" "$R"
fi

if [ "$PI_BOLT_OK" = 1 ]; then
	printf 'Then start it:\n\n    pi-bolt      %s# or pi; both share this config%s\n\n' "$DIM" "$R"
else
	printf 'Then start it:\n\n    pi\n\n'
	if [ "$PI_BOLT_FAILED" = 1 ]; then
		printf '%sPi-Bolt setup did not finish; pi is unaffected. Retry: bash scripts/migrate-pi-bolt.sh%s\n\n' "$DIM" "$R"
	elif command -v pi-bolt >/dev/null 2>&1; then
		printf '%sPi-Bolt was already installed and this run left it as it is (%s); run pi-bolt any time.%s\n\n' "$DIM" "$PI_BOLT_WHY" "$R"
	else
		printf '%sPi-Bolt not set up (%s). Add it any time: bash scripts/migrate-pi-bolt.sh%s\n\n' "$DIM" "$PI_BOLT_WHY" "$R"
	fi
fi
printf '%sVerify it works:%s\n' "$B" "$R"
printf '    pi /mcp            %s# are the MCP servers reachable with your keys?%s\n' "$DIM" "$R"
printf '    pi /sessions       %s# extensions loaded (this one is an extension)%s\n\n' "$DIM" "$R"
# Deliberately not suggesting `bun test` here. The suites resolve the packages pi
# injects (@earendil-works/pi-tui, typebox) by walking UP to a node_modules above
# the checkout — which exists on the author's machine but is NOT created by
# installing pi. Telling a new user to run them would hand them a confusing
# "Cannot find module" on a correct install. See the repo AGENTS.md COMMANDS note.
printf '%sIf pi starts and /mcp shows its servers connected, the install is good.%s\n' "$DIM" "$R"
printf '%sExtension load errors surface at startup, not later.%s\n\n' "$DIM" "$R"
