/**
 * Tests for the fallback-chain state machine.
 *
 * The behavioural claims worth pinning are the ones a careless refactor would
 * break silently: that a lap costs one retry rather than L, that a fallback
 * hands the next request back to the primary, that a dead primary stops being
 * probed forever, and that `direct` requests never spend the budget.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
// pi's own retry classifier. Imported rather than reimplemented so the
// "never retryable" invariant is checked against the real patterns.
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import {
	type ChainEntry,
	type FallbackConfig,
	type FallbackState,
	type RouteReason,
	advance,
	describeBudgetShortfall,
	describeExhaustion,
	describeHop,
	describeNoneAvailable,
	formatChainItem,
	formatEntry,
	formatModelRef,
	initialState,
	isDisabled,
	isOwnError,
	isRoutable,
	isThinkingLevel,
	levelFor,
	parseChain,
	parseChainEnv,
	parseChainItem,
	parseModelEntry,
	parseModelRef,
	readChain,
	readConfig,
	readLimits,
	THINKING_LEVELS,
	VIRTUAL_MODEL_API,
	requiredPhysicalRetries,
	sanitizeModelRef,
	sanitizeProviderError,
	spellNumber,
} from "./lib.ts";

const CONFIG: FallbackConfig = { maxCycles: 10, maxProbes: 2 };

/** Drive one step and return the state pi would carry next. */
function step(
	reason: RouteReason,
	state: FallbackState | undefined,
	chainLength: number,
	config: FallbackConfig = CONFIG,
): { index: number; state: FallbackState } {
	const result = advance({ reason, chainLength, state, config });
	if (result.kind !== "route") throw new Error(`expected a route, got ${result.kind}`);
	return { index: result.index, state: result.state ?? state ?? initialState() };
}

// ---------------------------------------------------------------------------
// parseModelRef / parseChain

describe("parseModelRef", () => {
	test("keeps a slashed model id whole, because that is one litellm id", () => {
		// `qwen/qwen3.8-27b` is the ID of a single litellm model, and the form
		// every agents/*.md uses. Splitting it would invent a provider `qwen`.
		expect(parseModelRef("qwen/qwen3.8-27b")).toEqual({ ref: "qwen/qwen3.8-27b" });
	});

	test("keeps a canonical provider/id whole too", () => {
		expect(parseModelRef("litellm/anthropic/claude-opus-5")).toEqual({
			ref: "litellm/anthropic/claude-opus-5",
		});
	});

	test("trims surrounding whitespace", () => {
		expect(parseModelRef("  litellm/a  ")).toEqual({ ref: "litellm/a" });
	});

	test("accepts a reference with no slash, which pi resolves as a bare id", () => {
		// pi's resolver matches a bare id across providers, so refusing one here
		// would reject a reference pi itself accepts.
		expect(parseModelRef("gpt-4o")).toEqual({ ref: "gpt-4o" });
	});

	test("rejects a leading or trailing slash", () => {
		expect(parseModelRef("/model")).toBeUndefined();
		expect(parseModelRef("provider/")).toBeUndefined();
	});

	test("rejects the empty string", () => {
		expect(parseModelRef("")).toBeUndefined();
		expect(parseModelRef("   ")).toBeUndefined();
	});

	test("rejects a trailing thinking level rather than stripping it", () => {
		// A `:level` suffix on a string has no home — the object form is where a
		// pinned level lives — so a string carrying one is a misunderstanding.
		expect(parseModelRef("litellm/qwen:high")).toBeUndefined();
	});

	test("rejects the transport separators — comma and internal whitespace", () => {
		// A comma is the list/env separator and a space the env token separator,
		// so a ref carrying either would be split by `parseChainEnv` and the
		// `join(",")` round-trip would be lossy. Both are rejected up front.
		expect(parseModelRef("vendor/model,variant")).toBeUndefined();
		expect(parseModelRef("vendor/model variant")).toBeUndefined();
	});
});

describe("parseModelEntry", () => {
	test("a string is parsed with the bare-reference grammar", () => {
		expect(parseModelEntry("qwen/qwen3.8-27b")).toEqual({ ref: "qwen/qwen3.8-27b" });
		// A ref with a `:level` suffix is rejected in both forms.
		expect(parseModelEntry("litellm/qwen:high")).toBeUndefined();
	});

	test("an object pins a valid thinking level, trimming the model like a string", () => {
		expect(parseModelEntry({ model: "  anthropic/claude-opus-5  ", thinking: "low" })).toEqual({
			ref: "anthropic/claude-opus-5",
			thinking: "low",
		});
	});

	test("accepts each of the seven levels exactly", () => {
		for (const level of THINKING_LEVELS) {
			expect(parseModelEntry({ model: "a/1", thinking: level })).toEqual({
				ref: "a/1",
				thinking: level,
			});
		}
	});

	test("an object without thinking pins nothing, so the selection passes through", () => {
		const entry = parseModelEntry({ model: "a/1" });
		expect(entry).toEqual({ ref: "a/1" });
		expect("thinking" in (entry ?? {})).toBe(false);
	});

	test("an invalid level is dropped, keeping the clearly intended model", () => {
		// The reference is the intent; the selection's level is the honest
		// fallback, which is what the bare-string form already does.
		for (const thinking of ["ultra", "HIGH", "Low", "low ", "", 7, true, null, ["low"], { low: 1 }]) {
			expect(parseModelEntry({ model: "a/1", thinking })).toEqual({ ref: "a/1" });
		}
	});

	test("rejects an object whose model is missing or not a usable reference", () => {
		expect(parseModelEntry({})).toBeUndefined();
		expect(parseModelEntry({ thinking: "low" })).toBeUndefined();
		expect(parseModelEntry({ model: 7 })).toBeUndefined();
		expect(parseModelEntry({ model: "" })).toBeUndefined();
		expect(parseModelEntry({ model: "/leading" })).toBeUndefined();
		expect(parseModelEntry({ model: "a/1:high" })).toBeUndefined();
	});

	test("ignores properties other than model and thinking", () => {
		expect(parseModelEntry({ model: "a/1", thinking: "high", whatever: 1 })).toEqual({
			ref: "a/1",
			thinking: "high",
		});
	});

	test("rejects values that are neither strings nor objects", () => {
		expect(parseModelEntry(7)).toBeUndefined();
		expect(parseModelEntry(null)).toBeUndefined();
		expect(parseModelEntry(["a/1"])).toBeUndefined();
	});
});
describe("parseChainItem", () => {
	test("a bare item is parsed with the bare-reference grammar", () => {
		expect(parseChainItem("qwen/qwen3.8-27b")).toEqual({ ref: "qwen/qwen3.8-27b" });
	});

	test("trims surrounding whitespace", () => {
		expect(parseChainItem("  a/1  ")).toEqual({ ref: "a/1" });
	});

	test("pins each of the seven valid levels exactly", () => {
		for (const level of THINKING_LEVELS) {
			expect(parseChainItem(`a/1|${level}`)).toEqual({ ref: "a/1", thinking: level });
		}
	});

	test("splits at the first | only: a later | makes the suffix invalid", () => {
		// `low|high` is not a level, so the pin is dropped and the model kept.
		expect(parseChainItem("a/1|low|high")).toEqual({ ref: "a/1" });
	});

	test("an invalid level drops the pin but keeps the model", () => {
		for (const bad of ["ultra", "HIGH", "Low", "", " 7", "true"]) {
			expect(parseChainItem(`a/1|${bad}`)).toEqual({ ref: "a/1" });
		}
	});

	test("a level with internal whitespace pins nothing: the compact form is the grammar", () => {
		expect(parseChainItem("a/1| high")).toEqual({ ref: "a/1" });
	});

	test("a :level suffix in the ref part is rejected, because the ref grammar owns it", () => {
		expect(parseChainItem("a/1:low|high")).toBeUndefined();
	});

	test("rejects items whose ref part names nothing", () => {
		expect(parseChainItem("")).toBeUndefined();
		expect(parseChainItem("   ")).toBeUndefined();
		expect(parseChainItem("|high")).toBeUndefined();
		expect(parseChainItem("/|high")).toBeUndefined();
		expect(parseChainItem("provider/|high")).toBeUndefined();
	});
});

describe("parseChain", () => {
	test("keeps declaration order", () => {
		expect(parseChain(["a/1", "b/2", "c/3"]).map(formatModelRef)).toEqual(["a/1", "b/2", "c/3"]);
	});

	test("drops duplicates, keeping the first position", () => {
		expect(parseChain(["a/1", "b/2", "a/1"]).map(formatModelRef)).toEqual(["a/1", "b/2"]);
	});

	test("drops unparseable entries instead of failing the whole chain", () => {
		// Empty strings and level-carrying refs are unusable; a bare id is not.
		expect(parseChain(["a/1", "x:high", "", "b/2"]).map(formatModelRef)).toEqual(["a/1", "b/2"]);
	});

	test("yields an empty chain when nothing parses", () => {
		expect(parseChain(["x:high", "", "/leading", "trailing/"])).toEqual([]);
	});
	test("parses a mix of strings and objects, keeping declaration order", () => {
		expect(parseChain(["a/1", { model: "b/2", thinking: "low" }, "c/3"])).toEqual([
			{ ref: "a/1" },
			{ ref: "b/2", thinking: "low" },
			{ ref: "c/3" },
		]);
	});

	test("dedupes by model reference, so two levels on one model are one entry", () => {
		const first = parseChain(["a/1", { model: "a/1", thinking: "high" }]);
		expect(first).toEqual([{ ref: "a/1" }]);
		// First occurrence wins in either order.
		const flipped = parseChain([{ model: "a/1", thinking: "high" }, "a/1"]);
		expect(flipped).toEqual([{ ref: "a/1", thinking: "high" }]);
	});

	test("dedup is case-insensitive, because resolution matches case-insensitively", () => {
		// `a/1` and `A/1` resolve to the same physical model, so they are one
		// entry — and the level on the dropped copy does not survive.
		expect(parseChain(["a/1", { model: "A/1", thinking: "high" }])).toEqual([
			{ ref: "a/1" },
		]);
	});

	test("drops malformed objects without discarding their neighbours", () => {
		expect(
			parseChain([7, { thinking: "low" }, null, "a/1", ["b/2"]]).map(formatModelRef),
		).toEqual(["a/1"]);
	});

});

describe("parseChainEnv", () => {
	test("splits on commas", () => {
		expect(parseChainEnv("a/1,b/2").map(formatModelRef)).toEqual(["a/1", "b/2"]);
	});

	test("splits on whitespace and tolerates padding", () => {
		expect(parseChainEnv("a/1, b/2  c/3").map(formatModelRef)).toEqual(["a/1", "b/2", "c/3"]);
	});

	test("an unset value is an empty chain, not an error", () => {
		expect(parseChainEnv(undefined)).toEqual([]);
		expect(parseChainEnv("")).toEqual([]);
	});

	test("entries may pin a level with the ref|level item form", () => {
		// The same item syntax an agent file's model:/fallback_models: uses —
		// that is what keeps the two surfaces interchangeable.
		expect(parseChainEnv("a/1,b/2|low")).toEqual([
			{ ref: "a/1" },
			{ ref: "b/2", thinking: "low" },
		]);
	});

	test("dedup is by ref, case-insensitively, first occurrence winning — pin or no pin", () => {
		expect(parseChainEnv("a/1,A/1|high")).toEqual([{ ref: "a/1" }]);
		expect(parseChainEnv("A/1|high,a/1")).toEqual([{ ref: "A/1", thinking: "high" }]);
	});

	test("an invalid pin degrades to the bare model, matching the object form", () => {
		expect(parseChainEnv("a/1|ultra")).toEqual([{ ref: "a/1" }]);
	});
});

describe("isRoutable", () => {
	test("an empty chain is not routable", () => {
		expect(isRoutable([])).toBe(false);
	});

	test("one unpinned entry is not routable: nothing to hop to, no pin to apply", () => {
		expect(isRoutable([{ ref: "a/1" }])).toBe(false);
	});

	test("one pinned entry IS routable: only the router applies a pin", () => {
		expect(isRoutable([{ ref: "a/1", thinking: "high" }])).toBe(true);
		expect(isRoutable([{ ref: "a/1", thinking: "off" }])).toBe(true);
	});

	test("two or more entries are routable, pin or no pin", () => {
		expect(isRoutable([{ ref: "a/1" }, { ref: "b/2" }])).toBe(true);
		expect(isRoutable([{ ref: "a/1", thinking: "low" }, { ref: "b/2" }])).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The core rule: an error hops, and a lap costs one retry

describe("advance: a user turn", () => {
	test("starts at the primary", () => {
		expect(step("user", undefined, 3).index).toBe(0);
	});

	test("resets a mid-burst state so every turn retries the primary", () => {
		const mid: FallbackState = { index: 2, cycles: 4, probes: 1, home: 2, probing: true };
		const { index, state } = step("user", mid, 3);
		expect(index).toBe(0);
		expect(state).toEqual(initialState());
	});
});

describe("advance: retry hops to the next model", () => {
	test("a failure at the primary routes the retry to the first fallback", () => {
		const { index, state } = step("retry", initialState(), 3);
		expect(index).toBe(1);
		expect(state.cycles).toBe(0);
	});

	test("consecutive failures walk the chain in order", () => {
		let s = initialState();
		const seen: number[] = [];
		for (let i = 0; i < 2; i++) {
			const r = step("retry", s, 3);
			seen.push(r.index);
			s = r.state;
		}
		expect(seen).toEqual([1, 2]);
	});

	test("reports the hop so the move is visible rather than silent", () => {
		const result = advance({ reason: "retry", chainLength: 3, state: initialState(), config: CONFIG });
		expect(result.kind).toBe("route");
		if (result.kind !== "route") return;
		expect(result.hop).toEqual({ from: 0, to: 1, cycles: 0 });
	});

	test("a full lap of the chain counts as exactly one cycle", () => {
		// This is the headline rule: cycling the whole chain is ONE retry, not L.
		let s = initialState();
		for (let i = 0; i < 3; i++) s = step("retry", s, 3).state;
		expect(s.index).toBe(0);
		expect(s.cycles).toBe(1);
	});

	test("a second lap counts as a second cycle", () => {
		let s = initialState();
		for (let i = 0; i < 6; i++) s = step("retry", s, 3).state;
		expect(s.index).toBe(0);
		expect(s.cycles).toBe(2);
	});

	test("a single-model chain still advances, spending one cycle per failure", () => {
		// Degenerate but legal: with no fallbacks the feature reduces to pi's
		// own retry, and the budget must still be spent so it can run out.
		const { index, state } = step("retry", initialState(), 1);
		expect(index).toBe(0);
		expect(state.cycles).toBe(1);
	});
});

describe("advance: the hand-back to the primary", () => {
	test("a continuation after a fallback answered returns to the primary", () => {
		// "then after that try the original model against the new response".
		const afterFallback: FallbackState = { index: 1, cycles: 0, probes: 0, home: 0, probing: false };
		const { index, state } = step("continuation", afterFallback, 3);
		expect(index).toBe(0);
		expect(state.probing).toBe(true);
	});

	test("the hand-back clears the cycle count so the next burst is fresh", () => {
		const afterFallback: FallbackState = { index: 2, cycles: 3, probes: 0, home: 0, probing: false };
		expect(step("continuation", afterFallback, 3).state.cycles).toBe(0);
	});

	test("a continuation while already at home keeps the model and clears probes", () => {
		const atHome: FallbackState = { index: 0, cycles: 2, probes: 1, home: 0, probing: true };
		const { index, state } = step("continuation", atHome, 3);
		expect(index).toBe(0);
		expect(state.probes).toBe(0);
		expect(state.probing).toBe(false);
		expect(state.cycles).toBe(0);
	});

	test("no hop is reported when the model does not change", () => {
		const atHome: FallbackState = { index: 0, cycles: 0, probes: 0, home: 0, probing: false };
		const result = advance({ reason: "continuation", chainLength: 3, state: atHome, config: CONFIG });
		if (result.kind !== "route") throw new Error("expected a route");
		expect(result.hop).toBeUndefined();
	});

	test("the full cycle: primary fails, fallback answers, primary gets the next request", () => {
		let s = initialState();
		expect(step("retry", s, 3).index).toBe(1); // primary failed -> fallback
		s = step("retry", s, 3).state;
		const back = step("continuation", s, 3); // fallback answered -> primary
		expect(back.index).toBe(0);
	});
});

describe("advance: a primary that stays dead", () => {
	test("maxProbes failed hand-backs move home onto the answering model", () => {
		const config: FallbackConfig = { maxCycles: 10, maxProbes: 2 };
		let s = initialState();
		// Burst 1: primary fails, fallback answers, hand back to primary.
		s = step("retry", s, 2, config).state;
		s = step("continuation", s, 2, config).state;
		expect(s.probing).toBe(true);
		// Probe 1 fails.
		s = step("retry", s, 2, config).state;
		expect(s.probes).toBe(1);
		expect(s.home).toBe(0);
		// The fallback answers, hand back again.
		s = step("continuation", s, 2, config).state;
		// Probe 2 fails: home moves to the model that is actually answering.
		s = step("retry", s, 2, config).state;
		expect(s.home).toBe(1);
		expect(s.probes).toBe(0);
	});

	test("once home has moved, a continuation stops handing back to the dead primary", () => {
		const settled: FallbackState = { index: 1, cycles: 0, probes: 0, home: 1, probing: false };
		const { index, state } = step("continuation", settled, 2);
		expect(index).toBe(1);
		expect(state.probing).toBe(false);
	});

	test("a new user turn re-tries the primary even after home moved", () => {
		// A dead provider usually comes back. Bounding the cost at one failed
		// request per turn is cheaper than never noticing the recovery.
		const settled: FallbackState = { index: 1, cycles: 0, probes: 0, home: 1, probing: true };
		expect(step("user", settled, 2).index).toBe(0);
		expect(step("user", settled, 2).state.home).toBe(0);
	});

	test("a probe failure that lands back on home does not move home", () => {
		// Single-model chain: the retry wraps to index 0, which IS home, so
		// there is nowhere better to settle.
		const probing: FallbackState = { index: 0, cycles: 0, probes: 1, home: 0, probing: true };
		const { state } = step("retry", probing, 1, { maxCycles: 10, maxProbes: 2 });
		expect(state.home).toBe(0);
	});
});

describe("advance: the logical budget", () => {
	/**
	 * Drive retries until exhaustion, counting the failed requests it took.
	 *
	 * Counting *requests* rather than asserting on `cycles` is the point: pi
	 * spends one of its own retries per failed request, so this number is what
	 * has to fit inside `settings.retry.maxRetries`.
	 */
	function runToExhaustion(chainLength: number, config: FallbackConfig) {
		let state: FallbackState | undefined = initialState();
		// The request that started the burst already failed before the first retry.
		let failedRequests = 1;
		for (let guard = 0; guard < 10_000; guard++) {
			const result = advance({ reason: "retry", chainLength, state, config });
			if (result.kind === "exhausted") return { failedRequests, cycles: result.cycles };
			state = result.state ?? state;
			failedRequests++;
		}
		throw new Error("advance() never exhausted: the chain would lap forever");
	}

	test("walks the chain exactly maxCycles times", () => {
		// `cycles` counts completed wraps, so the FIRST lap runs at cycles === 0.
		// Exhausting on `cycles > maxCycles` therefore allowed maxCycles + 1 laps:
		// measured, maxCycles 2 on a 2-model chain walked it 3 times and spent 6
		// retries where requiredPhysicalRetries promised 4.
		const { failedRequests, cycles } = runToExhaustion(2, { maxCycles: 2, maxProbes: 2 });
		expect(cycles).toBe(2);
		expect(failedRequests).toBe(4);
	});

	test("maxCycles of 1 allows exactly one lap", () => {
		const { failedRequests, cycles } = runToExhaustion(3, { maxCycles: 1, maxProbes: 2 });
		expect(cycles).toBe(1);
		expect(failedRequests).toBe(3);
	});

	// The reconciliation this whole two-budget design rests on. If these drift,
	// `settings.retry.maxRetries` is set from a formula that does not describe
	// what the state machine does, and the later models in the chain are never
	// reached — silently, because pi just stops retrying mid-lap.
	for (const chainLength of [1, 2, 3, 4, 7]) {
		for (const maxCycles of [1, 2, 3, 10]) {
			test(`requiredPhysicalRetries is exact for ${chainLength} models x ${maxCycles} cycles`, () => {
				const { failedRequests, cycles } = runToExhaustion(chainLength, {
					maxCycles,
					maxProbes: 2,
				});
				expect(cycles).toBe(maxCycles);
				expect(failedRequests).toBe(requiredPhysicalRetries(chainLength, maxCycles));
			});
		}
	}

	test("a non-positive budget exhausts immediately rather than lapping", () => {
		// `readConfig` coerces 0 to the default so settings cannot produce this,
		// but the wrap check alone only fires when the chain wraps — so without an
		// explicit guard a multi-model chain would walk to its end first, and a
		// future caller passing 0 would get an unbounded walk rather than a stop.
		for (const maxCycles of [0, -1]) {
			const result = advance({
				reason: "retry",
				chainLength: 3,
				state: initialState(),
				config: { maxCycles, maxProbes: 2 },
			});
			expect(result.kind).toBe("exhausted");
		}
	});

	test("the live configuration's budget is actually reachable", () => {
		// 3 models x 10 cycles = 30, which is why settings.json sets maxRetries 30.
		// A chain of 3 spends one fewer than the formula's ceiling because the
		// burst's first failure is the request that triggered it, so 30 is enough.
		const { failedRequests } = runToExhaustion(3, { maxCycles: 10, maxProbes: 2 });
		expect(failedRequests).toBeLessThanOrEqual(30);
		expect(describeBudgetShortfall(3, 10, 30)).toBeUndefined();
	});
});

describe("advance: direct requests", () => {
	test("route to home without touching state", () => {
		const mid: FallbackState = { index: 2, cycles: 3, probes: 1, home: 1, probing: true };
		const result = advance({ reason: "direct", chainLength: 3, state: mid, config: CONFIG });
		if (result.kind !== "route") throw new Error("expected a route");
		expect(result.index).toBe(1);
		expect(result.state).toBeUndefined();
	});

	test("route to the primary when there is no state yet", () => {
		const result = advance({ reason: "direct", chainLength: 3, state: undefined, config: CONFIG });
		if (result.kind !== "route") throw new Error("expected a route");
		expect(result.index).toBe(0);
	});
});

describe("advance: restored and corrupt state", () => {
	test("clamps an index past the end of a shortened chain", () => {
		// A session resumed after the chain shrank must not route out of range.
		const stale: FallbackState = { index: 5, cycles: 0, probes: 0, home: 5, probing: false };
		expect(step("continuation", stale, 2).index).toBeLessThan(2);
	});

	test("treats negative and non-integer counters as zero", () => {
		const corrupt = {
			index: -1,
			cycles: -3,
			probes: 1.5,
			home: Number.NaN,
			probing: "yes",
		} as unknown as FallbackState;
		const { index, state } = step("retry", corrupt, 3);
		expect(index).toBe(1);
		expect(state.cycles).toBe(0);
		expect(state.probes).toBe(0);
	});

	test("an empty chain is a caller bug, not a silent no-op", () => {
		expect(() => advance({ reason: "user", chainLength: 0, state: undefined, config: CONFIG })).toThrow();
	});

	test("returns undefined state when nothing changed, so pi does not re-store it", () => {
		const settled: FallbackState = { index: 0, cycles: 0, probes: 0, home: 0, probing: false };
		const result = advance({ reason: "user", chainLength: 3, state: settled, config: CONFIG });
		if (result.kind !== "route") throw new Error("expected a route");
		expect(result.state).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Budget reconciliation

describe("requiredPhysicalRetries", () => {
	test("is chain length times cycles, because pi counts each failed request", () => {
		expect(requiredPhysicalRetries(3, 10)).toBe(30);
	});

	test("is zero for a zero budget", () => {
		expect(requiredPhysicalRetries(3, 0)).toBe(0);
	});

	test("never goes negative on nonsense input", () => {
		expect(requiredPhysicalRetries(-2, 10)).toBe(0);
	});
});

describe("describeBudgetShortfall", () => {
	test("says nothing when the physical budget covers the cycles", () => {
		expect(describeBudgetShortfall(3, 2, 6)).toBeUndefined();
	});

	test("reports how many cycles are actually reachable", () => {
		const warning = describeBudgetShortfall(3, 10, 10);
		expect(warning).toContain("30");
		expect(warning).toContain("Only 3 full cycle");
	});

	test("reports zero reachable cycles when the budget is below one lap", () => {
		expect(describeBudgetShortfall(3, 10, 2)).toContain("Only 0 full cycle");
	});
});

// ---------------------------------------------------------------------------
// Messages

describe("describeExhaustion", () => {
	test("names every model tried and summarises the cause", () => {
		const chain: ChainEntry[] = [
			{ ref: "qwen/qwen3.8-27b" },
			{ ref: "litellm/anthropic/claude-opus-5" },
		];
		const text = describeExhaustion(chain, 3, "503 service unavailable");
		// `qwen3.8-27b` has no 3-digit run and no keyword, so it survives intact.
		expect(text).toContain("qwen/qwen3.8-27b");
		expect(text).toContain("claude-opus-5");
		expect(text).toContain("three cycles");
		expect(text).toContain("failed on its own side");
	});

	test("shows a pinned level beside its model", () => {
		const chain: ChainEntry[] = [{ ref: "a/1", thinking: "high" }, { ref: "b/2" }];
		const text = describeExhaustion(chain, 2, "Flurble");
		expect(text).toContain("a/1 (thinking: high)");
		expect(text).toContain("  - b/2");
	});

	test("says 1 cycle rather than 1 cycles", () => {
		expect(describeExhaustion([{ ref: "a/b" }], 1, "x")).toContain("1 cycle");
	});

	test("survives an unknown error", () => {
		expect(describeExhaustion([{ ref: "a/b" }], 1, undefined)).toContain("unknown");
	});

	test("does not nest when its own output is fed back as the last error", () => {
		// The exhaustion text is reported as an assistant error, so the next
		// failure's `lastError` is the previous exhaustion message. Without the
		// `isOwnError` guard this grew one nested copy per lap (measured).
		const chain: ChainEntry[] = [{ ref: "a/1" }, { ref: "b/2" }];
		const once = describeExhaustion(chain, 2, "Connection error.");
		const twice = describeExhaustion(chain, 2, once);
		expect(twice.length).toBeLessThanOrEqual(once.length + 40);
		expect(twice).not.toContain("Cause: model-fallback");
		expect(twice).toContain("every model in the chain failed");
	});
});

describe("exhaustion messages are never themselves retryable", () => {
	// The load-bearing invariant. pi decides whether to retry by running a regex
	// over the error text (`pi-ai/utils/retry.js`), and this module reports
	// exhaustion AS an error — so a message that happens to contain "timeout" or
	// "503" makes pi lap the chain forever and the budget becomes unspendable.
	// That is exactly what happened in testing, which is why this asserts against
	// pi's real classifier rather than restating its patterns here: a copy would
	// drift the moment pi adds a pattern, and drift here is an infinite loop.
	const chain: ChainEntry[] = [{ ref: "a/1" }, { ref: "b/2" }];

	const providerErrors: (string | undefined)[] = [
		"Connection error.",
		"503 Service Unavailable",
		"429 Too Many Requests",
		"Request timed out after 60s",
		"Overloaded",
		"currently experiencing high demand",
		"fetch failed",
		"socket hang up",
		"getaddrinfo ENOTFOUND api.example.com",
		"EAI_AGAIN",
		"insufficient_quota: billing hard limit reached",
		"Internal error occurred",
		"upstream connect error or disconnect/reset before headers",
		"stream ended before message_stop",
		"ResourceExhausted",
		"service unavailable",
		"rate limit exceeded, please retry your request",
		"520",
		"524",
		"websocket closed",
		"http2 request did not get a response",
		"Provider returned error",
		"terminated",
		"Some totally novel failure nobody has seen",
		"",
		undefined,
	];

	for (const error of providerErrors) {
		test(`terminal for: ${JSON.stringify(error)?.slice(0, 48) ?? "undefined"}`, () => {
			const errorMessage = describeExhaustion(chain, 2, error);
			expect(
				isRetryableAssistantError({
					role: "assistant",
					stopReason: "error",
					errorMessage,
				} as never),
			).toBe(false);
		});
	}

	test("every classifier category phrase is itself terminal", () => {
		// Covers the categories directly, so adding one with a bad word fails here
		// even if no sample error above happens to reach it.
		const samples = [
			"500 internal",
			"429 rate limit",
			"overloaded",
			"timed out",
			"connection refused",
			"insufficient_quota",
			"400 invalid request",
		];
		for (const sample of samples) {
			const phrase = sanitizeProviderError(sample);
			expect(
				isRetryableAssistantError({
					role: "assistant",
					stopReason: "error",
					errorMessage: phrase,
				} as never),
			).toBe(false);
		}
	});

	test("a pinned level cannot make a terminal message retryable", () => {
		// The seven level words are appended to the entry lists in BOTH terminal
		// messages; prove none of them trips pi's real classifier, for every level.
		const pinned: ChainEntry[] = [{ ref: "a/1", thinking: "high" }, { ref: "b/2" }];
		for (const level of THINKING_LEVELS) {
			pinned[0]!.thinking = level;
			for (const message of [describeExhaustion(pinned, 2, "Flurble"), describeNoneAvailable(pinned)]) {
				expect(
					isRetryableAssistantError({
						role: "assistant",
						stopReason: "error",
						errorMessage: message,
					} as never),
				).toBe(false);
			}
		}
	});
});

describe("sanitizeProviderError", () => {
	test("classifies a server failure", () => {
		expect(sanitizeProviderError("503 Service Unavailable")).toBe(
			"the provider failed on its own side",
		);
	});

	test("classifies an unreachable provider", () => {
		expect(sanitizeProviderError("Connection error.")).toBe(
			"the request could not reach the provider",
		);
	});

	test("classifies quota exhaustion, which is not a transient failure", () => {
		expect(sanitizeProviderError("insufficient_quota")).toContain("quota");
	});

	test("describes an unrecognised error by shape rather than quoting it", () => {
		const text = sanitizeProviderError("Flurble the wotsit misaligned");
		expect(text).toContain("Flurble");
		expect(text).toContain("chars");
		// The rest of the text is deliberately not reproduced.
		expect(text).not.toContain("misaligned");
	});

	test("only uses the first line of a multi-line error", () => {
		expect(sanitizeProviderError("Flurble happened\n503 Service Unavailable")).toContain(
			"Flurble",
		);
	});

	test("an empty or absent error is unknown", () => {
		expect(sanitizeProviderError("")).toBe("unknown");
		expect(sanitizeProviderError(undefined)).toBe("unknown");
		expect(sanitizeProviderError("   ")).toBe("unknown");
	});
});

describe("isOwnError", () => {
	test("recognises this module's own exhaustion text", () => {
		expect(isOwnError(describeExhaustion([{ ref: "a/1" }], 1, "x"))).toBe(true);
	});

	test("does not claim a provider error", () => {
		expect(isOwnError("503 Service Unavailable")).toBe(false);
		expect(isOwnError(undefined)).toBe(false);
	});
});

describe("describeHop", () => {
	test("names both models on an ordinary hop", () => {
		const text = describeHop({ ref: "a/1" }, { ref: "b/2" }, 0);
		expect(text).toContain("a/1 failed");
		expect(text).toContain("b/2");
		expect(text).not.toContain("cycle");
	});

	test("shows the cycle number once the chain has lapped", () => {
		expect(describeHop({ ref: "a/1" }, { ref: "b/2" }, 1)).toContain("cycle 2");
	});

	test("omits the failed model when there is none", () => {
		expect(describeHop(undefined, { ref: "b/2" }, 0)).toContain("routing to b/2");
	});

	test("shows a pinned level for both entries it names", () => {
		const text = describeHop({ ref: "a/1", thinking: "xhigh" }, { ref: "b/2", thinking: "low" }, 0);
		expect(text).toContain("a/1 (thinking: xhigh) failed");
		expect(text).toContain("b/2 (thinking: low)");
	});
});

describe("formatEntry", () => {
	test("renders an unpinned entry as the bare reference", () => {
		expect(formatEntry({ ref: "a/1" })).toBe("a/1");
	});

	test("renders a pinned entry with its level", () => {
		expect(formatEntry({ ref: "a/1", thinking: "high" })).toBe("a/1 (thinking: high)");
	});

	test("formatModelRef stays the identity: the annotation never leaks into the ref", () => {
		// Dedup and resolution key on the ref; a level is display, not identity.
		expect(formatModelRef({ ref: "a/1", thinking: "high" })).toBe("a/1");
	});
});

describe("formatChainItem", () => {
	test("renders an unpinned entry as the bare reference", () => {
		expect(formatChainItem({ ref: "a/1" })).toBe("a/1");
	});

	test("renders a pinned entry in the ref|level transport form", () => {
		expect(formatChainItem({ ref: "a/1", thinking: "high" })).toBe("a/1|high");
	});

	test("round-trips through parseChainItem", () => {
		// The transport contract covers every level, not a sample of them.
		const entries = [
			{ ref: "a/1" },
			...THINKING_LEVELS.map((level) => ({ ref: "a/1", thinking: level })),
		];
		for (const entry of entries) {
			expect(parseChainItem(formatChainItem(entry))).toEqual(entry);
		}
	});
});

describe("levelFor", () => {
	test("a pinned level overrides the selection", () => {
		const chain = parseChain(["a/1", { model: "b/2", thinking: "low" }]);
		expect(levelFor(chain, 1, "xhigh")).toBe("low");
	});

	test("an unpinned entry passes the selection through", () => {
		const chain = parseChain(["a/1", "b/2"]);
		expect(levelFor(chain, 1, "xhigh")).toBe("xhigh");
		expect(levelFor(chain, 0, "medium")).toBe("medium");
	});

	test("a pinned off is honoured, because the lookup is nullish, not truthy", () => {
		const chain = parseChain([{ model: "a/1", thinking: "off" }]);
		expect(levelFor(chain, 0, "high")).toBe("off");
	});

	test("the caller supplies the post-walk index: a skipped entry's level does not travel with it", () => {
		// The whole reason this helper exists. `route()` walks forward past
		// unreachable entries, so the index it passes is the model that actually
		// answers — not the one `advance` aimed at.
		const chain = parseChain([{ model: "a/1", thinking: "max" }, "b/2"]);
		expect(levelFor(chain, 0, "high")).toBe("max");
		expect(levelFor(chain, 1, "high")).toBe("high");
	});
});

// ---------------------------------------------------------------------------
// Settings

describe("readConfig", () => {
	test("defaults an absent blob", () => {
		expect(readConfig(undefined)).toEqual({ maxCycles: 10, maxProbes: 2 });
	});

	test("reads explicit values", () => {
		expect(readConfig({ maxCycles: 3, maxProbes: 1 })).toEqual({ maxCycles: 3, maxProbes: 1 });
	});

	test("ignores zero, negative, and non-integer values", () => {
		expect(readConfig({ maxCycles: 0, maxProbes: -1 })).toEqual({ maxCycles: 10, maxProbes: 2 });
		expect(readConfig({ maxCycles: 1.5 })).toEqual({ maxCycles: 10, maxProbes: 2 });
	});
});

describe("readChain", () => {
	test("reads the chain key", () => {
		expect(readChain({ chain: ["a/1", "b/2"] }).map(formatModelRef)).toEqual(["a/1", "b/2"]);
	});

	test("reads mixed string and object entries in both forms", () => {
		const nested = readChain({ chain: ["a/1", { model: "b/2", thinking: "max" }] });
		expect(nested.map((e) => e.ref)).toEqual(["a/1", "b/2"]);
		expect(nested[1]!.thinking).toBe("max");
		expect("thinking" in nested[0]!).toBe(false);
		expect(readChain(["a/1", { model: "b/2" }]).map(formatModelRef)).toEqual(["a/1", "b/2"]);
	});

	test("reads a bare array at the key", () => {
		expect(readChain(["a/1", "b/2"]).map(formatModelRef)).toEqual(["a/1", "b/2"]);
	});

	test("ignores entries that are neither strings nor objects", () => {
		expect(readChain({ chain: ["a/1", 7, null] }).map(formatModelRef)).toEqual(["a/1"]);
	});

	test("an absent or wrong-shaped blob is an empty chain", () => {
		expect(readChain(undefined)).toEqual([]);
		expect(readChain({ chain: "a/1" })).toEqual([]);
		expect(readChain(42)).toEqual([]);
	});
});

describe("isDisabled", () => {
	test("only an explicit enabled:false disables", () => {
		expect(isDisabled({ enabled: false })).toBe(true);
		expect(isDisabled({ enabled: true })).toBe(false);
		expect(isDisabled({})).toBe(false);
		expect(isDisabled(undefined)).toBe(false);
		expect(isDisabled(["a/1"])).toBe(false);
	});
});

describe("readLimits", () => {
	test("reads explicit limits", () => {
		expect(readLimits({ contextWindow: 262144, maxTokens: 32768 })).toEqual({
			contextWindow: 262144,
			maxTokens: 32768,
		});
	});

	test("omits a key rather than defaulting it to zero", () => {
		// An absent key and `0` mean the same thing to pi, but only one of them is
		// a claim this module makes. Spreading `{contextWindow: 0}` would assert
		// a limit of zero.
		expect(readLimits({})).toEqual({});
		expect(readLimits({ contextWindow: 100 })).toEqual({ contextWindow: 100 });
		expect("maxTokens" in readLimits({ contextWindow: 100 })).toBe(false);
	});

	test("ignores zero, negative, non-integer and non-numeric values", () => {
		expect(readLimits({ contextWindow: 0, maxTokens: -5 })).toEqual({});
		expect(readLimits({ contextWindow: 1.5 })).toEqual({});
		expect(readLimits({ contextWindow: "262144" })).toEqual({});
	});

	test("an absent or array blob yields no limits", () => {
		expect(readLimits(undefined)).toEqual({});
		expect(readLimits(["a/1"])).toEqual({});
	});
});

describe("sanitizeModelRef", () => {
	// Found by attacking describeExhaustion after the provider-error path was
	// already sealed: chain entries are printed verbatim, so a model NAME
	// containing a retry keyword made the exhaustion message retryable and pi
	// lapped forever. The names in this repo are all safe, which is exactly why
	// this would have gone unnoticed until someone added one that was not.
	test("leaves an ordinary reference untouched", () => {
		expect(sanitizeModelRef("qwen/qwen3.8-27b")).toBe("qwen/qwen3.8-27b");
		expect(sanitizeModelRef("anthropic/claude-opus-5")).toBe("anthropic/claude-opus-5");
	});

	test("breaks a retry keyword without hiding a character", () => {
		const out = sanitizeModelRef("timeout/model");
		expect(out).not.toBe("timeout/model");
		// Still readable: every original character is present, in order.
		expect(out.replace(/\u00b7/g, "")).toBe("timeout/model");
	});

	test("breaks a digit run as a RAW substring, not on a word boundary", () => {
		// This test used `/\b503\b/` and gave false assurance: pi matches its status
		// atoms as raw substrings with no word boundary
		// (`buildProviderErrorPattern(["429","500",…])`), so a tail like the `520`
		// inside `2·0250520` matched while `\b` said it did not. Found by review.
		for (const [ref, forbidden] of [
			["503/z", "503"],
			["anthropic/claude-4-sonnet-20250520", "520"],
			["anthropic/claude-4-opus-20250429", "429"],
			["x/model-20250503", "503"],
			["x/model-20250524", "524"],
			["gpt-4-0500", "500"],
			["v2524", "524"],
		] as const) {
			const out = sanitizeModelRef(ref);
			expect(out.includes(forbidden)).toBe(false);
			// Every original character survives, in order, so the name stays legible.
			expect(out.replace(/\u00b7/g, "")).toBe(ref);
		}
	});

	test("no digit run longer than two survives, which is what makes it safe", () => {
		// Every numeric atom pi matches is exactly three digits (pinned below), so a
		// maximum run of two cannot contain one. This is the invariant; the specific
		// refs above are examples of it.
		for (const ref of [
			"a/20250520",
			"a/999999999999",
			"a/1234567890",
			"503504520524/x",
		]) {
			for (const run of sanitizeModelRef(ref).match(/\d+/g) ?? []) {
				expect(run.length).toBeLessThanOrEqual(2);
			}
		}
	});

	test("leaves a short digit run alone, so real model ids stay readable", () => {
		// One- and two-digit runs cannot contain a three-digit atom, so breaking
		// them would cost readability for no safety.
		for (const ref of [
			"qwen/qwen3.8-27b",
			"anthropic/claude-opus-5",
			"openai/gpt-5.6-sol",
			"claude-haiku-4.5",
			"deepseek/deepseek-v4-flash",
		]) {
			expect(sanitizeModelRef(ref)).toBe(ref);
		}
	});

	test("handles an overlapping keyword without double-breaking", () => {
		// `connection` contains `connect`: longest-first ordering must win.
		const out = sanitizeModelRef("connection-error/x");
		expect(out.replace(/\u00b7/g, "")).toBe("connection-error/x");
	});
});

describe("spellNumber", () => {
	test("spells small counts", () => {
		expect(spellNumber(0)).toBe("zero");
		expect(spellNumber(1)).toBe("one");
		expect(spellNumber(10)).toBe("ten");
	});

	test("breaks a large count as a raw substring, at any digit length", () => {
		// Same false-assurance bug as above: `\b503\b` passed while `1·429` leaked.
		for (const [n, forbidden] of [
			[503, "503"],
			[429, "429"],
			[1429, "429"],
			[1503, "503"],
			[2500, "500"],
			[10503, "503"],
			[99504, "504"],
		] as const) {
			const out = spellNumber(n);
			expect(out.includes(forbidden)).toBe(false);
			expect(out.replace(/\u00b7/g, "")).toBe(String(n));
		}
	});

	test("leaves a two-digit count alone", () => {
		expect(spellNumber(42)).toBe("42");
	});
});

describe("a hostile chain cannot make exhaustion retryable", () => {
	// The regression suite for the attack above, asserted against pi's real
	// classifier. Every one of these refs produced a RETRYABLE exhaustion
	// message before `sanitizeModelRef` existed.
	const hostile = [
		"timeout/model",
		"connection-error/x",
		"overloaded/y",
		"503/z",
		"provider/returned-error",
		"rate-limit/model",
		"terminated/v",
		"x/ENOTFOUND",
		"x/EAI_AGAIN",
		"x/ResourceExhausted",
		"stream/ended-without",
		"http2/no-response",
		"a/socket-hang-up",
		"x/you-can-retry-your-request",
		"network/err",
		"internal/server-error",
		"service/unavailable",
		"too-many-requests/m",
	];

	for (const ref of hostile) {
		test(`terminal with a chain entry named ${ref}`, () => {
			const chain = parseChain([ref, "ok/model"]);
			expect(chain.length).toBeGreaterThan(0);
			const errorMessage = describeExhaustion(chain, 2, "Connection error.");
			expect(
				isRetryableAssistantError({
					role: "assistant",
					stopReason: "error",
					errorMessage,
				} as never),
			).toBe(false);
		});
	}

	test("a cycle count that looks like a status code is still terminal", () => {
		for (const cycles of [429, 500, 503, 504, 520, 524]) {
			const errorMessage = describeExhaustion([{ ref: "a/1" }], cycles, "Flurble");
			expect(
				isRetryableAssistantError({
					role: "assistant",
					stopReason: "error",
					errorMessage,
				} as never),
			).toBe(false);
		}
	});

	test("a hostile ref with a pinned level is still terminal", () => {
		// The hostile-ref loop and the pinned-level loop each cover one half of
		// `sanitizeModelRef(formatEntry(e))`; this covers the composition, where a
		// keyword could in principle straddle the ref → annotation boundary.
		const chain = parseChain([{ model: "timeout/model", thinking: "high" }, "ok/model"]);
		expect(chain.length).toBe(2);
		const errorMessage = describeExhaustion(chain, 2, "Connection error.");
		expect(
			isRetryableAssistantError({
				role: "assistant",
				stopReason: "error",
				errorMessage,
			} as never),
		).toBe(false);
	});
});

describe("describeNoneAvailable", () => {
	test("names every entry and says what to fix", () => {
		const text = describeNoneAvailable([{ ref: "nope/a" }, { ref: "nope/b" }]);
		expect(text).toContain("nope/a");
		expect(text).toContain("nope/b");
		expect(text).toContain("settings.modelFallback.chain");
		// Distinct from exhaustion: nothing was tried, so waiting will not help.
		expect(text).not.toContain("cycle");
	});

	test("shows a pinned level beside its model", () => {
		const text = describeNoneAvailable([{ ref: "a/1", thinking: "max" }, { ref: "nope/b" }]);
		expect(text).toContain("a/1 (thinking: max)");
		expect(text).toContain("nope/b");
	});

	test("is never retryable, even for a hostile model name", () => {
		// This path was an inline template in index.ts and was retryable for 6 of
		// these 7 refs. Same vector as describeExhaustion, same fix, own test.
		for (const ref of [
			"timeout/m",
			"503/z",
			"connection/x",
			"overloaded/y",
			"x/ENOTFOUND",
			"rate-limit/a",
			"terminated/b",
		]) {
			const errorMessage = describeNoneAvailable(parseChain([ref, "ok/m"]));
			expect(
				isRetryableAssistantError({
					role: "assistant",
					stopReason: "error",
					errorMessage,
				} as never),
			).toBe(false);
		}
	});
});

describe("the premise that makes pair-chunking safe", () => {
	// `breakDigitRuns` leaves runs of two digits alone. That is only safe while
	// every numeric atom pi matches on is three digits long. Rather than trusting
	// that, this derives the atoms from pi's own regex SOURCE, so a future pi that
	// adds a 2-digit or 4-digit numeric atom fails here instead of silently making
	// exhaustion retryable again.
	test("every numeric atom in pi's retryable pattern is exactly three digits", async () => {
		const retryJs = join(
			homedir(),
			".bun/install/global/node_modules/@earendil-works/pi-ai/dist/utils/retry.js",
		);
		let source: string;
		try {
			source = await readFile(retryJs, "utf8");
		} catch {
			// The installed bundle is not part of this repo; skip rather than fail
			// when it is absent (a fresh clone, or a different install layout).
			return;
		}
		const block = source
			.split("RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([")[1]
			?.split("]);")[0];
		expect(block).toBeDefined();
		const atoms = [...(block ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!);
		expect(atoms.length).toBeGreaterThan(20);

		const digitRuns = atoms.flatMap((a) => a.match(/\d+/g) ?? []);
		expect(digitRuns.length).toBeGreaterThan(0);
		for (const run of digitRuns) {
			// `http2` contributes a 1-digit run, which no chunking can or need split;
			// everything else must be 3, the status codes.
			expect([1, 3]).toContain(run.length);
		}
		// And the pure-number atoms specifically: all exactly three digits.
		for (const atom of atoms.filter((a) => /^\d+$/.test(a))) {
			expect(atom.length).toBe(3);
		}
	});

	test("a two-digit run cannot contain any numeric atom pi matches", () => {
		// The actual logical step: pairs are safe because no 3-char needle fits in
		// a 2-char haystack. Asserted directly against the real classifier.
		for (const code of ["429", "500", "502", "503", "504", "520", "524"]) {
			for (let a = 0; a < 100; a++) {
				const pair = String(a).padStart(2, "0");
				expect(pair.includes(code)).toBe(false);
			}
		}
	});
});

describe("VIRTUAL_MODEL_API", () => {
	// `resolve()` must be able to tell a virtual catalogue entry from a physical
	// one: `getAvailable()` includes virtual models and a keyless virtual provider
	// self-resolves auth, so without this filter a chain entry naming
	// `fallback/auto` resolved to the router itself and pi then failed EVERY
	// request with "routed to fallback/auto, which is not a physical model".
	// Measured as a dead session before the filter existed.
	//
	// pi does not export the constant, so it is duplicated here; this reads the
	// literal back out of pi's own source so the copy cannot drift silently.
	test("matches the literal in pi's virtual-models.js", async () => {
		const file = join(
			homedir(),
			".bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/core/virtual-models.js",
		);
		let source: string;
		try {
			source = await readFile(file, "utf8");
		} catch {
			return; // Not part of this repo; skip rather than fail on a fresh clone.
		}
		const match = source.match(/VIRTUAL_MODEL_API = "([^"]+)"/);
		expect(match).not.toBeNull();
		expect(VIRTUAL_MODEL_API).toBe(match![1]);
	});

	test("is the api of an entry the router must never return", () => {
		// Documents the contract rather than the value: a model whose api is this
		// is not routable, which is the whole reason resolve() filters on it.
		expect(VIRTUAL_MODEL_API).not.toBe("");
		expect(typeof VIRTUAL_MODEL_API).toBe("string");
	});
});
