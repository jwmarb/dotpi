# Local patches to the installed pi package

**After every `pi` update, run:**

```sh
./scripts/patch-pi.sh
```

Then **restart pi** — the patched code is loaded once at startup.

## Why

`pi` is patched in two places in `node_modules`. A `pi` update overwrites them
silently, and the first symptom is **chat dying permanently mid-session**: the
gateway returns an HTTP 400 that pi treats as a permanent error, so it stops
instead of retrying, with no message explaining why.

| Patch | Without it |
|---|---|
| `"upstream request failed"` added to the retryable-error list | A litellm gateway blip (HTTP 400) ends the session for good — no retry |
| Retry ladder capped at `retry.maxDelayMs` | 10 retries reach 8.5- and 17-minute waits; 34 min worst case instead of 10.6 |

Neither is reachable from an extension: no pi hook can influence retry
classification. See [docs/adr/0034](./docs/adr/0034-local-pi-patches.md) for the
full reasoning, the rejected alternatives, and the trap that cost an evening —
the file that *looks* like the right target (`pi-ai/dist/utils/retry.js`) is
never loaded, because the pattern is inlined into a bundled chunk.

`scripts/patch-pi.sh` is safe to run repeatedly: it skips patches already
present, finds the chunk by content rather than by its per-release hash, and
**exits non-zero** if an anchor no longer matches — that means upstream changed
the code and the ADR needs revisiting.

## Native subagent Runs require a linked herdr plugin

**Run once, separately from the patches above:**

```sh
herdr plugin link ./herdr-plugin
```

`herdr plugin list` should then show `pi-subagents`; remove it with
`herdr plugin unlink pi-subagents`.

Why: a Run is now a native `pi` TUI that herdr spawns into its own pane, and
the launch must not type a command into an interactive shell — it goes through
the plugin's static argv entrypoint with the per-Run wrapper passed via
`--env PI_RUN_WRAPPER`. Without the link, native Runs cannot be launched at
all (the JSON spawn path remains the fallback when herdr is absent). See
[herdr-plugin/README.md](./herdr-plugin/README.md) for the contract and the
two hard-won pane-lifecycle facts, and
[docs/adr/0044](./docs/adr/0044-native-runs-herdr-owns-the-process.md) for the
reasoning.
