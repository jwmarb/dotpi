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
#   6. copies agent/.env.example to agent/.env for you to fill in
#
# It never writes credentials. Step 6 leaves placeholders; you edit the file.
#
# Flags:
#   --dir <path>   clone here and symlink ~/.pi at it (default: clone to ~/.pi)
#   --ref <ref>    branch or tag to check out (default: master)
#   --yes          assume yes for the backup prompt (for unattended installs)
#   --no-pi        do not install pi even if it is missing
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
# Done
# ---------------------------------------------------------------------------
printf '\n%sInstalled.%s  %s\n\n' "$GRN$B" "$R" "$TARGET"

if [ "$ENV_WAS_CREATED" -eq 1 ]; then
	printf '%sOne step left — pi will not reach a model until you do it.%s\n' "$B" "$R"
	printf 'Fill in the four LITELLM_* values:\n\n'
	# shellcheck disable=SC2016  # $EDITOR is shown to the user, not expanded here
	printf '    %s${EDITOR:-nano} %s/agent/.env%s\n\n' "$DIM" "$TARGET" "$R"
	printf '  LITELLM_API_KEY    provider key   (Authorization: Bearer <key>)\n'
	printf '  LITELLM_BASE_URL   provider URL\n'
	printf '  LITELLM_MCP_KEY    gateway key    (x-litellm-api-key header)\n'
	printf '  LITELLM_MCP_URL    gateway URL\n\n'
	printf '  %sMCP_KEY and API_KEY are different credentials, not the same value twice.%s\n\n' "$DIM" "$R"
	printf '%sOptional — the librarian agent researches through this:%s\n' "$B" "$R"
	printf '  FIRECRAWL_API_URL  your Firecrawl endpoint, e.g. http://firecrawl.lan:3002\n'
	printf '  %sNo API key: a self-hosted URL makes the CLI skip key validation.%s\n\n' "$DIM" "$R"
fi

printf 'Then start it:\n\n    pi\n\n'
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
