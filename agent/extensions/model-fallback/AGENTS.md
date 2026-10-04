# agent/extensions/model-fallback — the error-to-next-model router

Registers **`fallback/auto`**, a virtual model that walks a chain of real models.
An error moves work to the *next* model instead of re-asking the one that just
failed; once a fallback answers, the **original model gets the next request**.

| File | Owns |
|---|---|
| `lib.ts` | The state machine and every message. Pure, pi-free, 155 tests |
| `index.ts` | Session wiring: `registerVirtualModel`, `/fallback-chain`, the footer notice |
| `settings.ts` | Load-time `settings.json` read — `pi.getSettings()` throws during extension load |

## HOW IT IS TURNED ON HERE

`agent/settings.json`:

```json
"defaultProvider": "fallback",
"defaultModel": "auto",
"retry": { "maxRetries": 30, ... },
"modelFallback": {
  "chain": ["qwen/qwen3.8-27b", "anthropic/claude-opus-5", "openai/gpt-5.6-sol"],
  "maxCycles": 10, "maxProbes": 2,
  "contextWindow": 262144, "maxTokens": 32768
}
```

**`defaultModel` is the bare model id, not `provider/id`.** pi looks the default up as
`getModel(defaultProvider, defaultModelId)` (`core/model-resolver.js`, step 3), so
`"defaultModel": "fallback/auto"` silently misses and pi falls through to "first available
model" — measured: it selected `litellm/anthropic/claude-sonnet-5` and the chain was never
consulted, with no error anywhere. `--model fallback/auto` *does* take the slashed form,
because the CLI flag goes through `findExactModelReferenceMatch` instead. Two different
grammars for the same thing, so check `/model` or the session's `model_change` entry after
changing either.

`retry.maxRetries` is 30 rather than 10 because a lap of a 3-model chain spends 3 of pi's
retries, and 10 cycles therefore needs 30 (see THE TWO BUDGETS). With 10 only 3 cycles were
reachable and `/fallback-chain` warned about it.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| What model answers the next request | `lib.ts` `advance()` — the whole decision, by `reason` |
| Why a lap costs one retry and not L | `lib.ts` module docstring, "The two budgets" |
| Why the exhaustion message reads oddly flat | `lib.ts` `sanitizeProviderError` — pi retries on a *regex over the error text* |
| How a subagent gets a chain | `subagent-herdr/lib.ts` `childFallbackChain` → `PI_FALLBACK_CHAIN` → here |
| How a ralph-loop gate gets one | `ralph-loop/gate.ts` `resolveGateAgent` + `withChainEnv` (same env var; `pi.exec()` has no `env` option) |
| How to configure it | `settings.json` `modelFallback.chain`, then select `fallback/auto` |
| Whether it is on | `/fallback-chain` — lists the chain, marks unavailable entries, prints the budget |

## THE MECHANISM, AND WHY IT IS THIS ONE

pi calls a virtual model's `route(request, ctx)` **before every request** and
tells it why: `user`, `continuation`, `retry`, or `direct`. On a `retry` it also
passes `request.failed` — the model that failed and its `errorMessage`. That is
the only documented seam in pi that both runs before each request and gets to
name the model, so routing is not a clever use of this API, it **is** the API for
this feature.

The alternative was ruled out by reading pi's source: `retry` is decided inside
`AgentSession._prepareRetry` (`core/agent-session.js`) and the model is resolved
below it. **No extension event can change the model of a retry** — `before_agent_start`
fires once per run, not per request, and there is no retry event at all.

## SUBAGENTS, AND THE TRAP WHEN TESTING THEM

A child gets its chain from `PI_FALLBACK_CHAIN`, which `subagent-herdr` sets from the
agent's `fallback_models`; it then launches on `--model fallback/auto` instead of one
model. All 9 agent files declare fallbacks, so all 9 compose a chain — verified by
composing the real spawn inputs from the real files and asserting that the chain starts at
each agent's declared `model`, that the `--model` flag and the env agree, that the
handshake vars survive, and that a pinned `model` suppresses the chain for every one.

**A running pi holds the extension code it started with.** Delegating from a session that
started before `subagent-herdr/index.ts` changed spawns a child with the *old* launcher: it
received no chain, ran on plain `qwen/qwen3.8-27b`, and burned 7 retries on the dead model
— which looks exactly like the feature not working. The tell is `meta.json`:
`fallbackChain` is absent for a child the new launcher did not spawn. Use `/reload`, or a
fresh `pi`, before concluding anything about a delegated run.

The child path was proven by executing the exact argv and env `spawnRun` composes
(`--session-dir`, `--session-id`, `--append-system-prompt`, `--model fallback/auto`, the
`PI_SUBAGENT_*` vars and `PI_FALLBACK_CHAIN`) directly: primary errored, the fallback
answered, the next request went back to the primary, task completed.

## MEASURED BEHAVIOUR

Everything below was produced by running pi 1.0.2, not inferred. The harness used
a provider whose `baseUrl` is `http://127.0.0.1:1/v1` (connection refused on every
request), so the primary fails deterministically.

A session transcript (`agent/sessions/*/*.jsonl`) with chain
`[deadend/void, anthropic/claude-haiku-4.5]`:

```
model_change                      provider=fallback modelId=auto
ASSISTANT deadend/void            stopReason=error    "Connection error."
  state {"index":1,...,"home":0,"probing":false}   <- hopped to the fallback
ASSISTANT litellm/…/haiku-4.5     stopReason=toolUse  <- the fallback answered
  state {"index":0,...,"home":0,"probing":true}    <- handed BACK to the primary
ASSISTANT deadend/void            stopReason=error
  state {"index":1,...,"probes":1}                 <- a failed probe
ASSISTANT litellm/…/haiku-4.5     stopReason=stop     <- task completed
```

Four facts this pins, each of which was an open question first:

1. `--model fallback/auto` **resolves**, even though the flag is parsed before
   extensions load: `registerVirtualModel` is one of the calls pi *queues* during
   extension load (`core/extensions/loader.js` `pendingVirtualModelRegistrations`).
2. `reason: "retry"` arrives with `failed.model` and `failed.message.errorMessage`
   populated.
3. The request after a fallback's answer is a `continuation`, and routing it to
   the primary works — the "try the original model against the new response" half.
4. Router state survives as a `pi.virtual-model-state` custom entry, so it follows
   forks and survives compaction.

**Probe migration**, from a five-tool-call task on the same chain: `home` moved to
index 1 after 2 failed hand-backs, and the remaining four requests cost **zero**
failures (3 failed / 6 successful overall). Without `maxProbes` a dead primary
costs one failed request per turn forever.

**Exhaustion**, chain `[deadend/void, deadend/void2]`, `maxCycles: 2`: exactly **four**
failed requests — `requiredPhysicalRetries(2, 2)` — then a terminal error naming both
models. It was *six* before the off-by-one described under THE TWO BUDGETS was fixed, which
is what made the formula wrong rather than merely conservative.

## CONVENTIONS

- **A chain entry is the reference as written, never a split provider/id pair.**
  `ChainEntry.ref` holds `qwen/qwen3.8-27b` whole, because on this repo's litellm
  gateway that entire string is one model **id** under the provider `litellm` —
  and it is the form every `agents/*.md` `model:`/`fallback_models:` uses.
  Splitting on the first slash invents a provider `qwen` that does not exist.
  `index.ts` `resolve()` mirrors pi's own order (`core/model-resolver.js`
  `findExactModelReferenceMatch`): canonical `provider/id`, then provider+id, then
  an unambiguous bare id. Fuzzy substring matching is deliberately **not** copied
  from `resolveCliModel` — a chain names specific models, and answering with a
  near-miss is how a cheap fallback silently becomes an expensive one.
- **The exhaustion message must not contain a word pi retries on.** pi classifies
  retryability with a **regex over the error text** (`pi-ai/utils/retry.js`
  `RETRYABLE_PROVIDER_ERROR_PATTERN`: `connection.?error`, `timeout`, `503`, …),
  and this module reports exhaustion *as an assistant error*. Quoting the
  provider's error verbatim therefore made the message itself look retryable and
  pi lapped the chain forever — a budget that cannot be spent is not a budget.
  `sanitizeProviderError` classifies the cause into a fixed phrase instead, and
  the `exhaustion messages are never themselves retryable` suite asserts that
  against **pi's real classifier** rather than a restatement of its patterns, so
  a new pi pattern fails the suite instead of producing an infinite loop.
- **Every string that reaches that message is a vector, including model names and
  counts.** Sealing the provider-error path was not enough: attacking
  `describeExhaustion` directly found that a chain entry is printed *verbatim*,
  so a model named `timeout/model`, `503/z`, `rate-limit/m` or `x/ENOTFOUND` put
  a retry keyword in the message by itself — 18 such refs produced a retryable
  exhaustion, i.e. an infinite lap. `sanitizeModelRef` breaks the keyword with a
  `·` (every original character survives, so the name stays readable) and
  `spellNumber` renders the cycle count as a word. Every name in this repo is
  safe, which is precisely why this would have stayed invisible until someone
  added a model whose name happened to contain one of ~30 words. The
  `a hostile chain cannot make exhaustion retryable` suite is the regression.
- **`describeExhaustion` must recognise its own output.** That text comes back as
  the next failure's `lastError`, so without the `isOwnError` guard it nested one
  copy deeper per lap (observed three deep).
- **Read load-time settings from disk, not `pi.getSettings()`.** `getSettings` is
  a throwing stub until the runner binds its context (`loader.js`:
  `getSettings: notInitialized`), and the chain must be known at load because
  that is when the virtual model is registered. `settings.ts` owns that read;
  `retry.maxRetries` still goes through `pi.getSettings()` at call time, where it
  is live and `/reload` can change it.
- **A chain of fewer than two models registers nothing** (`index.ts` guards
  `chain.length < 2`). A `fallback/auto` over one model would be a selectable
  model that spends a logical cycle per failure with nowhere to hop — worse than
  its absence, since pi's own retry already does that and does it honestly. The
  threshold is deliberately the same `> 1` the launcher uses
  (`subagent-herdr/lib.ts` `childFallbackChain`/`buildChildEnv`, and the `--model`
  choice in `launchAttempt`). They disagreed at first — `=== 0` here against `> 1`
  there — so a one-entry chain registered a router the launcher would never route
  a child to. One definition of "a chain", in both halves.
- **A virtual model is never a valid route, so `resolve()` filters it out.**
  `getAvailable()` *includes* virtual entries (`virtual-models.js`
  `withVirtualModels` adds them to the provider's `getModels()`) and a keyless
  virtual provider self-resolves auth, so `hasConfiguredAuth` says yes. A chain
  entry naming `fallback/auto` — an easy typo — therefore resolved to the router
  itself and pi threw "routed to fallback/auto, which is not a physical model" on
  **every** request; worse, the forward-walk only advances while the model is
  falsy, so a *truthy* virtual model stopped the walk and the chain never
  recovered. Measured as a dead session on turn one. pi does not export
  `VIRTUAL_MODEL_API`, so `lib.ts` declares it and a test reads the literal back
  out of pi's source to catch drift.
- **Session-scoped closure state resets on `session_start`, not just on load.**
  The extension factory runs once per runtime, but `session_start` fires again
  with `reload`/`resume`/`fork`. `lastError` only ever accumulated, so an
  exhaustion in a later session could report a `Cause:` derived from an earlier
  session's provider error — a diagnostic that confidently names the wrong cause.
- **An unreachable chain entry costs a position, not the request.** A router that
  returns a model without credentials makes pi **fail** the request
  (`docs/virtual-models.md`), turning a recoverable error into a dead session, so
  `route()` walks forward to the first reachable entry.
- **`state.index` records where the request actually went**, not where `advance()`
  aimed. Otherwise the next hop steps from a model that never ran and skips the
  one that did.
- **`direct` requests never mutate state.** Compaction summaries and extension
  model calls route to `home` and return no state: pi discards state for `direct`
  anyway, and letting a summarization failure spend the conversation's retry
  budget would make the budget mean two different things.

## THE TWO BUDGETS

pi increments its own retry counter on **every** failed request, so one lap of an
L-model chain spends L of `settings.retry.maxRetries`. That counter is not
reachable from a router, so the budgets are reconciled by arithmetic instead:
`requiredPhysicalRetries(L, maxCycles) = L × maxCycles`, and `index.ts` warns once
per session when the setting is too small for the configured laps. The **logical**
budget is the authority — `advance()` reports `exhausted` and the router throws.

**The formula has to be exact, not approximate.** `cycles` counts *completed wraps*, so
the first lap runs at `cycles === 0`; exhausting on `cycles > maxCycles` therefore allowed
`maxCycles + 1` laps. Measured before the fix: `maxCycles: 2` on a 2-model chain walked it
**three** times and spent 6 retries where the formula promised 4 — so a `maxRetries` set
from the formula stopped pi mid-lap and the last models in the chain were never reached,
silently. The guard is now `prior.cycles + 1 >= maxCycles`, and the equality is pinned for
`maxCycles + 1` laps. Measured before the fix: `maxCycles: 2` on a 2-model chain walked it
**three** times and spent 6 retries where the formula promised 4 — so a `maxRetries` set
from the formula stopped pi mid-lap and the last models in the chain were never reached,
silently. The guard is now `prior.cycles + 1 >= maxCycles`, and the equality is pinned for
20 configurations (chain 1/2/3/4/7 × cycles 1/2/3/10) by asserting *failed requests* rather than

This repo sets `maxRetries: 30` for its 3-model chain and `maxCycles: 10`. At the previous
`maxRetries: 10` only 3 cycles were reachable and `/fallback-chain` warned about it.

## ANTI-PATTERNS

- Restating pi's retry patterns instead of importing `isRetryableAssistantError`.
  A copy drifts, and drift here is an infinite loop rather than a wrong answer.
- Quoting a provider error into any message this module produces as an error.
- Calling `pi.getSettings()`, `setActiveTools()` or `getCommands()` at load time.
- Giving the router a chain whose entries carry `:level` — the thinking level
  comes from the selection and passes through — or one that names `fallback/auto`
  itself.
- Asserting a sanitised string is safe with a **word-boundary** regex. pi matches
  its status atoms as raw substrings, so `/\b503\b/` passes on text that pi still
  retries. That false assurance is exactly why the dated-model-id leak survived
  the first round of hardening. Assert `includes("503") === false`, or better,
  assert against `isRetryableAssistantError` itself.
- Assuming `~/node_modules`'s `@earendil-works/*` (0.75.4) can typecheck this: it
  has no virtual-model API at all. `tsconfig.json` points at the running pi's
  bundle for exactly that reason.

## COMMANDS

```sh
bun test agent/extensions/model-fallback/lib.test.ts   # 155 tests
cd agent/extensions/model-fallback && \
  ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```
