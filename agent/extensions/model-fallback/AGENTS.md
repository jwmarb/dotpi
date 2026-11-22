# model-fallback — the `fallback/auto` router: chain state machine, two retry budgets, cross-process leases

The user-facing surface (`fallback/auto`, `/fallback-chain`, the `settings.json` `modelFallback` key) is in
`docs/model-configuration.md` (§4–§5); the root AGENTS.md keeps the repo-level pointer. Line refs checked 2026-11-22 against pi 1.4.0.

## WHERE TO LOOK

| File | Owns |
|---|---|
| `index.ts` | Entry (`:226`). Registers the virtual model and `/fallback-chain` (`:720`), runs `route()`, the leases, the footer, and the gateway recovery handler |
| `lib.ts` | Pure domain, imports nothing (load-safe for `startup-fetch`): chain parsing (`parseChainReport` `:517`, `parseChainEnvReport` `:570`, `readChain` `:1862`), `advance` (`:867`), concurrency policy (`readConcurrency` `:1744`, `applyConcurrency` `:1132`, `pickFreeIndex` `:1048`, the lease-reservation loop `reserveRoute` `:1244`), sanitisation, limits |
| `concurrency.ts` | Filesystem, cross-process per-model leases. `leaseDir` (`:80`), `LEASE_DIR_ENV` = `PI_MODEL_FALLBACK_LEASE_DIR` (`:53`), TTL 900 s (`:46`) |
| `../lib/settings.ts` (consumer, not a file here) | The non-throwing load-time `modelFallback` read — `readSettingsKey(SETTINGS_KEY)` at `index.ts:235`. A project `.pi/settings.json` overrides the agent one |
| `served.ts` | The process-global snapshot of the chain actually registered |
| `footer.ts` | Replacement footer that shows the routed physical model, using `fitLines` |
| `lib`/`concurrency`/`footer`.test.ts | The three suites |

## THE STATE MACHINE (`advance`, `lib.ts:867`)

`RouteReason` = `user` | `continuation` | `retry` | `direct` (`lib.ts:122`).

- `user` resets to index 0 (`home`), with zero cycles and probes.
- `retry` advances the index. Wrapping the chain completes one lap, and exhaustion triggers when
  `cycles + 1 >= maxCycles`. **`maxCycles` is a cap on full chain laps, not per model.**
- `continuation` after a fallback success restores `home` and sets `probing`. Failure while probing increments
  `probes`, and after `maxProbes` the model that is actually answering becomes the new `home`.
- **The two budgets.** The router budget is `modelFallback.maxCycles`, authoritative in `advance`. The physical
  budget is `settings.retry.maxRetries`, which must be at least `chainLength × maxCycles` (`lib.ts:1317` `requiredPhysicalRetries`).
  The warning is computed lazily (`budgetWarning`, `index.ts:370`) because `pi.getSettings()` is unbound at load and `/reload` can change `maxRetries`.

## INVARIANTS

- **Load-time settings come from `../lib/settings.ts` (`readSettingsKey`), never `pi.getSettings()`** — registration
  runs at import, before the session API exists. The chain is then fixed for the process and published through
  `served.ts`, so sibling readers must not re-read settings (`startup-fetch.ts:39` imports `FALLBACK_MODEL_REF`).
- **Only terminal assistant-error text is sanitised.** `sanitizeProviderError` (`lib.ts:1557`) and `sanitizeModelRef`
  (`lib.ts:1417`) break retry keywords and 3-digit status-like runs, because pi decides retryability by regexing the
  error text. An unsanitised exhaustion message reads as retryable and lapses the chain forever. Hop notices are
  status messages, not assistant errors, so they are **deliberately raw** — "every message is sanitised" is not true.
- **Gateway recovery is deliberately narrow.** `isGatewayUpstreamFailure` (`lib.ts:1930`) accepts only a LiteLLM
  "upstream request failed" body, intercepted at `agent_before_settle` and pushed through the same advance. Own
  terminal errors return false, so they cannot be revived.
- **Leases are soft and best-effort.** `acquireLease` creates with `wx` and re-counts, releasing when it races past the
  cap. All-at-cap does not block: `reserveRoute` (`lib.ts:1244`) owns the reservation loop and routes over cap,
  leaseless, to the walk's **start** (never the last reachable entry). A refused acquire re-snapshots, so a group cap
  that filled meanwhile steers the next pick. A filesystem failure degrades to unlimited.
- **`modelFallback.concurrency` shape** (`ConcurrencyConfig`, `lib.ts:1669-1687`): per-model caps keyed by lower-cased
  ref, an optional `"*"` default, optional `groups` (soft shared budgets; a model in n groups must satisfy all n plus its own).
- **Pins differ by surface.** `settings.json` accepts `{ model, thinking }`; the env/agent chain grammar uses
  `ref|level` (`parseChainItem`, `lib.ts:244`). A `settings.json` *string* containing `|` is not a pin: `parseChainReport` (`lib.ts:517`) drops it and
  `planRegistration` warns, as it does for any other dropped entry and for a `chain` that is not an array.
  `levelFor` (`lib.ts:344`) applies a pin only after the routable index is chosen.
- `PI_FALLBACK_CHAIN` is load-time input. A value with **no** parseable entry warns and falls back to settings; a value
  whose entries **partly** parse registers the survivors and warns naming each dropped token (`parseChainEnvReport`
  `lib.ts:570`). The partial case is loud on purpose: the child is the only process that can see its own inherited
  value, and a silent shrink would change which models answer with nothing to show for it.
  Env drops are the **only** chain drops reported here: `settings.json` drops stay silent whenever the env chain is
  non-empty, because the same stale entries would otherwise complain once per child process.
  `enabled: false` does **not** suppress a valid env chain, since a child launched on `fallback/auto` must register.
- Physical resolution uses `ctx.modelRegistry` (not `agent/models.json` directly) and skips virtual models, so a
  `fallback/auto` entry in a chain is skipped rather than recursively routed. `contextWindow`/`maxTokens` are only
  the virtual model's advertised startup limits.

## QUIRKS

- `VIRTUAL_MODEL_API` is redeclared at `lib.ts:155` because pi does not export it; `lib.test.ts:2206` reads the literal
  back out of pi's own `virtual-models.js`, so a pi rename fails a test instead of silently breaking every request.
- `served.ts` keeps the published chain on a `globalThis` `Symbol.for` key (`:46`) because pi loads extensions with
  `moduleCache: false` (`:18-21`); each load clears it first (`index.ts:229-231`) so a `/reload` that disables the router
  leaves no stale chain for `startup-fetch`.
- `tsconfig.json`'s `include` lists only the five source files; `../lib/settings.ts` arrives as an import, not an
  include entry (a name listed there that no longer exists fails the whole scope with TS6053). The three
  `*.test.ts` suites are run by bun but never typechecked.
- `index.ts:29` points to "the measured transcript" in this file; no such transcript exists here (dangling comment).

## ANTI-PATTERNS

- **Adding a chain entry without raising `retry.maxRetries`.** The live profile is exactly at budget (4 entries ×
  `maxCycles` 10 = `maxRetries` 40): a fifth entry trips the shortfall warning and pi stops retrying mid-lap.
- **Restating the handoff.** Consumers import from here, one-way: `subagent-herdr/lib.ts:22-30`
  (`CHAIN_ENV`, `FALLBACK_MODEL_REF`, `formatChainItem`, …), `subagent-herdr/index.ts:162`,
  `ralph-loop/gate.ts:34`, `runtime-gate.ts:36`, `gate-agent.ts:33`, `startup-fetch.ts:37-46` (lib + `served.ts`).
  `LEASE_DIR_ENV`/`leaseDir` are **not** part of this list: they are read only inside this
  extension, and `subagent-herdr/lib.ts` no longer imports them.
