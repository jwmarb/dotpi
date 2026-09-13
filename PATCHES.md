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
