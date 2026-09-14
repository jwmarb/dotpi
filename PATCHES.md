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
| `setHiddenThinkingLabel` scoped to one message | "Thought for 12s" is stamped onto *every* assistant turn in the transcript, not the one it measured |

None of these is reachable from an extension. The first two: no pi hook can
influence retry classification. The third: the label setter fans out to every
`AssistantMessageComponent` in the chat container, and an extension can only
hand it a string — it cannot choose a target. See
[docs/adr/0034](./docs/adr/0034-local-pi-patches.md) for the full reasoning, the
rejected alternatives, and the trap that cost an evening — the file that *looks*
like the right target (`pi-ai/dist/utils/retry.js`) is never loaded, because the
pattern is inlined into a bundled chunk.

The thinking-label patch keeps the no-argument call — which pi itself makes on
`/reload` — behaving exactly as before, resetting every component to the default
`"Thinking..."`. Only a call *with* a label is narrowed, and it deliberately does
not persist into `hiddenThinkingLabel`, since that field seeds newly created
components and would make the next turn open already labelled with the previous
turn's duration. `agent/extensions/thinking-indicator.ts` is the consumer.

`scripts/patch-pi.sh` is safe to run repeatedly: it skips patches already
present, finds the chunk by content rather than by its per-release hash, and
**exits non-zero** if an anchor no longer matches — that means upstream changed
the code and the ADR needs revisiting.

## Verifying the thinking-label patch

The two retry patches are verified by the snippet the script prints. The
thinking-label patch has a behavioural check:

```sh
node scripts/check-thinking-label-patch.mjs
```

It extracts the patched setter out of the installed bundle and exercises it, so
it tests what is actually installed rather than a copy that can drift. It prints
`UNPATCHED` and exits 0 when the patch is absent (patch 3 is cosmetic and
optional), and exits non-zero when the installed behaviour is wrong — including
the case where a future patch carries the right marker but still broadcasts.

## The pre-commit hook arms itself on pi startup

`agent/extensions/git-hooks.ts` points the clone at the tracked hook on every
pi startup: if `core.hooksPath` is unset it runs
`git config --local core.hooksPath .githooks`, so a fresh clone is guarded
from its first commit with no manual step. If `core.hooksPath` is set to
something else, pi shows a warning instead of overwriting the choice.

For a shell that never goes through pi, run it by hand:

```sh
git config core.hooksPath .githooks
```

`git config core.hooksPath` should then print `.githooks`.

Why: `.githooks/pre-commit` runs `scripts/check.sh` with `CHECK_STAGED=1`,
which materialises the git index — what the commit will record, not the
working tree — loads every module under `agent/extensions/` in it and runs
the tests, refusing a commit whose sources cannot even parse. A file that
fails to load takes pi's startup with it, which is how a `ParseError` once
greeted a restart. The hook checks the index, not the working tree, so a
partially staged file cannot pass here and ship broken. Run
`./scripts/check.sh` by hand to verify anything at any time.

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
