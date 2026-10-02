/**
 * model-fallback — on an error, move to the next model instead of waiting.
 *
 * Registers `fallback/auto`, a virtual model that walks a configured chain.
 * pi asks a virtual model's router before every request, and tells it *why*
 * (`user` / `continuation` / `retry` / `direct`) plus, on a retry, which model
 * failed and with what error. That is the whole mechanism: an error becomes a
 * different model rather than the same model again, slower.
 *
 * ## The behaviour, in the order it happens
 *
 * 1. The primary errors. pi calls `route()` with `reason: "retry"` and
 *    `failed.message.errorMessage`, and the chain's next model answers.
 * 2. The fallback's response lands. The following request is a `continuation`,
 *    and it is routed **back to the primary** — the original model gets to
 *    continue against the new response.
 * 3. A full lap of the chain counts as **one** retry, not one per model. pi's
 *    own counter cannot be reached from a router, so the lap budget is tracked
 *    in router state (`lib.ts`) and `settings.retry.maxRetries` is checked
 *    against it at startup, with a warning when it is too small to let the
 *    configured laps actually run.
 *
 * All of this is verified against pi 1.0.0 by running it; see AGENTS.md in this
 * directory for the measured transcript.
 *
 * ## Why a virtual model rather than an event handler
 *
 * There is no extension event that can change the model of a retry. `retry` is
 * decided inside `AgentSession._prepareRetry` and the model for a request is
 * resolved below it. The router is the only documented seam pi offers that runs
 * *before every request* and gets to name the model — so routing is not a
 * clever use of this API, it is the API for this.
 *
 * ## Subagents
 *
 * Children are spawned by `subagent-herdr`, which already walks an agent's
 * `fallback_models` — but only to get the child *launched*. Once running, a
 * child is a plain pi process whose own errors were nobody's business. It now
 * inherits this extension (the agent directory is shared) and reads its chain
 * from `PI_FALLBACK_CHAIN`, which the launcher sets from the same
 * `fallback_models` it was already using. One declaration, two jobs.
 *
 * @module model-fallback
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ChainEntry,
	type FallbackState,
	CHAIN_ENV,
	FALLBACK_MODEL_ID,
	FALLBACK_MODEL_REF,
	FALLBACK_PROVIDER,
	advance,
	describeBudgetShortfall,
	describeExhaustion,
	describeHop,
	describeNoneAvailable,
	formatModelRef,
	isDisabled,
	parseChainEnv,
	readChain,
	readConfig,
	readLimits,
	VIRTUAL_MODEL_API,
} from "./lib.js";
import { readSettingsKey } from "./settings.js";

/** Footer key for the hop notice. */
const STATUS_KEY = "model-fallback";

/** How long a hop notice stays in the footer. */
const STATUS_TTL_MS = 20_000;

/**
 * Settings key holding the chain and tunables.
 *
 * pi's settings loader is a plain `JSON.parse` with no schema rejection and its
 * writer merges unknown keys through untouched (`core/settings-manager.js`), so
 * a namespaced key is safe to add to `settings.json` without patching pi.
 */
const SETTINGS_KEY = "modelFallback";

/**
 * Resolve a chain entry against the live catalogue, using pi's own rules.
 *
 * Matching order mirrors `core/model-resolver.js`
 * `findExactModelReferenceMatch`: canonical `provider/id`, then provider+id
 * split at the first slash, then a bare-id match that must be unambiguous.
 * That order is what makes `qwen/qwen3.8-27b` — the form every `agents/*.md`
 * uses — resolve to the litellm model whose *id* is that whole string.
 *
 * Reimplemented rather than imported because pi exports `resolveCliModel`, not
 * the exact-match helper, and `resolveCliModel` also does fuzzy substring
 * matching. Fuzziness is wrong here: a chain is a list of specific models, and
 * silently answering with a near-miss is how a cheap fallback becomes an
 * expensive one without anyone noticing.
 *
 * Only **physical** models whose provider has credentials are returned. Both
 * halves of that matter: a router that returns an unauthenticated model makes pi
 * fail the request, and one that returns a *virtual* model makes pi fail every
 * request (`docs/virtual-models.md`) — either way turning a recoverable error
 * into a dead session.
 */
function resolve(ctx: ExtensionContext, entry: ChainEntry): Model<Api> | undefined {
	const usable = (model: Model<Api> | undefined): Model<Api> | undefined =>
		model && ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;

	const wanted = entry.ref.toLowerCase();
	// Only models that could actually serve a request are candidates, so an
	// ambiguity against a model this machine cannot reach is not an ambiguity.
	//
	// **Virtual models are excluded here**, which is load-bearing rather than
	// tidy. `getAvailable()` includes them (`virtual-models.js` `withVirtualModels`
	// adds them to the provider's `getModels()`), and a keyless virtual provider
	// self-resolves auth, so `hasConfiguredAuth` says yes. A chain entry naming
	// `fallback/auto` — an easy typo — therefore resolved to the router itself,
	// pi threw "routed to fallback/auto, which is not a physical model" on every
	// request, and because the forward-walk below only advances while the model is
	// falsy, a *truthy* virtual model stopped the walk and the chain never
	// recovered. Measured: a dead session on the first turn. Filtering here turns
	// that typo into a skipped entry, which is what every other unusable entry
	// already costs.
	const available = ctx.modelRegistry
		.getAvailable()
		.filter((m) => m.api !== VIRTUAL_MODEL_API);
	const canonical = available.filter((m) => `${m.provider}/${m.id}`.toLowerCase() === wanted);
	if (canonical.length === 1) return usable(canonical[0]);
	if (canonical.length > 1) return undefined;

	const slash = entry.ref.indexOf("/");
	if (slash > 0 && slash < entry.ref.length - 1) {
		const provider = entry.ref.slice(0, slash).toLowerCase();
		const id = entry.ref.slice(slash + 1).toLowerCase();
		const split = available.filter(
			(m) => m.provider.toLowerCase() === provider && m.id.toLowerCase() === id,
		);
		if (split.length === 1) return usable(split[0]);
		if (split.length > 1) return undefined;
	}

	// Bare id, e.g. `qwen/qwen3.8-27b` under the provider `litellm`. Ambiguity
	// across providers is a refusal, matching pi: picking one would be a guess.
	const byId = available.filter((m) => m.id.toLowerCase() === wanted);
	return byId.length === 1 ? usable(byId[0]) : undefined;
}

export default function (pi: ExtensionAPI) {
	// Read from disk, not `pi.getSettings()`: that is a throwing stub during
	// extension load, and the chain must be known now because
	// `registerVirtualModel` happens at load. See `settings.ts`.
	const raw = readSettingsKey(SETTINGS_KEY);
	if (isDisabled(raw)) return;

	const config = readConfig(raw);
	// A parent's choice for this child wins over the global chain: the launcher
	// knows which agent is running here, and `settings.json` does not.
	const envChain = parseChainEnv(process.env[CHAIN_ENV]);
	const chain = envChain.length > 0 ? envChain : readChain(raw);

	// Fewer than two models is not a chain: there is nothing to fall back *to*.
	// Registering anyway would publish a selectable `fallback/auto` that spends a
	// logical cycle per failure with nowhere to hop — strictly worse than its
	// absence, because pi's own retry already does that and does it honestly.
	//
	// `> 1` is deliberately the same threshold the launcher uses
	// (`subagent-herdr/lib.ts` `childFallbackChain`, `buildChildEnv`, and the
	// `--model` choice in `launchAttempt`). They disagreed at first — `=== 0` here
	// against `> 1` there — which meant a one-entry chain registered a router the
	// launcher would never route a child to. One definition of "a chain", in both
	// halves.
	if (chain.length < 2) return;

	/** The last error text seen, for {@link describeExhaustion}. */
	let lastError: string | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	/**
	 * The budget warning, computed on first use.
	 *
	 * `pi.getSettings()` is only callable once the runner has bound its context,
	 * so this cannot be a load-time constant — and reading it live is better
	 * anyway, because `/reload` can change `retry.maxRetries` under a session.
	 */
	const budgetWarning = (): string | undefined =>
		describeBudgetShortfall(chain.length, config.maxCycles, pi.getSettings().retry?.maxRetries ?? 0);

	// Limits shown before the first response, from
	// `settings.modelFallback.contextWindow`/`maxTokens`. Optional: the catalogue
	// is not readable at load time (no `ctx` yet), so these cannot be derived from
	// the chain, and leaving them unset is pi's "unknown" (0).
	//
	// Unset is *safe*, which was checked rather than assumed: pi guards
	// `contextWindow <= 0` in `_exceedsCompactionThreshold` and skips a virtual
	// selection there outright, and `_checkCompaction` runs only after an
	// assistant message, where `_modelForMessage` resolves the **physical** model
	// that answered. So compaction never reads this 0 — it only shows as a blank
	// context-usage readout until the first response lands. Setting them buys a
	// correct footer on turn one, nothing more, which is why it is opt-in.
	const chainLimits = readLimits(raw);

	pi.on("session_start", (_event, ctx) => {
		// Module-closure state must be reset per session, not just per process: the
		// extension factory runs once per runtime, but `session_start` fires again
		// with reason `reload`/`resume`/`fork`. Without this, an exhaustion in a
		// later session could report a `Cause:` derived from an earlier session's
		// last provider error — a diagnostic that confidently names the wrong cause.
		lastError = undefined;
		if (statusTimer) {
			clearTimeout(statusTimer);
			statusTimer = undefined;
		}
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		// `budgetWarning()` is recomputed here rather than cached at load, because a
		// reload can change `retry.maxRetries` under a live session.
		// Reported once per session rather than per hop: the mismatch is a
		// configuration fact, and repeating it during an outage is noise on top
		// of the outage.
		const warning = budgetWarning();
		if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
	});

	pi.on("session_shutdown", () => {
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = undefined;
	});

	// The failure text comes from the assistant message rather than from
	// `request.failed`, because the exhaustion path has no `failed` to read:
	// it throws instead of routing, and the error it throws should still name
	// what actually went wrong.
	pi.on("message_end", (event) => {
		const message = event.message;
		if (message.role === "assistant" && message.stopReason === "error") {
			lastError = message.errorMessage ?? undefined;
		}
	});

	pi.registerVirtualModel<FallbackState>({
		provider: FALLBACK_PROVIDER,
		id: FALLBACK_MODEL_ID,
		name: `Fallback chain (${chain.map(formatModelRef).join(" → ")})`,
		// Every level the chain's members might accept. pi clamps to the routed
		// model, so offering a level a given member lacks costs nothing, while
		// omitting one would make it unselectable on the members that have it.
		thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
		// Shown only until the first response; after that pi uses the limits of the
		// physical model that answered. See the `chainLimits` note above for why
		// leaving these unset does not disturb compaction.
		...chainLimits,
		route(request, ctx) {
			const result = advance({
				reason: request.reason,
				chainLength: chain.length,
				state: request.state,
				config,
			});

			if (result.kind === "exhausted") {
				// Throwing is the documented way for a router to fail a request.
				// Reaching this means every model failed for the whole budget, so
				// failing loudly beats lapping forever.
				throw new Error(describeExhaustion(chain, result.cycles, lastError));
			}

			// Walk forward from the chosen index to the first model this machine
			// can actually reach, so an unreachable entry costs a position in the
			// chain rather than the request.
			let index = result.index;
			let model = resolve(ctx, chain[index]!);
			for (let i = 1; i < chain.length && !model; i++) {
				index = (result.index + i) % chain.length;
				model = resolve(ctx, chain[index]!);
			}
			if (!model) {
				// Message lives in lib.ts: it prints the chain, so it needs the same
				// keyword sanitising exhaustion does (an inline template here was
				// retryable for 6 of 7 hostile model names).
				throw new Error(describeNoneAvailable(chain));
			}

			if (result.hop && ctx.hasUI) {
				const notice = describeHop(chain[result.hop.from], chain[index]!, result.hop.cycles);
				ctx.ui.setStatus(STATUS_KEY, notice);
				if (statusTimer) clearTimeout(statusTimer);
				statusTimer = setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), STATUS_TTL_MS);
			}

			// `state.index` must record where the request actually went, not where
			// `advance` aimed, or the next hop would step from a model that never
			// ran and silently skip the one that did.
			const state = result.state ? { ...result.state, index } : undefined;
			return { model, thinkingLevel: request.thinkingLevel, state };
		},
	});

	pi.registerCommand("fallback-chain", {
		description: "Show the model fallback chain and its budget",
		handler: async (_args, ctx) => {
			const warning = budgetWarning();
			const lines = [
				`Chain (${FALLBACK_MODEL_REF}):`,
				...chain.map((entry, i) => {
					const model = resolve(ctx, entry);
					const mark = model ? "ok" : "UNAVAILABLE";
					return `  ${i}. ${formatModelRef(entry)} [${mark}]`;
				}),
				"",
				`Cycles allowed: ${config.maxCycles} (one cycle = one full lap of the chain = one retry)`,
				`Primary probes before settling on a fallback: ${config.maxProbes}`,
				`settings.retry.maxRetries: ${pi.getSettings().retry?.maxRetries ?? 0}`,
				...(warning ? ["", warning] : []),
				...(envChain.length > 0 ? ["", `Chain came from ${CHAIN_ENV} (set by the parent).`] : []),
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), warning ? "warning" : "info");
		},
	});
}
