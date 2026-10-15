# agent/extensions/model-fallback — the error-to-next-model router

Registers **`fallback/auto`**, a virtual model that walks a chain of real models.
An error moves work to the *next* model instead of re-asking the one that just
failed; once a fallback answers, the **original model gets the next request**.

| File | Owns |
|---|---|
| `lib.ts` | The state machine and every message. Pure, pi-free, and the one suite here covers it |
| `index.ts` | Session wiring: `registerVirtualModel`, `/fallback-chain`, the footer notice |
| `settings.ts` | Load-time `settings.json` read — `pi.getSettings()` throws during extension load |

## HOW IT IS TURNED ON HERE

`agent/settings.json`:

```json
"defaultProvider": "fallback",
"defaultModel": "auto",
"retry": { "maxRetries": 30, ... },
"modelFallback": {
  "chain": ["qwen/qwen3.8-27b", { "model": "anthropic/claude-opus-5.5", "thinking": "low" }, { "model": "anthropic/claude-opus-5", "thinking": "low" }, "openai/gpt-5.6-sol"],
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

`retry.maxRetries` is 30. The chain is now **4 models**, so one lap spends 4 and the 10
configured cycles need 40 — 30 reaches 7 full laps plus 2 requests, so `index.ts`'s
once-per-session "too small" warning is live on this host (see THE TWO BUDGETS). It covered
the old 3-model chain exactly (3 × 10); with 10 only 3 cycles were reachable and it warned.

**A chain entry may pin a thinking level.** An entry is either a bare reference
string or an object `{ "model": "provider/id", "thinking": "level" }` — both forms
mix freely in one array, and `PI_FALLBACK_CHAIN` carries the same `ref|level`
item syntax (e.g. `a/1,b/2|low`) so agent-file and env chains stay
level (one of `off/minimal/low/medium/high/xhigh/max`, case-sensitive)
**overrides the user's selected level** for the requests that entry answers;
an entry without one passes the selection through. The override is applied
at route time on the *final* index — after the
reachability walk — so a skipped entry's level cannot land on the model that
actually answers, and pi clamps it to the routed model's capabilities. The pin
follows the model: `direct` requests routed to a pinned entry — compaction
summaries and cache warming, which `advance()` sends to `home` — also run at the
pinned level, an unbudgeted token cost a `thinking` key can create. The virtual
model still offers all seven levels, so the selection always stays selectable.
An invalid `thinking` value drops the level but keeps the model; dedup is by
model reference, case-insensitive, first occurrence winning — the level is
display, not identity. The level is visible in `/fallback-chain`, hop notices,
and the exhaustion/unreachable messages (the seven level words are proven
non-retryable against pi's real classifier in the suite). It is deliberately
**not** in the virtual model's `name`, because that is a fuzzy-match surface in
pi's resolver and a bare level word there would let `--model high` select the
router.

## WHERE TO LOOK

| Question | Answer |
|---|---|
| What model answers the next request | `lib.ts` `advance()` — the whole decision, by `reason` |
| Why a gateway 400 can still hop | `index.ts` `agent_before_settle` handler + `lib.ts` `isGatewayUpstreamFailure` / `upstreamHop` |
| Why a lap costs one retry and not L | `lib.ts` module docstring, "The two budgets" |
| Why the exhaustion message reads oddly flat | `lib.ts` `sanitizeProviderError` — pi retries on a *regex over the error text* |
| How a subagent gets a chain | `subagent-herdr/lib.ts` `childFallbackChain` → `PI_FALLBACK_CHAIN` (items as `ref` or `ref|level`) → here |
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


## GATEWAY-UPSTREAM RECOVERY (`agent_before_settle`)

pi's own retry classifier (`pi-ai` `isRetryableAssistantError`) pattern-matches the
assistant's `errorMessage`, and LiteLLM's gateway 400 — "Upstream request failed.
Received Model Group=… Fallbacks=None" — matches none of its patterns, so pi treats
the failure as non-retryable and settles the session. The chain therefore never sees a
`retry` reason, and a subagent (with no human to nudge it) sits waiting on the dead
model. The `agent_before_settle` boundary (pi 1.1.0) is the one seam that runs before
settlement and may force exactly one more request, so `index.ts` handles that case there.
It only acts when the session is on `fallback/auto` (on a physical model `route()` never
runs, so forcing a request would just re-ask the failing model), and only on the run's
**most recent** assistant — an older retained 400 is not this run's failure.

1. Decide with `upstreamRecovery` (`lib.ts`, pure and tested): settle, exhausted, or hop
   with the new state, `from`/`to`, and whether it wrapped. It reads the phrasing via
   `isGatewayUpstreamFailure`, which never matches this module's own exhaustion or
   unreachable messages — the boundary's loop safety rests on that, so it is structural.
2. Read the router state from `ctx.sessionManager.getBranch()` — the same source the
   router reads. `event.context.contextEntries` is compaction-trimmed and can miss the
   latest state entry.
3. `upstreamHop` (`lib.ts`) takes pi's own `retry` step (`advance("retry")`: same target,
   laps, probes) and adds `forced: true`. The forced request reaches the router as a
   `continuation`, which normally means "the last request succeeded" — hand back to
   `home`, zero `cycles`. That would undo the hop *and* make the budget unreachable
   (cycles reset after every hop, so a fully-down gateway looped forever). `forced` makes
   that one continuation route to `index` and keep `cycles`; it is consumed there.
4. On a **wrap** (the hop re-asks models that all just failed) wait pi's retry backoff
   first — `upstreamDelayMs`: `retry.baseDelayMs × 2^(cycles−1)`, capped at
   `MAX_UPSTREAM_DELAY_MS` (15 s). Hops to an untried model are immediate. Without this a
   gateway down for a few seconds burns all `maxCycles` laps in one burst. The cap is short
   because no run is active at this boundary, so `ctx.signal` is normally undefined and Esc
   is only honoured once the handler returns.
5. Append a visible `custom_message` notice (`describeUpstreamHop`). pi converts custom
   messages to user-role LLM messages, which is what makes `canContinue` accept
   `continue: true`; in the session projection it stays `role: "custom"`, so it does not
   turn the request into a `user` turn. Because the model reads it as the latest user
   message, it is written *to the model* ("automatic notice … continue the task") — a
   footer-style "X failed, routing to Y" invites a reply like "Noted." that ends the turn.

**The failed attempt is deliberately not omitted** (no `context_edit`), unlike pi's own
`_prepareRetry`. pi computes `userTurn` as "a user message after the last assistant" over
the projection. On a turn's first request — a subagent's very first request, the exact
case this exists for — omitting the failed assistant exposes the user prompt to that test,
the forced request becomes `user`, and `advance("user")` resets onto the dead primary in a
backoff-free loop. Keeping it is free: pi-ai's `transformMessages` never replays an
errored assistant to a provider.

The handler returns `{ entries: [...event.entries, ...drafts], continue: true }` — it
accumulates `event.entries` because the boundary runner is last-writer-wins per handler.
It settles on: no gateway-upstream failure, a one-model chain, or a spent cycle budget (then
it appends a visible `describeUpstreamExhausted` notice without `continue`, so headless and
print-mode runs record why the chain stopped). Each hop leaves one errored assistant and one
notice in the session — pi's own retry would have omitted the attempt, but here omitting it
is the bug described above. The composition upstreamHop → forced
continuation → failure is pinned in `lib.test.ts` (`a burst of all-upstream failures
exhausts within maxCycles laps`), as are every exit of `upstreamRecovery`; the handler's
remaining glue (model guard, branch read, sleep, draft assembly) has no test against a live
gateway.

## SUBAGENTS, AND THE TRAP WHEN TESTING THEM

A child gets its chain from `PI_FALLBACK_CHAIN`, which `subagent-herdr` sets from the
agent's `model:` and `fallback_models:` (each entry may be a bare ref or `ref|level`
with a pinned thinking level); it then launches on `--model fallback/auto` instead of one
model. All 10 agent files declare fallbacks, so all 10 compose a non-empty chain — verified
by composing the real spawn inputs from the real files and asserting that the chain starts at
each agent's declared `model`, that the `--model` flag is always `fallback/auto`, and that
an explicit `model` on the delegation call yields a singleton chain.

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

Everything below was produced by running pi 1.0.2 (the running pi is now **1.2.0**), not
inferred. The harness used a provider whose `baseUrl` is `http://127.0.0.1:1/v1` (connection
refused on every request), so the primary fails deterministically. The chains quoted below
(`deadend/void`, `deadend/void2`, `claude-haiku-4.5`) are that harness's, **not** the live
`modelFallback.chain` in `agent/settings.json` — read the setting for what is configured now.

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
- **A pinned thinking level is display, not identity.** An object entry
  `{ "model": "...", "thinking": "..." }` applies its level at route time, for the
  requests it answers; an entry without one passes the selection through. Dedup
  and resolution key on `entry.ref` alone — case-insensitively, the way
  `resolve()` matches the catalogue — so a model that appears twice with
  different levels is one entry, and `formatModelRef` never carries the
  annotation; the level never enters the virtual model's `name` either, because
  that is a fuzzy-match surface in pi's resolver. The moment a level became part
  of identity, the catalogue lookup would stop finding the model.
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
- **`planRegistration` (`lib.ts`) is the whole registration decision** — source pick, disable switch, malformed-env warning — and `index.ts` only acts on its result; its threshold step is `shouldRegisterRouter(chain, source)`, called with `"environment"` or `"settings"`. For `"environment"` (the `PI_FALLBACK_CHAIN` var set by `subagent-herdr` or `ralph-loop`), any non-empty chain registers: the child always launches on `fallback/auto`, so even a single unpinned entry must be routable. For `"settings"` (the `settings.json` chain read at load), `isRoutable(chain)` applies: two or more entries, or at least one pinned entry. This split exists because the env var is set by code that has already validated the chain, while settings.json is user-authored and a single unpinned entry there is a misconfiguration the router should not silently accept. An empty or malformed env value must not mask a valid settings.json chain: `planRegistration` checks the env first and only falls through to settings when the env yields nothing. The threshold lives in `lib.ts` rather than being re-derived in each consumer, so a future change to the rule cannot drift across call sites.
- **`modelFallback.enabled: false` cannot unregister a chain the parent committed.** The env var is read *before* the disable check, and `isDisabled` is skipped whenever the env chain is non-empty: a process launched on `fallback/auto` with `PI_FALLBACK_CHAIN` set cannot resolve its model without the router, so the settings switch only governs sessions that got no chain from a parent. A `PI_FALLBACK_CHAIN` that is set but parses to nothing logs a one-line `console.warn` at load: the session falls back to the settings.json chain when there is one, and nothing registers otherwise.
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

This repo sets `maxRetries: 30` for its 4-model chain and `maxCycles: 10` — short of the 40
the 10 cycles need, so the warning is live; at the previous `maxRetries: 10` only 3 cycles
were reachable and `/fallback-chain` warned about it.
## ANTI-PATTERNS

- Restating pi's retry patterns instead of importing `isRetryableAssistantError`.
  A copy drifts, and drift here is an infinite loop rather than a wrong answer.
- Quoting a provider error into any message this module produces as an error.
- Calling `pi.getSettings()`, `setActiveTools()` or `getCommands()` at load time.
- Giving the router a chain entry that carries a `:level` suffix — the legacy
  separator the ref grammar rejects. Pins live in the object form (`{ "model":
  "...", "thinking": "..." }`) in `settings.json`, or in the `ref|level` item
  form in agent files and `PI_FALLBACK_CHAIN` — or in a chain that names
  `fallback/auto` itself.
- Asserting a sanitised string is safe with a **word-boundary** regex. pi matches
  its status atoms as raw substrings, so `/\b503\b/` passes on text that pi still
  retries. That false assurance is exactly why the dated-model-id leak survived
  the first round of hardening. Assert `includes("503") === false`, or better,
  assert against `isRetryableAssistantError` itself.
- Assuming a paths-less scope can typecheck this: 0.75.4 has no virtual-model API at all, and
  while `~/node_modules` (once that 0.75.4) existed it was the default resolution for any
  scope without `paths`. That tree is gone — such a scope now walks to the repo-root symlink
  (the live bundle) — but `tsconfig.json` keeps its `paths` entry for exactly the reason it
  was added.

## COMMANDS

```sh
bun test agent/extensions/model-fallback/lib.test.ts   # the whole suite
cd agent/extensions/model-fallback && \
  ../subagent-herdr/node_modules/.bin/tsc -p tsconfig.json
```
