#!/usr/bin/env bash
# Static dispatcher for the pi-subagents herdr plugin (ADR 0044).
#
# WHY IT IS STATIC: herdr's plugin API has no command-override field — an
# entrypoint is a fixed argv declared in the manifest (see the comment on the
# [[panes]] block in herdr-plugin.toml). Per-Run variation therefore rides on
# --env: the subagent extension generates a per-Run wrapper script and passes
# its absolute path in PI_RUN_WRAPPER. This script execs exactly that wrapper.
# The alternative — typing a command into an interactive shell via
# `herdr pane split` + `pane run` — races against shell init (direnv, devenv)
# and is lost ~100% of the time when init is slow. No typing, no race.
set -u

if [ -z "${PI_RUN_WRAPPER:-}" ]; then
  echo "pi-subagents dispatch: PI_RUN_WRAPPER is not set." >&2
  echo "pi-subagents dispatch: a subagent Run must pass the absolute path of its" >&2
  echo "pi-subagents dispatch: generated wrapper script via --env PI_RUN_WRAPPER=<abs path>." >&2
  exit 64
fi

if [ ! -r "$PI_RUN_WRAPPER" ]; then
  echo "pi-subagents dispatch: PI_RUN_WRAPPER is not a readable file: $PI_RUN_WRAPPER" >&2
  exit 66
fi

exec bash "$PI_RUN_WRAPPER"
