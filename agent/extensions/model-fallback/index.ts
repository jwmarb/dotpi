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
 * 4. The primary errors with a gateway 400 pi's own retry classifier does not
 *    recognise (LiteLLM's "Upstream request failed"). pi would settle and wait
 *    for a human, so the `agent_before_settle` boundary (pi 1.1.0) intercepts it
 *    once: the stored router state advances exactly as pi's retry would, marked
 *    `forced` so the follow-up `continuation` routes to the fallback and keeps
 *    the lap count, and one more request is forced.
 *
 * Behaviours 1–3 are verified by running pi; see AGENTS.md in this directory
 * for the measured transcript. Behaviour 4 was checked by reading the installed
 * pi 1.1.0 boundary runner and session code; its state machine is unit-tested in
 * `lib.test.ts`, but no test drives the handler against a live gateway.
 *
 * ## Why a virtual model rather than an event handler
 *
 * No extension event can change the model of a retry: `retry` is decided
 * inside `AgentSession._prepareRetry`, above model resolution. The router is
 * the only documented seam pi offers that runs *before every request* and gets
 * to name the model — so routing is not a clever use of this API, it is the
 * API for this. The one exception is behaviour 4: pi 1.1.0's
 * `agent_before_settle` boundary lets the extension keep the failed attempt,
 * persist advanced router state, append a visible notice, and request one
 * continuation — the model is still named only by the router. (Omitting the
 * failed attempt instead, as pi's own retry does, turns the forced request into
 * a `user` turn and loops on the dead primary; see the handler.)
 *
 * ## Subagents
 *
 * Children are spawned by `subagent-herdr`, which launches each child on
 * `fallback/auto` — this router — and hands it the agent's model chain via
 * `PI_FALLBACK_CHAIN`. Every non-empty chain must register: a process launched
 * on `fallback/auto` cannot resolve that model without the router. In a plain
 * pi process the rule is stricter — a single unpinned model registers nothing,
 * because nothing there has been committed to the router (`planRegistration`
 * in `lib.ts` owns the whole decision).
 *
 * @module model-fallback
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionVirtualModel,
	SessionBoundaryDraft,
	VirtualModelStateData,
} from "@earendil-works/pi-coding-agent";
import { createFallbackFooter } from "./footer.js";
import {
	type ChainEntry,
	type FallbackState,
	CHAIN_ENV,
	FALLBACK_MODEL_ID,
	FALLBACK_MODEL_REF,
	FALLBACK_PROVIDER,
	THINKING_LEVELS,
	advance,
	computeDisplay,
	describeBudgetShortfall,
	describeExhaustion,
	describeHop,
	describeNoneAvailable,
	describeUpstreamExhausted,
	describeUpstreamHop,
	formatEntry,
	formatModelRef,
	levelFor,
	planRegistration,
	readConfig,
	readLimits,
	readVirtualModelState,
	upstreamDelayMs,
	upstreamRecovery,
	VIRTUAL_MODEL_API,
	VIRTUAL_MODEL_STATE_CUSTOM_TYPE,
} from "./lib.js";
import { publishServedRouter } from "./served.js";
import { readSettingsKey } from "./settings.js";

/** Footer key for the hop notice. */
const STATUS_KEY = "model-fallback";

/** How long a hop notice stays in the footer. */
const STATUS_TTL_MS = 20_000;

/**
 * How long a rename waits for the chain to stop moving.
 *
 * A re-registration costs a full `modelRuntime.refresh()` (see
 * `syncVirtualModelName`), so rapid hops coalesce into one.
 */
const NAME_SYNC_COALESCE_MS = 250;

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

/**
 * Wait `ms`, resolving `false` early if `signal` aborts. An undefined signal
 * (the usual case at `agent_before_settle`, where no run is active) just waits;
 * see `MAX_UPSTREAM_DELAY_MS` for why that wait is capped.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
	if (signal?.aborted) return Promise.resolve(false);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export default function (pi: ExtensionAPI) {
	// Clear what a previous load published, first: before anything here can throw
	// and before the `register` early return. A `/reload` that turns the router off
	// must not leave the last load's chain behind for `startup-fetch` to name a
	// router that no longer exists. See `served.ts`.
	publishServedRouter(undefined);
	// Read from disk, not `pi.getSettings()`: that is a throwing stub during
	// extension load, and the chain must be known now because
	// `registerVirtualModel` happens at load. See `settings.ts`.
	const raw = readSettingsKey(SETTINGS_KEY);
	// The whole registration decision — source pick, disable switch, malformed
	// env warning, source-dependent threshold — is `planRegistration` in `lib.ts`.
	const plan = planRegistration({ settings: raw, envValue: process.env[CHAIN_ENV] });
	if (plan.warning) console.warn(plan.warning);
	if (!plan.register) return;
	const chain = plan.chain;
	const config = readConfig(raw);

	// The router's name is a fuzzy-match surface in pi's resolver and feeds the
	// /model subtitle. We re-register it live (see `syncVirtualModelName`) so the
	// subtitle names the in-use model; the bare chain name is the start state.
	const initialName = `Fallback chain (${chain.map(formatModelRef).join(" → ")})`;
	let lastRegisteredName = initialName;
	//
	// One accepted cost: the live name embeds model refs, so `--model <ref>` and
	// `/model` search can also match this router (the same fuzzy-match surface
	// `AGENTS.md` warns about for level words). Showing the in-use model in that
	// subtitle is the point of the feature, so the collision is taken knowingly.
	// It stays safe because pi's alias tie-break sorts ids *descending* and takes
	// the first (`model-resolver.js`), so a real ref like `gpt-5.6-sol` beats
	// `auto` — the router loses that tie, which is exactly why it is harmless.

	/** The last error text seen, for {@link describeExhaustion}. */
	let lastError: string | undefined;
	let statusTimer: ReturnType<typeof setTimeout> | undefined;

	let latestCtx: ExtensionContext | undefined;


	/** Owns the coalesced rename slot, so at most one timer is pending. */
	let nameSyncTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Show a footer notice for {@link STATUS_TTL_MS}. Every notice goes through
	 * here so one timer owns the slot: a stale timer from an earlier hop can
	 * never wipe a newer notice early, and none outlives its TTL.
	 */
	const showStatus = (ctx: ExtensionContext, notice: string): void => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, notice);
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = setTimeout(() => ctx.ui.setStatus(STATUS_KEY, undefined), STATUS_TTL_MS);
	};

	/**
	 * Re-register the router with a name that names the in-use model, so the
	 * /model subtitle shows it. A no-op unless the computed name differs from
	 * what is registered, so it is cheap in steady state and never perturbs an
	 * in-flight request — it runs at `session_start` and whenever the in-use
	 * model could have changed, never mid-`route()`.
	 *
	 * Call it through {@link scheduleNameSync} for the event-driven paths: a
	 * re-registration is not cheap in pi. `registerVirtualModel` ends with a
	 * `modelRuntime.refresh()`, which reloads `models.json`, rebuilds providers
	 * and runs one auth check per provider — so a burst of hops must not become a
	 * burst of refreshes.
	 */
	const syncVirtualModelName = (ctx: ExtensionContext): void => {
		const display = computeDisplay({
			entries: ctx.sessionManager.getBranch(),
			chain,
			provider: FALLBACK_PROVIDER,
			modelId: FALLBACK_MODEL_ID,
			// The selection comes from pi, not from the branch: pi does not record a
			// `model_change` when neither side is a virtual model, so a branch-derived
			// selection would stick on a stale model after tree navigation.
			selection: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
			thinkingLevel: ctx.thinkingLevel,
			// Name the entry that can actually serve, not the planned one: the
			// stored index does not move when `route()` skips an unreachable entry,
			// so without this the subtitle would name a dead model indefinitely.
			isReachable: (index) => {
				const entry = chain[index];
				return entry !== undefined && resolve(ctx, entry) !== undefined;
			},
		});
		const desired =
			display.kind === "fallback"
				// `planRegistration` only registers a non-empty chain, so the index is real.
				? `Fallback chain (using ${formatModelRef(chain[display.index]!)})`
				: initialName;
		if (desired === lastRegisteredName) return;
		lastRegisteredName = desired;
		pi.registerVirtualModel<FallbackState>(virtualModelDefinition(desired));
	};

	/**
	 * Coalesce a rename into one deferred re-registration, for UI sessions only.
	 *
	 * Two reasons. The subtitle is a UI surface, so a headless session
	 * (print/json/rpc) must not pay a model-runtime refresh for it — and those
	 * are exactly the sessions where chains hop unattended. And a burst of hops
	 * inside {@link NAME_SYNC_COALESCE_MS} should cost one refresh, not one each.
	 * The timer reads `latestCtx` when it fires, so a session that has gone away
	 * in the meantime is a no-op rather than a stale render.
	 */
	const scheduleNameSync = (ctx: ExtensionContext): void => {
		if (!ctx.hasUI) return;
		if (nameSyncTimer) clearTimeout(nameSyncTimer);
		nameSyncTimer = setTimeout(() => {
			nameSyncTimer = undefined;
			const current = latestCtx;
			if (current?.hasUI) syncVirtualModelName(current);
		}, NAME_SYNC_COALESCE_MS);
	};

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

		latestCtx = ctx;
		// Replace the built-in footer so the model on the right is the physical
		// model in use (not the bare `auto`), and so it shows at startup (before
		// the first response, the chain's primary). Restored on session_shutdown.
		if (ctx.hasUI) {
			ctx.ui.setFooter(createFallbackFooter({
				chain,
				provider: FALLBACK_PROVIDER,
				modelId: FALLBACK_MODEL_ID,
				getCtx: () => latestCtx,
				resolveModel: resolve,
				// The built-in's `(auto)` marker, from the same place pi reads it.
				autoCompactionEnabled: () => pi.getSettings().compaction?.enabled ?? true,
			}));
		}
		if (ctx.hasUI) syncVirtualModelName(ctx);
		// `budgetWarning()` is recomputed here rather than cached at load, because a
		// reload can change `retry.maxRetries` under a live session.
		// Reported once per session rather than per hop: the mismatch is a
		// configuration fact, and repeating it during an outage is noise on top
		// of the outage.
		const warning = budgetWarning();
		if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (statusTimer) clearTimeout(statusTimer);
		statusTimer = undefined;

		// Restore the built-in footer. Take the context pi passes rather than the
		// closure: this handler must be a no-op in a non-UI session and must not
		// depend on `session_start` having run first.
		if (ctx.hasUI) ctx.ui.setFooter(undefined);
		if (nameSyncTimer) clearTimeout(nameSyncTimer);
		nameSyncTimer = undefined;
		latestCtx = undefined;
	});

	// The failure text comes from the assistant message rather than from
	// `request.failed`, because the exhaustion path has no `failed` to read:
	// it throws instead of routing, and the error it throws should still name
	// what actually went wrong.
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (message.role === "assistant" && message.stopReason === "error") {
			lastError = message.errorMessage ?? undefined;
		}

		if (message.role === "assistant") scheduleNameSync(ctx);
	});

	// The /model subtitle names the in-use model, so it must follow every way the
	// selection can change. A `model_select` (including `/model` and cycling) is
	// the obvious one; `message_end` catches the router moving on its own. Tree
	// navigation changes no selection, but it does move the leaf the router state
	// is read from — so the subtitle's chain index can change without either
	// event, and it gets its own hook.
	pi.on("model_select", (_event, ctx) => scheduleNameSync(ctx));
	pi.on("session_tree", (_event, ctx) => scheduleNameSync(ctx));

	// pi's own retry classifier (pi-ai's `isRetryableAssistantError`) pattern-matches
	// the assistant's `errorMessage`, and LiteLLM's gateway 400 — "Upstream
	// request failed. Received Model Group=… Fallbacks=None" — matches nothing in
	// that list, so pi settles the session and the chain never sees a `retry`
	// reason: a subagent sits waiting on a human that is not there.
	// `agent_before_settle` (pi 1.1.0) is the one seam that runs before
	// settlement and may force exactly one more request, so this is where that
	// case is caught: the failed attempt stays in the session (see 1 below), the stored
	// router state is advanced as pi's own retry would, and one more request is
	// forced.
	//
	// Details that are load-bearing, in the order they would bite:
	//
	// 1. The failed assistant is deliberately NOT omitted (no `context_edit`).
	//    pi classifies the forced request with `userTurn` = "a user message
	//    after the last assistant". Omitting the failed attempt on a turn's
	//    first request exposes the user's prompt to that test, the request
	//    becomes `user`, and `advance("user")` resets the chain onto the dead
	//    primary — an unbounded loop. Keeping it costs nothing: pi-ai's
	//    `transformMessages` never replays an errored assistant to a provider.
	// 2. The stored state carries `forced: true` (see `upstreamHop`). The forced
	//    request arrives as a `continuation`, which otherwise means "the last
	//    request succeeded": it would hand back to `home` and zero `cycles`,
	//    undoing the hop and making the budget unreachable.
	// 3. The hop notice must be a *visible* `custom_message`. pi converts it to
	//    a user-role LLM message, which is what makes the boundary's
	//    `canContinue` accept `continue: true` (and keeps the context from
	//    ending on an assistant). In the session projection it stays
	//    `role: "custom"`, so it does not make the request a `user` turn.
	// 4. `entries` accumulates: the boundary runner is last-writer-wins per
	//    handler, so returning only our drafts would discard entries proposed
	//    by earlier handlers.
	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "error") return;
		// Only a session running on this router has a chain to hop along. On a
		// physical model `route()` never runs, so `continue: true` would just
		// re-ask the same failing model. `ctx.model` is the selection, not the
		// routed model, so this matches whenever `fallback/auto` is selected.
		if (ctx.model?.provider !== FALLBACK_PROVIDER || ctx.model.id !== FALLBACK_MODEL_ID) return;

		const decision = upstreamRecovery({
			messages: event.context.contextMessages,
			// The full branch, which is what the router reads — `contextEntries`
			// is compaction-trimmed and can miss the latest state entry.
			state: readVirtualModelState<FallbackState>(
				ctx.sessionManager.getBranch(),
				FALLBACK_PROVIDER,
				FALLBACK_MODEL_ID,
			),
			chain,
			config,
		});
		if (decision.kind === "settle") return;

		if (decision.kind === "exhausted") {
			// Settle on the provider's error, but record why the chain stopped —
			// as a visible message, so headless and print-mode runs keep it too.
			const notice = describeUpstreamExhausted(decision.cycles);
			showStatus(ctx, notice);
			return {
				entries: [
					...event.entries,
					{ type: "custom_message", customType: STATUS_KEY, content: notice, display: true },
				],
			};
		}

		// A wrap re-asks models that all just failed: back off as pi's own retry
		// would, or a short outage burns every lap in one burst.
		const delayMs = upstreamDelayMs(pi.getSettings().retry?.baseDelayMs ?? 2000, decision.state.cycles, decision.wrapped);
		if (delayMs > 0) {
			showStatus(ctx, `model-fallback: gateway upstream down, retrying the chain in ${Math.round(delayMs / 1000)}s`);
			if (!(await sleep(delayMs, ctx.signal))) return;
		}

		const drafts: SessionBoundaryDraft[] = [
			{
				type: "custom",
				// The local literal, not pi's `VIRTUAL_MODEL_STATE_ENTRY`: that would be
				// this file's only *runtime* import from pi, and a pi without the export
				// (the 0.75.4 in ~/node_modules) then fails to load the whole extension.
				// `lib.test.ts` pins the two as equal.
				customType: VIRTUAL_MODEL_STATE_CUSTOM_TYPE,
				data: {
					provider: FALLBACK_PROVIDER,
					modelId: FALLBACK_MODEL_ID,
					state: decision.state,
				} satisfies VirtualModelStateData<FallbackState>,
			},
			{
				type: "custom_message",
				customType: STATUS_KEY,
				content: describeUpstreamHop(decision.from, decision.to),
				display: true,
			},
		];
		showStatus(ctx, describeHop(decision.from, decision.to, decision.state.cycles));
		return { entries: [...event.entries, ...drafts], continue: true };
	});

	const virtualModelDefinition = (name: string): ExtensionVirtualModel<FallbackState> => ({
		provider: FALLBACK_PROVIDER,
		id: FALLBACK_MODEL_ID,
		// `name` is a fuzzy-match surface in pi's resolver and feeds the /model
		// subtitle; `syncVirtualModelName` re-registers it live as the chain
		// hops. A level word is kept out of the bare chain name so `--model high`
		// cannot silently select the router.
		name,
		// Every level the chain's members might accept. pi clamps to the routed
		// model, so offering a level a given member lacks costs nothing, while
		// omitting one would make it unselectable on the members that have it.
		// Entries that pin a level apply it at route time, below; the selection
		// still needs to stay selectable, so the full list is offered either way.
		thinkingLevels: THINKING_LEVELS,
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

			if (result.hop) showStatus(ctx, describeHop(chain[result.hop.from], chain[index]!, result.hop.cycles));

			// `state.index` must record where the request actually went, not where
			// `advance` aimed, or the next hop would step from a model that never
			// ran and silently skip the one that did.
			const state = result.state ? { ...result.state, index } : undefined;
			// A level pinned on the routed entry overrides the selection; an
			// unpinned entry passes it through. `levelFor` takes the final `index`,
			// after the reachability walk, so a skipped entry's level cannot leak
			// onto the model that actually answers.
			return { model, thinkingLevel: levelFor(chain, index, request.thinkingLevel), state };
		},
	});

	pi.registerVirtualModel<FallbackState>(virtualModelDefinition(initialName));
	// Publish the chain this load registered, not a fresh read of settings:
	// `chain` is fixed until the next `/reload` while the files and
	// `PI_FALLBACK_CHAIN` are not, so another surface re-reading them would name a
	// chain the router is not serving. Reachability goes through this file's
	// `resolve()`, the same check `route()` and the footer use. See `served.ts`.
	publishServedRouter({
		chain,
		isReachable: (ctx, index) => {
			const entry = chain[index];
			return entry !== undefined && resolve(ctx, entry) !== undefined;
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
					return `  ${i}. ${formatEntry(entry)} [${mark}]`;
				}),
				"",
				`Cycles allowed: ${config.maxCycles} (one cycle = one full lap of the chain = one retry)`,
				`Primary probes before settling on a fallback: ${config.maxProbes}`,
				`settings.retry.maxRetries: ${pi.getSettings().retry?.maxRetries ?? 0}`,
				...(warning ? ["", warning] : []),
				...(plan.source === "environment" ? ["", `Chain came from ${CHAIN_ENV} (set by the parent).`] : []),
			];
			if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), warning ? "warning" : "info");
		},
	});
}
