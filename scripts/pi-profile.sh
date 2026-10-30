#!/usr/bin/env bash
#
# Profile launcher for this repo. Defines pi-p / pi-quant / pi-bolt-p, which run
# a pi profile (an agent directory under ~/.pi/) under either the bun `pi` or the
# Pi-Bolt executable. This file is SOURCED from ~/.bashrc, not executed, so it
# only defines functions and sets no shell options of its own:
#
#     pi-p <profile> [args...]      # run a profile under the bun pi
#     pi-quant [args...]            # the quant-trader profile
#     pi-bolt-p <profile> [args...] # the same, under the Pi-Bolt executable
#
# Why an env var, not a flag: the agent directory is relocated by
# PI_CODING_AGENT_DIR, which BOTH the bun `pi` and the Pi-Bolt executable read.
# Verified with `strings` / source: pi-bolt embeds the name (12 hits in the
# binary), and the bun `pi` builds it at runtime as ${APP_NAME}_CODING_AGENT_DIR
# (= PI_CODING_AGENT_DIR) in dist/config.js, then reads process.env[that] in
# getAgentDir(). Pi-Bolt's embedded help text shows a `--agent-dir` flag, but
# `--help` at version 1.4.0 does not expose it, and the bun `pi` has no such flag
# at all — so the env var is the only mechanism that works on both binaries.
#
# [ -e ] not [ -d ] so a symlinked profile (orchestrator -> agent) passes the
# guard: a symlink pointing at a directory is not itself a directory. Bare `pi`
# and bare `pi-bolt` deliberately stay the default orchestrator (~/.pi/agent)
# and need no launcher.
#
# The profile argument is guarded before it is trusted:
# - `local p="${1-}"` + the emptiness test BEFORE `shift`: a bare `pi-p` must not
#   die on `$1` under `set -u` (unbound variable), and `shift` with `$#=0`
#   returns 1, which would kill a non-interactive `set -e` shell before any
#   message is shown.
# - `case` rejects `*/`- and `.`-leading arguments: `pi-p ..` passes [ -e ] and
#   would set PI_CODING_AGENT_DIR to $HOME, where pi writes auth.json,
#   sessions/ and cache/; `pi-p agent/skills` does the same inside a skills dir.
#   A profile name is a bare path segment.
# - [ -f "$d/settings.json" ] rejects an existing directory that is not a
#   profile: without it, any folder under ~/.pi/ becomes a launch target.
# The launcher exports PI_MODEL_FALLBACK_LEASE_DIR to
# ~/.pi/agent/cache/model-fallback-leases for every launched profile: the
# model-fallback concurrency lease dir defaults to `cache/model-fallback-leases`
# UNDER THE PROFILE'S OWN agent dir (agent/extensions/model-fallback/
# concurrency.ts, LEASE_DIR_ENV), so two profiles running at once would enforce
# two separate per-model caps and can exceed the gateway limit. One shared dir
# means one machine-wide cap, whatever profile the session lives in.
# The launch binary is _PI_PROFILE_BIN, a private name: a stray exported
# PI_LAUNCH_BIN in the user's environment must not silently redirect every
# profile launch.
_pi_p_usage() {
  echo "usage: pi-p <profile> [args...]" >&2
}
pi-p() {
  local p="${1-}"
  [ -n "$p" ] || { _pi_p_usage; return 2; }
  shift
  local d="$HOME/.pi/$p"
  case "$p" in */*|.*) echo "pi-p: bad profile: $p" >&2; return 2;; esac
  [ -e "$d" ] || { echo "pi-p: no profile: $p" >&2; return 1; }
  [ -f "$d/settings.json" ] || { echo "pi-p: not a profile (no settings.json): $p" >&2; return 1; }
  PI_CODING_AGENT_DIR="$d" \
  PI_MODEL_FALLBACK_LEASE_DIR="$HOME/.pi/agent/cache/model-fallback-leases" \
  "${_PI_PROFILE_BIN:-$HOME/.bun/bin/pi}" "$@"
}
pi-quant()   { pi-p quant-trader "$@"; }
pi-bolt-p()  { _PI_PROFILE_BIN="$HOME/.local/bin/pi-bolt" pi-p "$@"; }
