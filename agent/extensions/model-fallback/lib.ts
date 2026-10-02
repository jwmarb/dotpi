/**
 * The fallback-chain state machine: which model answers the next request.
 *
 * ## The rule this encodes
 *
 * An error does not mean "ask the same model again, slower". It means "ask the
 * next model". So a chain `[primary, f1, f2]` is walked on error — primary
 * fails, f1 answers — and a **full lap of the chain counts as one retry**,
 * rather than each individual model costing one. When a fallback answers, the
 * next request goes back to the primary: the fallback covered one request, it
 * did not inherit the session.
 *
 * ## Why this is a pure module
 *
 * pi calls a virtual model's `route()` before every request and hands back
 * whatever `state` the last call returned (`docs/virtual-models.md`). That
 * makes the decision a pure function of (reason, state, chain) — so it lives
 * here, with tests, and `index.ts` only translates between pi's request shape
 * and these types. Nothing here imports pi.
 *
 * ## The two budgets
 *
 * pi's own retry counter increments on *every* failed request, so one lap of an
 * L-model chain spends L of pi's retries. That counter is not reachable from a
 * router, so the two budgets are reconciled by arithmetic instead:
 * {@link requiredPhysicalRetries} is what `settings.retry.maxRetries` must be
 * for {@link FallbackConfig.maxCycles} laps to actually be reachable, and
 * `index.ts` warns when the setting is too small. The *logical* budget here is
 * the authority: {@link advance} reports `exhausted` and the router fails the
 * request with {@link describeExhaustion} rather than lapping forever.
 *
 * @module model-fallback/lib
 */

/**
 * One model in a chain, as the reference the human wrote.
 *
 * Deliberately *not* a split provider/id pair. pi's own resolver
 * (`core/model-resolver.js` `findExactModelReferenceMatch`) tries a canonical
 * `provider/id` match, then provider+id, then a bare-id match across providers
 * — which is the only reason `model: qwen/qwen3.8-27b` in an agent file works
 * at all, since that whole string is one litellm model *id*. Storing the
 * reference whole lets the same string mean the same model here as it does to
 * pi, instead of this module inventing a second, incompatible grammar.
 */
export interface ChainEntry {
	/** The reference exactly as written, e.g. `qwen/qwen3.8-27b`. */
	ref: string;
}

/**
 * Router state, carried by pi on the session branch between requests.
 *
 * Must stay JSON-serializable: pi stores it as a custom session entry, so it
 * survives compaction and follows forks (`docs/virtual-models.md`).
 */
export interface FallbackState {
	/** Chain index the next request uses. */
	index: number;
	/** Completed laps of the chain in the current failure burst. One lap = one retry. */
	cycles: number;
	/** Consecutive failed hand-backs to {@link FallbackState.home}. */
	probes: number;
	/**
	 * Chain index work returns to once a fallback has answered.
	 *
	 * Normally 0, the primary. It only moves when the primary has failed
	 * {@link FallbackConfig.maxProbes} hand-backs in a row, which is what stops
	 * a permanently dead primary from costing one failed request per turn
	 * forever.
	 */
	home: number;
	/**
	 * This request is a hand-back to {@link FallbackState.home} after a fallback
	 * answered, so its failure is a failed probe rather than an ordinary error.
	 */
	probing: boolean;
}

/** Why pi is routing a request. Mirrors pi's `ModelRouteReason`. */
export type RouteReason = "user" | "continuation" | "retry" | "direct";

/** Tunables, from `settings.modelFallback`. */
export interface FallbackConfig {
	/**
	 * Laps of the chain allowed in one failure burst. Each lap is one logical
	 * retry, so this is the analogue of `settings.retry.maxRetries`.
	 */
	maxCycles: number;
	/**
	 * Consecutive failed hand-backs to the primary before work settles on the
	 * fallback that is actually answering.
	 */
	maxProbes: number;
}

export const DEFAULT_MAX_CYCLES = 10;
export const DEFAULT_MAX_PROBES = 2;

/** The provider and model id the fallback chain is registered under. */
export const FALLBACK_PROVIDER = "fallback";
export const FALLBACK_MODEL_ID = "auto";

/**
 * pi's `api` value for a virtual catalogue entry.
 *
 * Declared here because pi exports `VIRTUAL_MODEL_STATE_ENTRY` but **not**
 * `VIRTUAL_MODEL_API` or `isVirtualModel` from its public surface
 * (`dist/index.d.ts` line 28), while `resolve()` must be able to tell a virtual
 * model from a physical one — returning a virtual one to the router makes pi
 * fail every request. A test reads the literal back out of pi's own
 * `virtual-models.js` so this cannot drift silently.
 */
export const VIRTUAL_MODEL_API = "pi-virtual";

/** `fallback/auto` — what `--model` and `/model` name. */
export const FALLBACK_MODEL_REF = `${FALLBACK_PROVIDER}/${FALLBACK_MODEL_ID}`;

/** The env var a delegated child reads its chain from, when a parent sets one. */
export const CHAIN_ENV = "PI_FALLBACK_CHAIN";

/** The state a session starts from: the primary, no failures yet. */
export function initialState(): FallbackState {
	return { index: 0, cycles: 0, probes: 0, home: 0, probing: false };
}

/**
 * Normalise one model reference.
 *
 * A reference is kept **as written** rather than split into provider and id,
 * because on this repo's litellm gateway a model id contains slashes of its
 * own: `qwen/qwen3.8-27b` is one id under the provider `litellm`, and every
 * `agents/*.md` `model:`/`fallback_models:` key is written in exactly that
 * bare-id form. Splitting on the first slash would read it as provider `qwen`,
 * which does not exist — so resolution is delegated to
 * {@link ChainEntry.ref}'s consumer, which applies pi's own matching rules
 * (canonical `provider/id`, then provider+id, then bare id).
 *
 * A trailing `:level` is rejected rather than stripped: a chain entry names a
 * model, and the thinking level passes through from the selection, so a
 * reference carrying one is a misunderstanding worth reporting.
 *
 * @param ref - A reference such as `qwen/qwen3.8-27b` or `litellm/gpt-4o`.
 * @returns The entry, or `undefined` when `ref` is not a usable reference.
 */
export function parseModelRef(ref: string): ChainEntry | undefined {
	const trimmed = ref.trim();
	if (!trimmed) return undefined;
	// A level belongs to the selection, not to a chain entry.
	if (trimmed.includes(":")) return undefined;
	// A leading or trailing slash names nothing on either side of it.
	if (trimmed.startsWith("/") || trimmed.endsWith("/")) return undefined;
	return { ref: trimmed };
}

/** The reference as written, which is what humans read and pi resolves. */
export function formatModelRef(entry: ChainEntry): string {
	return entry.ref;
}

/**
 * Build a chain from references, dropping unusable and repeated ones.
 *
 * Duplicates are dropped so a fallback that repeats an earlier entry does not
 * buy a second identical attempt — the same rule the subagent launcher applies
 * to `fallback_models` (`subagent-herdr/lib.ts` `candidateModels`).
 *
 * @param refs - References in priority order; the first is the primary.
 * @returns The chain, possibly empty when nothing parsed.
 */
export function parseChain(refs: readonly string[]): ChainEntry[] {
	const out: ChainEntry[] = [];
	const seen = new Set<string>();
	for (const ref of refs) {
		const entry = parseModelRef(ref);
		if (!entry) continue;
		const key = formatModelRef(entry);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(entry);
	}
	return out;
}

/**
 * Parse a chain from a comma- or whitespace-separated env value.
 *
 * This is how a delegated child learns the chain its parent chose for it
 * ({@link CHAIN_ENV}); an unset or unparseable value yields an empty chain,
 * which callers treat as "no chain configured" rather than an error.
 */
export function parseChainEnv(value: string | undefined): ChainEntry[] {
	if (!value) return [];
	return parseChain(value.split(/[,\s]+/));
}

/** Where {@link advance} says the next request should go. */
export type AdvanceResult =
	| {
			kind: "route";
			/** Chain index to use. Always a valid index of the chain. */
			index: number;
			/** State to hand back to pi, or `undefined` to keep the stored state. */
			state: FallbackState | undefined;
			/** Set when this request moved off the model the last one used. */
			hop?: { from: number; to: number; cycles: number };
	  }
	| {
			kind: "exhausted";
			/** Laps completed before giving up. */
			cycles: number;
	  };

export interface AdvanceInput {
	reason: RouteReason;
	/** Number of models in the chain. Must be >= 1. */
	chainLength: number;
	/** State pi carried over, or `undefined` on the first request of a branch. */
	state: FallbackState | undefined;
	config: FallbackConfig;
}

/**
 * Clamp restored state to the current chain.
 *
 * State outlives the configuration that produced it: it is stored on the
 * session branch, so resuming a session after the chain was shortened can
 * hand back an index that no longer exists. Clamping here keeps that a
 * non-event instead of an out-of-range route.
 */
function sanitize(state: FallbackState | undefined, chainLength: number): FallbackState {
	const base = state ?? initialState();
	const last = chainLength - 1;
	const clamp = (n: number) => (Number.isInteger(n) && n >= 0 ? Math.min(n, last) : 0);
	return {
		index: clamp(base.index),
		cycles: Number.isInteger(base.cycles) && base.cycles >= 0 ? base.cycles : 0,
		probes: Number.isInteger(base.probes) && base.probes >= 0 ? base.probes : 0,
		home: clamp(base.home),
		probing: base.probing === true,
	};
}

/** Whether two states differ, so an unchanged state is not re-stored. */
function sameState(a: FallbackState, b: FallbackState): boolean {
	return (
		a.index === b.index &&
		a.cycles === b.cycles &&
		a.probes === b.probes &&
		a.home === b.home &&
		a.probing === b.probing
	);
}

/**
 * Decide which chain index answers the next request.
 *
 * The four reasons are genuinely different events, not shades of one:
 *
 * - `user` — a new human turn. Resets everything, including `home`: the primary
 *   is the model the human selected, so every turn gets a fresh attempt at it.
 *   The cost of a dead primary is bounded at one failed request per turn.
 * - `continuation` — the previous request succeeded. If a fallback answered it,
 *   the next request hands back to `home` and is marked `probing`. A success at
 *   `home` clears `probes`: the primary is healthy again.
 * - `retry` — the previous request failed. Step to the next model; wrapping past
 *   the end completes a lap and spends one logical retry. A failure while
 *   `probing` is a failed probe, and enough of them move `home` onto the model
 *   that is actually answering.
 * - `direct` — a request outside the agent loop (compaction summary, an
 *   extension's own model call). Routed to `home` and never allowed to mutate
 *   state, because pi discards state for `direct` anyway and letting a
 *   summarization failure spend the conversation's retry budget would make the
 *   budget mean two different things.
 *
 * @param input - Reason, chain length, carried state, and tunables.
 * @returns A route, or `exhausted` when the logical retry budget is spent.
 */
export function advance(input: AdvanceInput): AdvanceResult {
	const { reason, chainLength, config } = input;
	if (chainLength < 1) throw new Error("advance() needs a chain of at least one model.");
	const prior = sanitize(input.state, chainLength);

	const settle = (next: FallbackState, from: number): AdvanceResult => ({
		kind: "route",
		index: next.index,
		state: sameState(prior, next) ? undefined : next,
		...(next.index === from ? {} : { hop: { from, to: next.index, cycles: next.cycles } }),
	});

	if (reason === "direct") {
		// Deliberately no state: see the `direct` note above.
		return { kind: "route", index: prior.home, state: undefined };
	}

	if (reason === "user") {
		return settle(initialState(), prior.index);
	}

	if (reason === "continuation") {
		if (prior.index !== prior.home) {
			// A fallback answered. Hand the next request back to the primary —
			// "try the original model against the new response".
			return settle(
				{ index: prior.home, cycles: 0, probes: prior.probes, home: prior.home, probing: true },
				prior.index,
			);
		}
		// `home` answered: the burst is over and the primary is trusted again.
		return settle(
			{ index: prior.index, cycles: 0, probes: 0, home: prior.home, probing: false },
			prior.index,
		);
	}

	// reason === "retry": the request from `prior.index` failed.
	//
	// A non-positive budget means "no laps allowed", so it must exhaust rather
	// than route — the wrap check below only fires when the chain actually wraps,
	// so on a multi-model chain `maxCycles: 0` would otherwise walk to the end of
	// the chain before noticing. `readConfig` already coerces 0 to the default, so
	// this is unreachable from settings; it is here because the alternative to a
	// cheap guard is an unbounded loop reachable by any future caller.
	if (config.maxCycles < 1) return { kind: "exhausted", cycles: prior.cycles };

	let probes = prior.probes;
	let home = prior.home;
	let cycles = prior.cycles;
	let index = prior.index + 1;
	if (index >= chainLength) {
		// A wrap completes a lap. The *first* lap runs at `cycles === 0`, so the
		// budget is spent once `cycles` reaches `maxCycles` — not once it exceeds
		// it. `>` allowed `maxCycles + 1` laps, which made the arithmetic in
		// {@link requiredPhysicalRetries} understate the physical retries needed by
		// one whole lap (measured: `maxCycles: 2` on a 2-model chain walked the
		// chain 3 times and wanted 6 retries where the formula promised 4).
		if (prior.cycles + 1 >= config.maxCycles) {
			return { kind: "exhausted", cycles: prior.cycles + 1 };
		}
		index = 0;
		cycles += 1;
	}

	if (prior.probing) {
		probes += 1;
		if (probes >= config.maxProbes && index !== prior.home) {
			// The primary has refused the work repeatedly. Stop offering it every
			// turn and let the model that answers own the session.
			home = index;
			probes = 0;
		}
	}

	return settle({ index, cycles, probes, home, probing: false }, prior.index);
}

/**
 * `settings.retry.maxRetries` needed for `maxCycles` laps to be reachable.
 *
 * pi spends one of its own retries per failed request, so a lap of an L-model
 * chain costs L. A setting below this silently truncates the logical budget:
 * pi stops retrying mid-lap and the later models in the chain are never tried.
 */
export function requiredPhysicalRetries(chainLength: number, maxCycles: number): number {
	return Math.max(0, chainLength) * Math.max(0, maxCycles);
}

/**
 * The warning for a physical retry budget too small for the configured laps.
 *
 * Returns `undefined` when the budget is sufficient, so the caller can treat
 * "nothing to say" and "here is what to say" as the same shape.
 */
export function describeBudgetShortfall(
	chainLength: number,
	maxCycles: number,
	physicalMaxRetries: number,
): string | undefined {
	const required = requiredPhysicalRetries(chainLength, maxCycles);
	if (physicalMaxRetries >= required) return undefined;
	const reachable = Math.floor(physicalMaxRetries / Math.max(1, chainLength));
	return (
		`model-fallback: settings.retry.maxRetries is ${physicalMaxRetries}, but ${required} ` +
		`(${chainLength} models x ${maxCycles} cycles) is needed for the configured budget. ` +
		`Only ${reachable} full cycle(s) are reachable.`
	);
}

/** Marker that identifies this module's own exhaustion text. */
export const EXHAUSTION_MARKER = "model-fallback: chain exhausted";

/**
 * Whether an error string is one this module already produced.
 *
 * Needed because the exhaustion text is reported *as an assistant error*, so
 * the next failure's `lastError` would otherwise be the previous exhaustion
 * message — and the text nests one copy deeper per lap. Measured: three laps
 * produced three nested "Every model failed" blocks before this check existed.
 */
export function isOwnError(error: string | undefined): boolean {
	return !!error && error.includes(EXHAUSTION_MARKER);
}

/**
 * Substrings that make pi treat a message as retryable.
 *
 * A deliberate, small mirror of `RETRYABLE_PROVIDER_ERROR_PATTERN`
 * (`pi-ai/utils/retry.js`) used only to *reject* a fallthrough tag, never to
 * classify. The copy is safe because the `exhaustion messages are never
 * themselves retryable` suite asserts against pi's real classifier: if pi adds
 * a pattern this list misses, that test fails rather than the chain quietly
 * looping forever.
 */
const RETRY_KEYWORDS = [
	"overload",
	"demand",
	"rate",
	"limit",
	"many",
	"request",
	"unavail",
	"server",
	"internal",
	"error",
	"network",
	"connect",
	"refus",
	"lost",
	"closed",
	"fetch",
	"getaddrinfo",
	"notfound",
	"eai_again",
	"upstream",
	"reset",
	"socket",
	"hang",
	"time",
	"terminat",
	"websocket",
	"ended",
	"stream",
	"http2",
	"retry",
	"resourceexhausted",
	"subscription_sharing",
	"buffer",
	"provider",
];

/**
 * Render a model reference so it cannot make the message look retryable.
 *
 * A reference is printed for a human to read, so it is kept legible: only the
 * substrings that would trip pi's classifier are neutralised, by inserting a
 * zero-width-free marker (`·`) that breaks the match without hiding a
 * character. Digit runs that look like an HTTP status get the same treatment.
 *
 * This is not hypothetical paranoia: a chain entry named `timeout/model` or
 * `503/z` produced an exhaustion message pi then retried forever. The names in
 * this repo are all safe, which is exactly why it would have gone unnoticed
 * until someone added a model whose name happened to contain one of ~30 words.
 */
export function sanitizeModelRef(ref: string): string {
	let out = ref;
	// Longest-first so `connection` is handled before `connect`.
	for (const keyword of [...RETRY_KEYWORDS].sort((a, b) => b.length - a.length)) {
		const pattern = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
		out = out.replace(pattern, (m) => `${m[0]}·${m.slice(1)}`);
	}
	// Digit runs are chunked into PAIRS, which is provably sufficient and far more
	// readable than separating every digit.
	//
	// Why pairs are enough: every numeric atom in pi's
	// `RETRYABLE_PROVIDER_ERROR_PATTERN` is exactly **three** digits (`429`, `500`,
	// `502`, `503`, `504`, `520`, `524` — extracted from the live regex source and
	// pinned by a test), and pi matches them as **raw substrings with no word
	// boundary**. No run of two digits can contain a three-digit atom, so once
	// every run is ≤ 2 digits long the message cannot match on a number.
	//
	// Why not break only the first digit, which is what this did: the *tail* stayed
	// intact, so `20250520` became `2·0250520` — still containing `520`. That is not
	// a contrived name; pi's own resolver keys model aliasing on `/-\d{8}$/`
	// (`model-resolver.js` `isAlias`), making dated snapshot ids the convention for
	// Anthropic and OpenAI models, so pinning `claude-4-sonnet-20250520` in a chain
	// made exhaustion retryable and the budget unspendable. Found by review after
	// the keyword vector was already closed.
	return breakDigitRuns(out);
}

/**
 * Chunk every run of 3+ digits into pairs separated by `·`.
 *
 * Runs of one or two digits are left alone: they cannot contain a three-digit
 * atom, so they are already safe, and a model called `claude-4` should still
 * read as `claude-4`.
 */
function breakDigitRuns(text: string): string {
	return text.replace(/\d{3,}/g, (run) => (run.match(/\d{1,2}/g) ?? []).join("·"));
}

/** Words for small counts, so a cycle count never prints as `503`. */
const NUMBER_WORDS = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
	"nine",
	"ten",
];

/**
 * A count rendered so it cannot be mistaken for an HTTP status.
 *
 * Small counts — every realistic `maxCycles` — become words; anything larger
 * gets its digits broken, because a literal `503` or `429` anywhere in the
 * message is enough for pi to retry it.
 */
export function spellNumber(n: number): string {
	if (Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length) return NUMBER_WORDS[n]!;
	// Same pair-chunking rule as {@link sanitizeModelRef}, and for the same reason:
	// a first-digit-only break left `1429` as `1·429`, whose tail pi still matches.
	return breakDigitRuns(String(n));
}

/**
 * The error for a request where no chain entry is reachable at all.
 *
 * A second error path, and therefore a second instance of the same trap: it
 * prints the chain, so it needs {@link sanitizeModelRef} for exactly the reason
 * {@link describeExhaustion} does. Attacking it found 6 of 7 hostile refs made
 * it retryable while it lived as an inline template in `index.ts` — which is
 * the argument for the message living here, beside its test, rather than at the
 * throw site.
 *
 * Distinct from exhaustion on purpose: nothing was *tried*, so the remedy is to
 * fix the chain or the credentials, not to wait for a provider to recover.
 */
export function describeNoneAvailable(chain: readonly ChainEntry[]): string {
	const listed = chain.map((e) => `  - ${sanitizeModelRef(formatModelRef(e))}`).join("\n");
	return (
		`${NONE_AVAILABLE_MARKER}: no model in the chain is reachable. Check the names in ` +
		`settings.modelFallback.chain and that each one's credentials are configured.\n${listed}`
	);
}

/** Marker for {@link describeNoneAvailable}, so it is recognisable in a log. */
export const NONE_AVAILABLE_MARKER = "model-fallback: chain unreachable";

/**
 * The error text for a burst that spent every lap.
 *
 * Names every model in the chain and the last provider error, because "the
 * model failed" on its own cannot distinguish one dead provider from a gateway
 * that is down for all of them — and those have different fixes.
 *
 * ## Why the wording is deliberately flat
 *
 * pi decides whether to retry by **regex over the error text**
 * (`pi-ai/utils/retry.js` `RETRYABLE_PROVIDER_ERROR_PATTERN`), which matches
 * things like `connection.?error`, `timeout` and `503`. Quoting the provider's
 * error verbatim therefore made this message itself look retryable, and pi
 * lapped the chain forever instead of stopping — a budget that cannot be
 * spent is not a budget. The provider error is summarised through
 * {@link sanitizeProviderError} so the cause is still legible while the
 * message as a whole reads as terminal.
 *
 * The **model names are a vector too**, which an attack on this function found
 * after the provider-error path was already sealed: a chain entry is printed
 * verbatim, so a model called `timeout/foo` or `503/bar` put a retry keyword in
 * the message by itself. Entries therefore go through
 * {@link sanitizeModelRef}. A name is not attacker-controlled here, but it is
 * *human*-controlled, and a chain whose exhaustion silently became unspendable
 * because of how a model was named is a trap worth closing.
 */
export function describeExhaustion(
	chain: readonly ChainEntry[],
	cycles: number,
	lastError: string | undefined,
): string {
	const tried = chain.map((e) => `  - ${sanitizeModelRef(formatModelRef(e))}`).join("\n");
	// Spelled out rather than printed as a number: a count of 503 or 429 models
	// is absurd, but the regex does not know that.
	const laps = cycles === 1 ? "1 cycle" : `${spellNumber(cycles)} cycles`;
	return (
		`${EXHAUSTION_MARKER} after ${laps}. Every model below refused the request:\n${tried}\n` +
		`Cause: ${sanitizeProviderError(lastError)}`
	);
}

/**
 * Reduce a provider error to a short, non-retryable-looking summary.
 *
 * The words pi's retry classifier matches on are replaced rather than removed,
 * so a human still learns what happened while the enclosing message does not
 * re-trigger the retry it is reporting the end of. Replacement is one-way on
 * purpose: this text is for a person, not for re-parsing.
 */
export function sanitizeProviderError(error: string | undefined): string {
	if (!error) return "unknown";
	if (isOwnError(error)) return "every model in the chain failed";
	const firstLine = error.split("\n")[0]!.trim().slice(0, 200);
	if (!firstLine) return "unknown";
	// Classified, not rewritten: the original text is summarised into a category
	// so no retry keyword survives, instead of character-substituting the words
	// (which produced unreadable output and broke the moment pi added a pattern).
	const category = classifyProviderError(firstLine);
	return category ?? `provider reported a failure (${describeShape(firstLine)})`;
}

/**
 * Map a provider error to a short category, when one is recognisable.
 *
 * The categories cover what this gateway and its upstreams actually emit; an
 * unrecognised error falls through to {@link describeShape} rather than being
 * quoted, because quoting is what made the message retryable.
 */
function classifyProviderError(line: string): string | undefined {
	const l = line.toLowerCase();
	// Each phrase is checked against pi's own classifier by
	// `exhaustion messages are never themselves retryable` in lib.test.ts, which
	// imports `isRetryableAssistantError` rather than restating its patterns —
	// so a phrase that accidentally contains a retry keyword fails the suite
	// instead of silently making the chain loop forever.
	if (/\b5\d\d\b/.test(l) || /server.?error|internal.?error/.test(l)) {
		return "the provider failed on its own side";
	}
	if (/\b429\b|rate.?limit|too many requests|resourceexhausted/.test(l)) {
		return "the provider throttled this account";
	}
	if (/overloaded|high demand|unavailable/.test(l)) return "the provider had no capacity";
	if (/timed? ?out|timeout/.test(l)) return "the provider never answered in time";
	if (/connection|network|socket|fetch failed|econnrefused|enotfound|eai_again/.test(l)) {
		return "the request could not reach the provider";
	}
	if (/quota|billing|budget|insufficient/.test(l)) {
		return "the account has no remaining quota or credit";
	}
	if (/\b4\d\d\b|invalid|unexpected|unsupported|malformed/.test(l)) {
		return "the provider rejected the request as invalid";
	}
	if (/terminated|stream ended|did not get a response|upstream|reset before headers|websocket/.test(l)) {
		return "the response stream broke before it finished";
	}
	return undefined;
}

/**
 * A keyword-free description of an unrecognised error, for the fallthrough.
 *
 * Reports length and the leading token only, which is enough to tell two
 * different unknown failures apart in a transcript without reproducing text
 * whose wording decides whether pi retries. A token that itself looks retryable
 * is dropped rather than printed — `terminated` arriving as a whole error is
 * exactly the case that proved this necessary.
 */
function describeShape(line: string): string {
	const head = line.split(/[\s:]+/)[0]?.replace(/[^A-Za-z0-9_.-]/g, "") ?? "";
	const candidate = head.slice(0, 24);
	const lower = candidate.toLowerCase();
	const safe =
		candidate.length > 0 &&
		!/\d{3}/.test(candidate) &&
		!RETRY_KEYWORDS.some((keyword) => lower.includes(keyword));
	return `${safe ? candidate : "unlabelled"}, ${line.length} chars`;
}

/**
 * The one-line notice for a hop, for the transcript or the status line.
 *
 * @param from - Chain entry that failed, when known.
 * @param to - Chain entry taking over.
 * @param cycles - Laps completed so far, so a second lap is visible as one.
 */
export function describeHop(
	from: ChainEntry | undefined,
	to: ChainEntry,
	cycles: number,
): string {
	const lap = cycles > 0 ? ` (cycle ${cycles + 1})` : "";
	if (!from) return `model-fallback: routing to ${formatModelRef(to)}${lap}`;
	return `model-fallback: ${formatModelRef(from)} failed, routing to ${formatModelRef(to)}${lap}`;
}

/** Read {@link FallbackConfig} from a loosely-typed settings blob. */
export function readConfig(raw: unknown): FallbackConfig {
	const obj = (raw ?? {}) as Record<string, unknown>;
	const positive = (value: unknown, fallback: number) =>
		typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
	return {
		maxCycles: positive(obj.maxCycles, DEFAULT_MAX_CYCLES),
		maxProbes: positive(obj.maxProbes, DEFAULT_MAX_PROBES),
	};
}

/**
 * Read the chain from a settings blob.
 *
 * Accepts `chain: ["provider/id", ...]`, and also a bare array at the key so
 * `modelFallback: ["a/b", "c/d"]` means what it looks like. Anything else
 * yields an empty chain, which the caller reads as "not configured".
 */
export function readChain(raw: unknown): ChainEntry[] {
	if (Array.isArray(raw)) return parseChain(raw.filter((v): v is string => typeof v === "string"));
	const obj = (raw ?? {}) as Record<string, unknown>;
	const chain = obj.chain;
	if (Array.isArray(chain)) {
		return parseChain(chain.filter((v): v is string => typeof v === "string"));
	}
	return [];
}

/** Whether the feature is switched off explicitly in settings. */
export function isDisabled(raw: unknown): boolean {
	if (Array.isArray(raw) || raw == null) return false;
	return (raw as Record<string, unknown>).enabled === false;
}

/**
 * Optional pre-first-response limits, from `contextWindow`/`maxTokens`.
 *
 * Returned as a partial object so the caller can spread it: an absent key must
 * stay absent rather than become `0`, since the two mean the same thing to pi
 * but only one of them is a claim this module is making.
 *
 * These cannot be derived from the chain: the model catalogue is not readable
 * at extension load time, which is when the virtual model is registered. They
 * only affect the context-usage readout before the first response — compaction
 * reads the physical model that answered — so they are opt-in.
 */
export function readLimits(raw: unknown): { contextWindow?: number; maxTokens?: number } {
	if (Array.isArray(raw) || raw == null) return {};
	const obj = raw as Record<string, unknown>;
	const positive = (value: unknown): number | undefined =>
		typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
	const contextWindow = positive(obj.contextWindow);
	const maxTokens = positive(obj.maxTokens);
	return {
		...(contextWindow === undefined ? {} : { contextWindow }),
		...(maxTokens === undefined ? {} : { maxTokens }),
	};
}
