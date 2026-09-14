# herdr-plugin: pi-subagents

A [herdr](https://herdr.dev) 0.9.0 plugin that gives the subagent extension a
no-typing launch surface: `herdr plugin pane open` starts an arbitrary argv
process (a native `pi` TUI) in a new pane, with per-Run environment variables.
This is the launch mechanism decided in
[ADR 0044](../docs/adr/0044-native-runs-herdr-owns-the-process.md) — a Run is a
native `pi` session owned by herdr, and the launch must not go through an
interactive shell (a typed command races shell init and is lost).

## Setup

One command:

```sh
herdr plugin link $HOME/.pi/herdr-plugin
```

`herdr plugin list` should then show `pi-subagents`.

To remove it:

```sh
herdr plugin unlink pi-subagents
```

(Unlinking only unregisters the plugin; the files in this directory are left
alone.)

## Contract

- One pane entrypoint: `run`.
- The launching side must pass `--env PI_RUN_WRAPPER=<abs path>` where the
  value is an absolute path to a **readable bash script** (the per-Run wrapper
  the extension generated).
- The manifest's entrypoint command execs `dispatch.sh` from the plugin root
  (herdr injects `$HERDR_PLUGIN_ROOT`); the dispatcher execs the script named
  by `PI_RUN_WRAPPER`.
- Per-Run variation rides **entirely** on `--env`: the herdr plugin API has no
  command-override field, so the entrypoint argv is static and every Run must
  fit inside one argv + a varying environment.

Example launch (what the extension will do):

```sh
herdr plugin pane open \
  --plugin pi-subagents --entrypoint run \
  --placement split --target-pane "$HERDR_PANE_ID" --direction right \
  --cwd "$run_dir" \
  --env PI_RUN_WRAPPER=/abs/path/to/wrapper.sh \
  --env PI_PLAN_KEY=... --env ... \
  --no-focus
```

Failure modes of the dispatcher: `PI_RUN_WRAPPER` unset/empty → diagnostic on
stderr, exit 64; not a readable file → diagnostic on stderr, exit 66.

## Two facts a maintainer must know

Both were verified live against herdr 0.9.0 (see the "Verified mechanism"
section of ADR 0044):

1. **Herdr auto-closes the pane the instant the process exits** — for clean
   *and* failing exits alike. The pane then vanishes from `pane list` and
   `pane read` returns `pane_not_found`, so **scrollback dies with the
   process**. "Hold the pane open on failure" therefore cannot be asked of
   herdr: the *wrapper itself* must hold itself open on a non-zero exit
   (a `read -r` guard is the shape the reference implementation uses). That
   guard is the only thing standing between a failed Run and the total loss
   of its evidence.

2. **The launched child inherits the herdr *server's* environment, not the
   requesting pane's.** Nothing is inherited from the orchestrator by
   accident: every variable a Run needs (`PI_PLAN_KEY` included) must be
   passed explicitly via `--env`.
