# Model configuration — one machine, three surfaces

Verified against pi 1.4.0 on 2026-11-02. Line refs move, grep before quoting.

## §1 Start here

| Surface | File | Read by | When read |
|---|---|---|---|
| Session model + router chain | `agent/settings.json` | pi core + `agent/extensions/model-fallback/settings.ts` | At load (the chain is fixed for the process) |
| Subagent model chain | `agent/agents/<name>.md` | `agent/extensions/lib/agents.ts` (chain built by `agent/extensions/subagent-herdr/lib.ts` `childFallbackChain`) | When a child spawns |
| Blackhole worker models | `agent/pi-blackhole/pi-blackhole-config.json` | the `pi-blackhole` npm package (`agent/npm/node_modules/pi-blackhole/`) | For its background worker calls (observer/reflector/dropper) and compaction-threshold checks |

The session runs on the virtual model `fallback/auto` (`defaultProvider: "fallback"` + `defaultModel: "auto"` in `agent/settings.json`); putting a real model there disables the router, because the session would then address a physical model directly and never enter the chain.

## §2 Where models come from
**(a) The `litellm` provider — the gateway catalog.** `agent/extensions/litellm.ts` fetches `/model_group/info` (and `/model/info`, for cache costs) from `LITELLM_BASE_URL` at load, authenticated by `LITELLM_API_KEY`, and registers every chat-mode `model_group` (mode `null`/`chat`/`completion`) as a model id with per-million costs, cache read/write rates, a vision flag, and — when the group reports `supports_reasoning` — a thinking-level map (`thinkingLevelMapFor`). The two fetches fail differently: only `/model_group/info` gates registration (`if (!groupInfo) return`), so a non-2xx there registers **zero models** and every `litellm/…` ref becomes unresolvable, while a failure on `/model/info` alone is a genuine degradation — models register with zero cache costs and one warning. If the host is unreachable outright, `fetch` throws out of extension load. Two bounded defaults apply when the gateway reports `null`: `contextWindow: 262_144` and `maxTokens: 32_768` (the comment at that call site explains why an unbounded default breaks: pi's `clampMaxTokensToContext` would reserve the whole remaining window and the gateway 400s).

**(b) `agent/models.json` — one local provider.** Defines provider `eagle` (`api: "openai-completions"`, `baseUrl: "http://eagle.lan:8080/v1"` — LAN-only, not portable) with one model, id `qwen3.8-27b` (`contextWindow: 262144`, `maxTokens: 65536`). The combined reference is `eagle` + `qwen3.8-27b` — it is **not** the same model id as litellm's `qwen/qwen3.8-27b`, and nothing in this repo aliases the two. A second endpoint on the same LAN host: `agent/extensions/local.ts` (tracked; auto-loaded in the default profile — `quant-trader/extensions/` has no `local.ts`) re-points pi's builtin `openai` provider there with `pi.registerProvider("openai", { baseUrl: "http://eagle.lan:8080/v1" })`. Which provider ultimately answers a bare `openai/gpt-5.6-sol` reference — that re-pointed builtin, or litellm's model *id* `openai/gpt-5.6-sol` registered under provider `litellm` — depends on pi's resolution order and is not settled here; verify with `/model` in a live session before relying on either reading.

**(c) The virtual `fallback/auto`** — registered by `agent/extensions/model-fallback/` (see §4). It is the only model id in this repo that is not served by a provider.

**Checking that a model id exists on the gateway** (id = `model_group` name in the response):

```sh
curl -s -H "Authorization: Bearer $LITELLM_API_KEY" "$LITELLM_BASE_URL/model_group/info" \
  | grep -o '"model_group": *"[^"]*"'
```

## §3 How to pick a model

Reference resolution order, per `schemas/pi-settings.schema.json`: canonical `provider/id`, then provider plus id, then a bare id pi resolves unambiguously.

Thinking levels: `off|minimal|low|medium|high|xhigh|max`.

The three pin grammars are **not interchangeable**:

| Surface | Grammar | Pin |
|---|---|---|
| `agent/settings.json` `modelFallback.chain` | `{"model": "…", "thinking": "…"}` object, or a bare `provider/id` string | `thinking` in the object; a `\|` in a chain *string* is **not** a pin (the object form owns pins in this file) |
| `agent/agents/*.md` frontmatter | `provider/id`, optional `\|level` | `ref\|level`, e.g. `qwen/qwen3.8-27b\|xhigh` |
| `pi-blackhole-config.json` model objects | `{"provider","id","thinking","cooldownHours","contextWindow"}` | `thinking` field, per model entry |

`defaultThinkingLevel` (`agent/settings.json`) is the session's level; a chain pin governs only while the router holds that entry, and a pin that fails to parse drops the pin while keeping the model, so the session level then governs.

The gateway clamps levels per family: `QWEN_THINKING_LEVEL_MAP` (`agent/extensions/litellm.ts`) emits only `none`/`low`/`medium`/`xhigh` upstream, so a qwen group effectively accepts `low`/`medium`/`xhigh` (`off` maps to `none`); `CLAUDE_THINKING_LEVEL_MAP` is `{ off: "none", xhigh: "xhigh" }` — and at this gateway `off` **cannot** actually disable thinking on Claude 5.5: 5.5 rejects `thinking.type="disabled"` upstream (400), so `none` passes through and the model still thinks adaptively (the comment above `CLAUDE_THINKING_LEVEL_MAP`).

## §4 How failover works (overview, not internals)

`chain[0]` is the primary and the `home`. A new user turn resets to it (zero cycles, zero probes); a failed request advances the index; wrapping the chain completes one lap; `maxCycles` caps **laps**, not per-model attempts. After a fallback has answered, the router probes the primary on the next hand-back; after `maxProbes` consecutive failed probes, the answering model becomes the new `home`. The registered chain and its budget are shown by `/fallback-chain`.

**The two budgets.** The router budget is `modelFallback.maxCycles`; the physical budget is `retry.maxRetries`, and the invariant is `retry.maxRetries >= chainLength × maxCycles`. This machine: chain length 4 × `maxCycles` 10 = 40 = `retry.maxRetries` 40. A shortfall warns at session start.

`concurrency` (per-model in-flight caps; `"*"` sets the default for every model the map does not name) and `groups` (one shared cap across named replicas) are **soft** caps. The per-model caps are held as leases in one directory (default `agent/cache/model-fallback-leases`, overridable with `PI_MODEL_FALLBACK_LEASE_DIR`) so two sessions against the same gateway obey one cap, not two; a group cap is not a second lease — it sums the members' counts from that same snapshot, so there is no group key on disk. All-at-cap does not block a request.

**Subagents.** The agent's `model` + `fallback_models` become the child's chain via `childFallbackChain` (`agent/extensions/subagent-herdr/lib.ts`), published in the child's env as `PI_FALLBACK_CHAIN`; the child also runs on `fallback/auto`. An explicit `model` override on the delegation call yields a **single-entry** chain (no fallbacks appended). The chain is the child's *runtime* routing — it is walked when the child's own model calls fail. A declaration with no syntactically usable reference at all is refused before launch.

**Pi-blackhole workers do NOT use this router.** They have their own per-stage chains with cooldowns (§7).

Internals — state machine, the two budgets, leases, sanitisation: `agent/extensions/model-fallback/AGENTS.md`.

## §5 Surface 1: `agent/settings.json`

Point-in-time excerpt of THIS machine's `agent/settings.json` (only `$schema` and `lastChangelogVersion` omitted; not canonical defaults):

```json
{
  "defaultProvider": "fallback",
  "defaultModel": "auto",
  "defaultThinkingLevel": "xhigh",
  "hideThinkingBlock": false,
  "steeringMode": "all",
  "extensions": [
    "+builtin:mcp",
    "+builtin:codemode",
    "-builtin:llama.cpp",
    "-builtin:tool-search",
    "-builtin:herdr"
  ],
  "images": { "autoResize": true },
  "theme": "tokyo-night",
  "retry": {
    "enabled": true,
    "maxRetries": 40,
    "baseDelayMs": 2000,
    "provider": { "maxRetries": 0, "maxRetryDelayMs": 60000 }
  },
  "modelFallback": {
    "chain": [
      { "model": "qwen/qwen3.8-flash-next", "thinking": "xhigh" },
      { "model": "anthropic/claude-opus-5.5", "thinking": "low" },
      { "model": "anthropic/claude-opus-5", "thinking": "low" },
      "openai/gpt-5.6-sol"
    ],
    "maxCycles": 10,
    "concurrency": {
      "qwen/qwen3.8-flash-next": 4,
      "qwen/qwen3.8-27b": 4,
      "anthropic/claude-opus-5.5-latest": 10,
      "anthropic/claude-opus-5.5": 10,
      "anthropic/claude-opus-5": 10,
      "openai/gpt-5.6-sol": 10,
      "deepseek/deepseek-v4-flash": 10
    },
    "maxProbes": 2,
    "contextWindow": 1048576,
    "maxTokens": 262144
  },
  "packages": [
    "git:github.com/samfoy/pi-lsp-extension",
    "npm:@ff-labs/pi-fff",
    "npm:pi-better-edit",
    "npm:pi-blackhole",
    { "source": "git:github.com/obra/superpowers", "extensions": ["-.pi/extensions/superpowers.ts"] }
  ],
  "quietStartup": true,
  "startupFetch": { "mode": "cycle", "style": "pixels", "height": 13 },
  "piBolt": {
    "packages": ["-npm:@ff-labs/pi-fff", "npm:opensec-pi-fff@0.11.1"],
    "packagesOverlay": true
  }
}
```

Per-key rows (pi core keys are pi's to document — the file's `$schema` points at `schemas/pi-settings.schema.json`, which `$ref`s pi's own published schema, `https://pi.dev/schemas/settings.schema.json`; only the three extension-owned keys — `modelFallback`, `startupFetch`, `piBolt` — are this repo's to document):

- `defaultProvider` / `defaultModel` — the session's model. `"fallback"`/`"auto"` routes through the router; a real pair disables it (§1).
- `defaultThinkingLevel` — the session's thinking level; chain pins override it while held (§3).
- `hideThinkingBlock` — render thinking collapsed in the transcript; `true` is required for `thinking-indicator.ts`'s relabelling half.
- `steeringMode` — how queued steering messages are delivered (`"all"` here: every queued message at once; the other value is `"one-at-a-time"`).
- `retry.enabled` / `retry.maxRetries` / `retry.baseDelayMs` — pi's physical retry policy; `maxRetries` is the budget the router must fit inside (§4).
- `retry.provider.maxRetries` — **must stay 0**: provider-level retry re-issues the request inside pi, fighting the router's own advance, so a nonzero value double-retries and the router never sees the failure. pi reads it as a core setting (`settings.retry?.provider?.maxRetries` in its settings manager); `retry.provider.maxRetryDelayMs` bounds that backoff, and pi migrates the legacy `retry.maxDelayMs` into it.
- `extensions` — `+builtin:`/`-builtin:` entries enable/disable pi builtins; `-builtin:herdr` matters because Pi-Bolt's built-in herdr reporter labels the pane `pi-bolt`, which fails `herdr agent start --kind pi` with `agent_kind_mismatch`.
- `packages` — string form (`git:…`/`npm:…`) and object form (`{ "source": …, "extensions": ["-…"] }`), where a `-` entry excludes one extension a package ships (here: superpowers' bootstrap extension).
- `theme` — TUI theme name (`tokyo-night` → `agent/themes/tokyo-night.json`).
- `quietStartup` — pi 1.4.0 has three states here: `true` hides all startup output, `"header"` keeps only the startup header, absent/false keeps everything.
- `images.autoResize` — pi's own default is `true`, bounding an attached image to 2000×2000 for model compatibility; the entry here restates the default explicitly.
- `modelFallback.enabled` — `false` stops the process registering `fallback/auto` and forces the chain empty, so it needs a real `defaultProvider`/`defaultModel` pair in the same file or the session has no model to resolve (recipe 6 in §9). It does **not** suppress a chain a parent already launched this child on (`PI_FALLBACK_CHAIN`).
- `modelFallback.chain` — models in priority order, first = primary; object entries pin `thinking`. A dropped entry is reported at startup naming it and why.
- `modelFallback.maxCycles` / `maxProbes` — how many **laps** of the whole chain one failure burst may take, and how many times it re-probes the primary before a fallback becomes home (§4). Coercion defaults: `schemas/pi-settings.schema.json`.
- `modelFallback.concurrency` — per-model soft caps (`"*"` = the default for the rest). The consequence to know: a key or value the reader rejects is skipped at startup and that model is left **uncapped with no warning**.
- `modelFallback.groups` — shared caps across named replicas (`[{ "name", "models", "max" }]`); an entry the reader rejects is dropped **silently** — exact acceptance rules in `schemas/pi-settings.schema.json`.
- `modelFallback.contextWindow` / `modelFallback.maxTokens` — what `fallback/auto` advertises **before its first response**, for the context readout only; once a real model answers, its own limits govern. Absent = no claim.
- `startupFetch.{mode,image,style,height}` — the startup header picture (`agent/extensions/startup-fetch.ts`): `mode` `fixed|cycle|random|off` picks the file from `agent/images/`, `style` picks the renderer (catimg for `block`/`half`, chafa for `quad`/`sextant`/`octant`/`braille`/`ascii`, `pixels` over Kitty), `height` 4–40 rows.
- `piBolt.{packages,packagesOverlay}` — the Pi-Bolt-only half of the package list; plain pi ignores the key entirely. `packagesOverlay: true` makes `piBolt.packages` overlay `packages` under Pi-Bolt (`-` entries remove, others add) — here, swapping `@ff-labs/pi-fff` for `opensec-pi-fff@0.11.1` — which is what keeps `opensec-pi-fff` out of plain pi.

The bare-array shorthand: `modelFallback: ["a/b", "c/d"]` is read as the chain itself, every other option at its default. `schemas/pi-settings.schema.json` is the validation authority, and pi does **not** validate settings — a typo'd key is silently ignored; the `$schema` squiggle in an editor is the only notice you get.

## §6 Surface 2: `agent/agents/*.md`

The frontmatter keys `model:` (one reference) and `fallback_models:` (a comma-separated list of references) are parsed only by `agent/extensions/lib/agents.ts`. The current assignments:

```sh
grep -H -E '^(model|fallback_models):' agent/agents/*.md
```

Grammar facts:

- **snake_case only** — `fallbackModels` never matches, so a camelCase file silently loses its fallbacks.
- **Comma-separated** list: `fallback_models: deepseek/deepseek-v4-flash, openai/gpt-5.6-terra`.
- **`|level` pins** are the surface's own pin form: `anthropic/claude-opus-latest|medium`.
- The child **always runs on `fallback/auto`**; `model` + `fallback_models` are the chain the child's router serves (`PI_FALLBACK_CHAIN`, §4).
- `fallback_models` entries must be ids the gateway can actually serve. An id the gateway does not serve resolves to nothing at route time: `route()` resolves the whole chain once and walks forward to the first model this machine can reach, so a dead entry **silently shrinks your effective chain** rather than costing a request (`/fallback-chain` marks it `UNAVAILABLE`). Only entries that resolve but keep failing cost `maxCycles` laps. If no entry resolves, the router refuses the turn rather than answering. Verify refs against the gateway's `/model_group/info` (§2) before adding one.

The rest of the frontmatter vocabulary (`name`, `description`, `tools`, `skills`, `callable_by`) is documented in [agent/AGENTS.md](../agent/AGENTS.md) — not restated here.

## §7 Surface 3: `pi-blackhole/pi-blackhole-config.json`

The `pi-blackhole` package replaces pi's LLM-based `/compact` with an algorithmic structural summary and runs three **separate billed model calls** as background workers: the **observer** (durable facts from the transcript, after `observeAfterTokens` new tokens), the **reflector** (synthesis into reflections, after `reflectAfterTokens`), and the **dropper** (pool-pressure pruning). Each worker has its own model chain; none of them *starts* on the session model (with `sessionFallback: true`, as here, it is each worker's last resort — see below).

Point-in-time excerpt of THIS machine's model block only (not canonical defaults; the reflector/dropper blocks mirror the observer's; the `_comment` keys are verbatim from the file, and their "fallback N" numbering counts the stage's primary model as entry 1):

```json
{
  "model": {
    "provider": "litellm",
    "id": "deepseek/deepseek-v4-flash",
    "contextWindow": 1048576
  },
  "observerModel": {
    "provider": "litellm",
    "id": "deepseek/deepseek-v4-flash",
    "contextWindow": 1048576
  },
  "observerFallbackModels": [
    {
      "_comment": "Observer fallback 2: Claude Sonnet latest — paid ($2/$10 per M); second by chosen ordering, not a last resort.",
      "provider": "litellm",
      "id": "anthropic/claude-sonnet-latest",
      "thinking": "low",
      "cooldownHours": 6
    },
    {
      "provider": "litellm",
      "id": "openai/gpt-5.6-sol",
      "thinking": "low",
      "cooldownHours": 2
    }
  ]
}
```

Model-object fields: `provider`, `id`, `thinking`, `cooldownHours`, `contextWindow`, plus the file's own hand-written `_comment` convention (keys prefixed `_comment` — prose for humans, ignored by the package). `model` is the **base model**: the last fallback before the session model. The stage keys are `observerModel`/`observerFallbackModels`, `reflectorModel`/`reflectorFallbackModels`, `dropperModel`/`dropperFallbackModels`.

Identity is all-or-nothing. An entry with `provider` but no `id` (or the reverse) is dropped **whole** at parse, so a half-written slot cannot hide a typo by becoming something else. The one exception is deliberate: `{ "thinking": "low" }` with no `provider`/`id` is a legal **thinking-only modifier** — it supplies that stage's thinking level while the worker tracks the session model, and it carries no identity to cool down.

The pair resolves through pi's model registry (`ctx.modelRegistry.find(provider, id)` in the package's `src/om/runtime.ts`), so `provider` is the name pi knows the provider by — `litellm`, the name `agent/extensions/litellm.ts` registers, not a URL — and `id` is that provider's model id (the gateway's `model_group` name). That is why this file splits the reference into two fields: no `provider/id` string grammar and no `|level` pin exists here (§3).

**Resolution order** (package README, "Fallbacks"): each worker tries `stageModel → stageFallbacks → base model → session model`, skipping cooled-down models. By default the session model *is* the last-resort fallback (`sessionFallback: true`), so workers keep running even with no worker models configured; `sessionFallback: false` keeps worker runs off the session model — the rationale is cost plus prompt-cache busting, since a worker hit on the session model costs a billed call and invalidates its prompt cache.

**Cooldowns.** Keyed on `provider/id` alone — **no stage in the key** (`modelKey` in the package's `src/om/cooldown.ts`; the entry's `stage` field labels the cause, it does not scope the cooldown). So a model that fails in the observer stage is skipped by the reflector and dropper too, until it expires. State is persisted to `<agentDir>/pi-blackhole/pi-blackhole-cooldown.json` — `agent/pi-blackhole/` for the default profile, `quant-trader/pi-blackhole/` under `pi-quant` — gitignored runtime state beside that profile's config, surviving pi restarts. `cooldownHours` is how long a failed candidate stays benched — **omitted means 1 hour**, and `cooldownHours: 0` disables cooldown entirely (no disk writes, no persistent state; the package CHANGELOG: "0 is a valid value that disables cooldown entirely … Failed models are tracked in-memory within each consolidation stage (via `failedInCycle` set) so the fallback chain still advances past them"). Not every failure benches a model globally: exhausting a worker's turn cap, a local/import/abort failure, a request the model rejects as incompatible, and a too-small context window each skip that model **for the current stage only** with no persisted cooldown (package CHANGELOG, the "no longer bench" entries). A `workerAttemptTimeoutMs` deadline on a configured candidate does engage its cooldown. Separate from all of this: the worker pipeline itself retries a failed stage on the next `agent_start`/`turn_end` behind a 30-second gate, so a failing API is not re-hit every turn.

**`skipForProviders`** — EXPERIMENTAL compatibility shim (pi-codex-compaction coexistence): providers for which blackhole steps aside entirely. The package's own note: "Deliberately unsurfaced in README/CONFIG.md; do not rely on it." (`[]` = disabled, as here. That note names the package's `docs/CONFIG.md`, which the published tarball does **not** ship — the installed docs here are `README.md`, `example-config.json` and `CHANGELOG.md`.)
**Compaction-threshold knobs** — `compactAfterTokens` (0 = unset; a file value of **exactly 81000 is dropped at load, in memory**, as legacy scaffold residue, so the derived knobs/preset govern — and the stale 81000 stays in your file until you delete it; the package never rewrites the config to "migrate" it. A value from the `PI_BLACKHOLE_COMPACT_AFTER_TOKENS` env var *is* treated as deliberate and stays), `compactAfterRatio` (0–1, 0 = unset), `compactReserveTokens` (0 = unset), `compactAfterPreset` + `compactAfterPresets`. Precedence, as the shipped code computes it (`compactThresholdTokens` in the package's `src/om/model-budget.ts`, first match wins):

1. `compactAfterTokens` (positive integer, not the dropped 81000)
2. `compactAfterRatio` → `floor(contextWindow × ratio)`
3. `compactReserveTokens` → `contextWindow − reserve`
4. the preset curve from `compactAfterPreset` (default `"default"`)

The built-in `default` curve anchors (`BUILTIN_PRESETS`, also `src/om/model-budget.ts`; `example-config.json`'s `compactAfterPresets` is the user-side **override** surface for the same curve): 0.90 @ 32,768 → 0.80 @ 131,072 → 0.70 @ 262,144 → 0.40 @ 1,048,576, linearly interpolated between anchors. This machine sets **both** `compactAfterRatio: 0.65` and `compactAfterPreset: "default"` — the ratio wins, so the threshold is `floor(window × 0.65)`, re-derived on every check (a `/model` change takes effect).

**Token budgets** (key | what it caps | this machine's value, point-in-time):

| Key | Caps | Value |
|---|---|---|
| `retainedToolOutputMaxTokens` | newest-first historical tool-output text kept in context (older text reachable via recall) | 32000 |
| `recallResponseMaxChars` | a single recall tool / `/blackhole-recall` response (per-entry and per-line shares derive from it) | 48000 |
| `observeAfterTokens` | new tokens accumulated before the observer runs | 20000 |
| `reflectAfterTokens` | tokens accumulated before the reflector runs | 35000 |
| `observationsPoolMaxTokens` | rendered-line cap on the observations pool | 24000 |
| `observationsPoolTargetTokens` | pool target the dropper steers toward | 12000 |
| `reflectionsPoolMaxTokens` | rendered-line cap on the reflections pool | 8000 |
| `reflectorInputMaxTokens` | reflector's input budget per run | 120000 |
| `dropperInputMaxTokens` | dropper's input budget per run | 120000 |
| `observerChunkMaxTokens` | one observer input chunk | 60000 |
| `observerPreambleMaxTokens` | observer preamble reserved from the chunk (0 = none) | 0 |
| `dropperPressureThreshold` | fraction of `observationsPoolMaxTokens` where the dropper fires without new data (1 disables) | 0.7 |
| `dropperPoolFullnessThreshold` | minimum pool fullness before the dropper may run at all | 0.1 |
| `agentMaxTurns` | worker agent-loop turn cap per attempt | 16 |
| `workerAttemptTimeoutMs` | hard wall-clock deadline per worker/model attempt (0/unset = disabled) | 600000 |
| `providerIdleTimeoutMs` | body-idle timeout for background provider streams (0 = disabled) | 120000 |

**Sizing rule.** A worker's input caps must fit inside that worker model's `contextWindow` — the package skips a candidate whose window is too small for the measured input (that skip is stage-local, no cooldown). The effective window resolves in this order: the `contextWindow` override on the matching model object, then pi's model registry value for that provider/id, then a 128000 fallback. Two consequences: a worker slot's `contextWindow` also moves the auto-compaction threshold only when that provider/id **is** the current session model (it is matched by provider+id across all configured slots), and an override that overstates the gateway's real window makes the caps look legal right up to the 400. This machine pins `contextWindow: 1048576` on each worker model; check the gateway's `/model_group/info` before trusting a cap the gateway will reject.

**Editing.** Hand-edit the file — worker models are hand-edit **only**, which is why the `_comment` convention lives here. It is the **one tracked file** inside `agent/pi-blackhole/` — everything else there is gitignored runtime state, the cooldown file included. `/blackhole settings` has no model fields at all: the modal's editable set is drawn from the package's own `DEFAULTS`, which declares no `model`/`observerModel`/`*FallbackModels` key, and a settings save writes `{ ...existing, ...settings }` — so a save carries the model objects and their `_comment` keys through untouched, exactly as it carries `compactAfterPresets` (which the package labels hand-edit-only for the same reason).

## §8 Other profiles and project overrides

`quant-trader/` is a second profile with its own `settings.json`, `pi-blackhole/pi-blackhole-config.json` and `agents/` — separate files, edited separately, and they **differ** today from the default profile's: `concurrency` for `qwen/qwen3.8-flash-next` (2 vs 4, and no `anthropic/claude-opus-5.5-latest` entry), `modelFallback.contextWindow`/`maxTokens` (262144/32768 vs 1048576/262144), `packages` count (2 vs 5), and the worker model ids in its pi-blackhole config (`anthropic/claude-sonnet-5.5` in all four worker slots vs `deepseek/deepseek-v4-flash`, and no `*FallbackModels` arrays, so its workers go straight from stage model to base model to session model). The Profiles section of [AGENTS.md](../AGENTS.md) owns the rest.

A project `.pi/settings.json`'s whole `modelFallback` object **replaces** the agent one rather than merging key by key (the reader is `agent/extensions/model-fallback/settings.ts`; a partial merge of a chain would produce a chain neither file declares).

## §9 Recipes

1. **Change the primary model.** Edit `modelFallback.chain[0]` (the object's `model`, and its `thinking` pin if you want a level). Then restart pi — the chain is fixed at load.
2. **Add a chain entry.** Append to `modelFallback.chain`, then raise `retry.maxRetries` to at least new length × `maxCycles` (today 4 × 10 = 40). Then restart pi; a shortfall warns at session start.
3. **Cap one model.** Set `modelFallback.concurrency["<provider/id>"]`. **Share a cap across replicas.** Set `modelFallback.groups` — `[{ "name": "…", "models": ["provider/id", …], "max": N }]`, one global cap across the named replicas. Then restart pi.
4. **Change a subagent's model.** Edit `model:` / `fallback_models:` in `agent/agents/<name>.md`. Then no restart: the chain is rebuilt at spawn, so the next delegation picks it up — an already-running child keeps its spawn-time chain.
5. **Keep blackhole workers off the session model.** Set `sessionFallback: false` in `agent/pi-blackhole/pi-blackhole-config.json` plus a cheap `model` base entry (workers stop at the base model). Then: a fresh pi session reads it at load; for a running session, verify the effective values with `/blackhole settings` (whether it picks up a hand-edit without a restart is not verified here).
6. **Turn the router off.** Set `modelFallback.enabled: false` **and** a real `defaultProvider`/`defaultModel` pair — the switch alone stops the process registering `fallback/auto` while the default pair still names it, so the session would point at an unregistered model (caveat: it does not switch off a chain a parent already launched this child on via `PI_FALLBACK_CHAIN`, since a child on `fallback/auto` cannot resolve its own model without the router). Then restart pi.

## §10 Pitfalls

- The three pin grammars are not interchangeable (§3): `{model, thinking}` in settings, `ref|level` in agent frontmatter, `{provider, id, thinking, …}` in pi-blackhole.
- A `|` in a `settings.json` chain string drops that entry — with a startup warning naming it; the object form owns pins in that file.
- A `:level` suffix, a leading or trailing `/`, commas, or internal whitespace in a model ref drops the whole entry (the ref names no model to route to).
- A bad `concurrency` key/value leaves that model **silently** uncapped — no warning; the schema squiggle is the only notice.
- An invalid `groups` entry (blank name, non-integer `max`, empty/non-plain `models`) is dropped **silently**.
- `modelFallback.contextWindow`/`maxTokens` are readout-only: the startup limits for `fallback/auto`; a real model's own limits govern once it answers.
- `retry.maxRetries` below chain × `maxCycles` warns at startup — the physical budget gives up before the router has used the chain.
- `retry.provider.maxRetries` must stay 0 — provider retry fights the router.
- The chain is fixed for the process at load, so settings edits need a restart; in-session `/agent` profile switching does **not** swap an already-registered chain.
- Gateway unreachable at load → the `litellm` provider registers **zero** models (total failure, not degradation).
- `eagle` is LAN-only (`http://eagle.lan:8080/v1`) — its model id is unusable off that network.
- A `compactAfterTokens` of exactly 81000 in the config file is silently dropped as legacy scaffold residue — the ratio/preset governs instead (an env-var value stays explicit).
- A blackhole worker slot with `provider` but no `id` (or the reverse) is dropped whole — the stage silently loses that candidate.
- A blackhole cooldown is keyed `provider/id` with no stage, so one stage's failure benches that model for the other two stages as well; delete that profile's `pi-blackhole/pi-blackhole-cooldown.json` to clear it now.
- A blackhole `thinking` value outside the seven levels is dropped silently while the model is kept, so that stage runs at the session's level.

## Where each fact lives

- Chain state machine, the two budgets, leases, sanitisation: `agent/extensions/model-fallback/AGENTS.md`
- The child-chain handoff (`PI_FALLBACK_CHAIN`): `agent/extensions/subagent-herdr/AGENTS.md`
- Agent frontmatter vocabulary: `agent/AGENTS.md`
- Validation rules (chain grammar, `concurrency`, `groups`, `startupFetch`, `piBolt`): `schemas/pi-settings.schema.json`
- This guide: the cross-surface view, the recipes, the pitfalls.
