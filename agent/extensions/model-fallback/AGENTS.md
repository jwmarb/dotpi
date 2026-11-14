# model-fallback — the `fallback/auto` router: chain state machine, two retry budgets, cross-process leases

The user-facing surface (`fallback/auto`, `/fallback-chain`, the `settings.json` `modelFallback` key) is in
`docs/model-configuration.md` (§4–§5); the root AGENTS.md keeps the repo-level pointer. Line refs checked 2026-11-10 against pi 1.4.0.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` (753) | Entry (`:226`). Registers the virtual model and `/fallback-chain` (`:720`), runs `route()`, the leases, the footer, and the gateway recovery handler |
| `lib.ts` (2084) | Pure domain, imports nothing (load-safe for `startup-fetch`): chain parsing (`parseChainReport` `:517`, `readChain` `:1815`), `advance` (`:820`), concurrency policy (`readConcurrency` `:1697`, `applyConcurrency` `:1085`, `pickFreeIndex` `:1001`, the lease-reservation loop `reserveRoute` `:1197`), sanitisation, limits |
| `concurrency.ts` (304) | Filesystem, cross-process per-model leases. `leaseDir` (`:80`), `LEASE_DIR_ENV` = `PI_MODEL_FALLBACK_LEASE_DIR` (`:53`), TTL 900 s (`:46`) |
| `settings.ts` (72) | The non-throwing load-time `modelFallback` reader. A project `.pi/settings.json` overrides the agent one |
| `served.ts` (63) | The process-global snapshot of the chain actually registered |
| `footer.ts` (411) | Replacement footer that shows the routed physical model, using `fitLines` |
| `lib`/`concurrency`/`footer`.test.ts | The three suites |

## THE STATE MACHINE (`advance`, `lib.ts:820`)

`RouteReason` = `user` | `continuation` | `retry` | `direct` (`lib.ts:122`).

- `user` resets to index 0 (`home`), with zero cycles and probes.
- `retry` advances the index. Wrapping the chain completes one lap, and exhaustion triggers when
  `cycles + 1 >= maxCycles`. **`maxCycles` is a cap on full chain laps, not per model.**
- `continuation` after a fallback success restores `home` and sets `probing`. Failure while probing increments
  `probes`, and after `maxProbes` the model that is actually answering becomes the new `home`.
- **The two budgets.** The router budget is `modelFallback.maxCycles`, authoritative in `advance`. The physical
  budget is `settings.retry.maxRetries`, which must be at least `chainLength × maxCycles` (`lib.ts:1270` `requiredPhysicalRetries`).
  The warning is computed lazily (`budgetWarning`, `index.ts:370`) because `pi.getSettings()` is unbound at load and `/reload` can change `maxRetries`.

## INVARIANTS

- **Load-time settings come from `settings.ts`, never `pi.getSettings()`** — registration runs at import, before the
  session API exists. The chain is then fixed for the process and published through `served.ts`, so sibling readers
  must not re-read settings (`startup-fetch.ts:37` imports `FALLBACK_MODEL_REF`).
- **Only terminal assistant-error text is sanitised.** `sanitizeProviderError` (`lib.ts:1510`) and `sanitizeModelRef`
  (`lib.ts:1370`) break retry keywords and 3-digit status-like runs, because pi decides retryability by regexing the
  error text. An unsanitised exhaustion message reads as retryable and lapses the chain forever. Hop notices are
  status messages, not assistant errors, so they are **deliberately raw** — "every message is sanitised" is not true.
- **Gateway recovery is deliberately narrow.** `isGatewayUpstreamFailure` (`lib.ts:1883`) accepts only a LiteLLM
  "upstream request failed" body, intercepted at `agent_before_settle` and pushed through the same advance. Own
  terminal errors return false, so they cannot be revived.
- **Leases are soft and best-effort.** `acquireLease` creates with `wx` and re-counts, releasing when it races past the
  cap. All-at-cap does not block: `reserveRoute` (`lib.ts:1197`) owns the reservation loop and routes over cap,
  leaseless, to the walk's **start** (never the last reachable entry). A refused acquire re-snapshots, so a group cap
  that filled meanwhile steers the next pick. A filesystem failure degrades to unlimited.
- **`modelFallback.concurrency` shape** (`ConcurrencyConfig`, `lib.ts:1622-1634`): per-model caps keyed by lower-cased
  ref, an optional `"*"` default, optional `groups` (soft shared budgets; a model in n groups must satisfy all n plus its own).
- **Pins differ by surface.** `settings.json` accepts `{ model, thinking }`; the env/agent chain grammar uses
  `ref|level` (`parseChainItem`, `lib.ts:244`). A `settings.json` *string* containing `|` is not a pin: `parseChainReport` (`lib.ts:517`) drops it and
  `planRegistration` warns, as it does for any other dropped entry and for a `chain` that is not an array.
  `levelFor` (`lib.ts:344`) applies a pin only after the routable index is chosen.
- `PI_FALLBACK_CHAIN` is load-time input and wins when parseable. A malformed non-empty value warns and falls back to
  settings. `enabled: false` does **not** suppress a valid env chain, since a child launched on `fallback/auto` must register.
- Physical resolution uses `ctx.modelRegistry` (not `agent/models.json` directly) and skips virtual models, so a
  `fallback/auto` entry in a chain is skipped rather than recursively routed. `contextWindow`/`maxTokens` are only
  the virtual model's advertised startup limits.

## QUIRKS

- `VIRTUAL_MODEL_API` is redeclared at `lib.ts:155` because pi does not export it; `lib.test.ts:2162` reads the literal
  back out of pi's own `virtual-models.js`, so a pi rename fails a test instead of silently breaking every request.
- `served.ts` keeps the published chain on a `globalThis` `Symbol.for` key (`:46`) because pi loads extensions with
  `moduleCache: false` (`:18-21`); each load clears it first (`index.ts:229-231`) so a `/reload` that disables the router
  leaves no stale chain for `startup-fetch`.
- `tsconfig.json`'s `include` lists only the six source files: the three `*.test.ts` suites are run by bun but never typechecked.
- `index.ts:29` points to "the measured transcript" in this file; no such transcript exists here (dangling comment).

## ANTI-PATTERNS

- **Adding a chain entry without raising `retry.maxRetries`.** The live profile is exactly at budget (4 entries ×
  `maxCycles` 10 = `maxRetries` 40): a fifth entry trips the shortfall warning and pi stops retrying mid-lap.
- **Restating the handoff.** Consumers import from here, one-way: `subagent-herdr/lib.ts:21` (`LEASE_DIR_ENV`,
  `leaseDir`) and `:26-34` (`CHAIN_ENV`, `FALLBACK_MODEL_REF`, `formatChainItem`, …), `subagent-herdr/index.ts:162`,
  `ralph-loop/gate.ts:34`, `runtime-gate.ts:36`, `gate-agent.ts:33`, `startup-fetch.ts:33-43` (lib + `served.ts`).
