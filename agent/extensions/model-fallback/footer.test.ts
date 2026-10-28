/**
 * Tests for `footer.ts`.
 *
 * Two things are pinned here. The pure helpers (`formatTokens`,
 * `formatCwdForFooter`) replicate pi's built-in `footer.js`, so parity is the
 * claim. And the component itself is tested for the invariant that matters
 * most: **no rendered line may exceed the width it was given**. pi's TUI host
 * throws on an over-wide line, which takes the whole process down, and this
 * footer is installed in every session including subagent children in narrow
 * herdr panes — so a width regression here is not cosmetic.
 */
import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import type {
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { ChainEntry } from "./lib.ts";
import { createFallbackFooter, formatCwdForFooter, formatTokens } from "./footer.ts";

describe("formatTokens", () => {
	test("raw below 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(999)).toBe("999");
	});

	test("one-decimal k below 10000", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	test("rounded k below 1e6", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(15000)).toBe("15k");
		expect(formatTokens(999999)).toBe("1000k");
	});

	test("one-decimal M below 1e7", () => {
		expect(formatTokens(1000000)).toBe("1.0M");
		expect(formatTokens(1500000)).toBe("1.5M");
	});

	test("rounded M at and above 1e7", () => {
		expect(formatTokens(10000000)).toBe("10M");
		expect(formatTokens(15000000)).toBe("15M");
	});
});

describe("formatCwdForFooter", () => {
	const HOME = "/home/joseph";

	test("~ for the home directory itself", () => {
		expect(formatCwdForFooter(HOME, HOME)).toBe("~");
	});

	test("~/… for a path inside home", () => {
		expect(formatCwdForFooter("/home/joseph/agent", HOME)).toBe("~/agent");
		expect(formatCwdForFooter("/home/joseph/a/b", HOME)).toBe("~/a/b");
	});

	test("the raw path when outside home", () => {
		expect(formatCwdForFooter("/etc", HOME)).toBe("/etc");
	});

	test("the raw path for a sibling of home (not a child)", () => {
		expect(formatCwdForFooter("/home/joseph-foo", HOME)).toBe("/home/joseph-foo");
	});

	test("the raw path when home is unknown", () => {
		expect(formatCwdForFooter("/home/joseph", undefined)).toBe("/home/joseph");
	});
});

describe("createFallbackFooter render", () => {
	const CHAIN: ChainEntry[] = [{ ref: "primary/one" }, { ref: "backup/two" }];

	/** A stand-in for pi's Theme: styling is identity, so the widths are real. */
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;

	const tui = { requestRender: () => {} } as unknown as TUI;

	function footerData(statuses: Record<string, string> = {}): ReadonlyFooterDataProvider {
		return {
			getGitBranch: () => "main",
			getExtensionStatuses: () => new Map(Object.entries(statuses)),
			getAvailableProviderCount: () => 2,
			onBranchChange: () => () => {},
		} as unknown as ReadonlyFooterDataProvider;
	}

	/** A fake context whose branch is `entries`; only what the footer reads. */
	function ctx(
		entries: readonly unknown[],
		percent: number | null = 42.5,
		selection: { provider: string; id: string; reasoning?: boolean } = {
			provider: "fallback",
			id: "auto",
		},
		thinkingLevel?: string,
	): ExtensionContext {
		return {
			hasUI: true,
			model: { ...selection, contextWindow: 200000 },
			thinkingLevel,
			modelRegistry: {
				find: () => undefined,
				getProvider: () => undefined,
				isUsingOAuth: () => false,
			},
			getContextUsage: () => ({ percent, contextWindow: 200000 }),
			sessionManager: {
				getCwd: () => "/home/joseph/.pi",
				getSessionId: () => "s1",
				getLeafId: () => "leaf-1",
				getSessionName: () => undefined,
				getEntryCount: () => entries.length,
				getEntries: () => entries,
				getBranch: () => entries,
			},
		} as unknown as ExtensionContext;
	}

	const routerChange = { type: "model_change", provider: "fallback", modelId: "auto" };
	const stateEntry = (index: number) => ({
		type: "custom",
		customType: "pi.virtual-model-state",
		data: {
			provider: "fallback",
			modelId: "auto",
			state: { index, cycles: 0, probes: 0, home: 0, probing: false },
		},
	});

	let currentCtx: ExtensionContext | undefined;

	/** Build the footer; entries named in `unreachable` fail to resolve. */
	function footer(unreachable: readonly string[] = [], autoCompact = true) {
		return createFallbackFooter({
			chain: CHAIN,
			provider: "fallback",
			modelId: "auto",
			getCtx: () => currentCtx,
			resolveModel: (_ctx, entry) =>
				unreachable.includes(entry.ref)
					? undefined
					: ({ provider: "litellm", id: entry.ref, reasoning: true } as unknown as Model<Api>),
			autoCompactionEnabled: () => autoCompact,
		});
	}

	test("no line exceeds the width, including subagent-narrow panes", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const component = footer()(
			tui,
			theme,
			footerData({ mcp: "a very long extension status that must be truncated to fit" }),
		);
		// The narrow widths are the ones a herdr subagent pane actually gets.
		for (const width of [1, 2, 3, 5, 8, 10, 13, 20, 31, 40, 60, 80, 120, 200]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("no line exceeds the width with a long pwd and many stats", () => {
		currentCtx = ctx([
			routerChange,
			stateEntry(0),
			{ type: "usage", usage: { input: 900000, output: 8000, cacheRead: 7000, cacheWrite: 6000, cost: { total: 12.345 } } },
		]);
		const component = footer()(tui, theme, footerData());
		for (const width of [10, 20, 31, 40]) {
			for (const line of component.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("survives a non-positive width (0 before layout, negative mid-resize)", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const component = footer()(tui, theme, footerData());
		for (const width of [0, -1, -40, Number.NaN]) {
			expect(() => component.render(width)).not.toThrow();
		}
	});

	test("names the chain primary before the first response (startup)", () => {
		currentCtx = ctx([]);
		// Auto-compaction off, so the built-in's `(auto)` marker cannot confuse the
		// assertion below with a legitimate `auto`.
		const line = footer([], false)(tui, theme, footerData()).render(80).join("\n");
		expect(line).toContain("primary/one");
		expect(line).not.toContain("auto");
	});

	test("follows a hop to the fallback entry", () => {
		currentCtx = ctx([routerChange, stateEntry(1)]);
		const line = footer()(tui, theme, footerData()).render(200).join("\n");
		expect(line).toContain("backup/two");
		expect(line).not.toContain("primary/one");
	});

	test("shows the entry that can serve when the planned one cannot", () => {
		// State says index 0, but that entry has no credentials: the footer must
		// name the model actually serving, not the planned one.
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const line = footer(["primary/one"])(tui, theme, footerData()).render(200).join("\n");
		expect(line).toContain("backup/two");
	});

	test("still renders when no entry is reachable", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const lines = footer(["primary/one", "backup/two"])(tui, theme, footerData()).render(80);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).toContain("primary/one");
	});

	test("renders nothing after shutdown (no context)", () => {
		currentCtx = undefined;
		expect(footer()(tui, theme, footerData()).render(80)).toEqual([]);
	});

	test("shows a physical selection verbatim", () => {
		currentCtx = ctx([], 42.5, { provider: "litellm", id: "gpt-5.6-sol" });
		const line = footer()(tui, theme, footerData()).render(200).join("\n");
		expect(line).toContain("gpt-5.6-sol");
	});

	test("adds the thinking level suffix for a reasoning model", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const line = footer()(tui, theme, footerData()).render(200).join("\n");
		expect(line).toContain("thinking off");
	});

	test("caches the whole-session scan until the entry count changes", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		// Counting the expensive calls: `getEntries()` copies the entry list and
		// `getContextUsage()` rebuilds the session projection. Neither may run on
		// every frame — this footer renders on every frame of every session.
		let entryCalls = 0;
		let usageCalls = 0;
		const sm = currentCtx.sessionManager as unknown as { getEntries: () => unknown[] };
		const originalEntries = sm.getEntries;
		sm.getEntries = () => {
			entryCalls++;
			return originalEntries.call(currentCtx!.sessionManager);
		};
		const originalUsage = currentCtx.getContextUsage;
		(currentCtx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => {
			usageCalls++;
			return originalUsage.call(currentCtx);
		};

		const component = footer()(tui, theme, footerData());
		component.render(80);
		const entryAfterFirst = entryCalls;
		const usageAfterFirst = usageCalls;
		component.render(80);
		component.render(80);
		expect(entryCalls).toBe(entryAfterFirst);
		expect(usageCalls).toBe(usageAfterFirst);
	});

	test("rescans when the entry count changes", () => {
		const entries: unknown[] = [routerChange, stateEntry(0)];
		currentCtx = ctx(entries);
		const component = footer()(tui, theme, footerData());
		component.render(80).join("\n");
		// A new entry appends: totals must reflect it, not the cached zeros.
		entries.push({
			type: "usage",
			usage: { input: 5000, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 1.5 } },
		});
		const line = component.render(80).join("\n");
		expect(line).toContain("↑5.0k");
		expect(line).toContain("$1.500");
	});

	test("no line exceeds the width with real ANSI escape sequences", () => {
		// The other width tests use an identity theme, so they cannot catch an
		// ANSI regression (styled context %, the statsLine slice boundary,
		// truncation mid-escape). This theme emits real escape codes.
		const ansiTheme = {
			fg: (_color: string, text: string) => `\u001b[2m${text}\u001b[0m`,
			bold: (text: string) => `\u001b[1m${text}\u001b[0m`,
		} as unknown as Theme;
		currentCtx = ctx([
			routerChange,
			stateEntry(0),
			{ type: "usage", usage: { input: 900000, output: 8000, cacheRead: 7000, cacheWrite: 6000, cost: { total: 12.345 } } },
		]);
		const component = footer()(tui, ansiTheme, footerData({ mcp: "a long extension status line to truncate here" }));
		for (const width of [3, 5, 8, 13, 31, 40, 80]) {
			for (const line of component.render(width)) {
				// Assert the *visible* width: styled bytes must not blow the budget.
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("marks (auto) only when auto-compaction is on", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const on = footer([], true)(tui, theme, footerData()).render(200).join("\n");
		expect(on).toContain("(auto)");
		const off = footer([], false)(tui, theme, footerData()).render(200).join("\n");
		expect(off).not.toContain("(auto)");
	});

	test("marks xp only when experimental features are on", () => {
		currentCtx = ctx([routerChange, stateEntry(0)]);
		const component = footer()(tui, theme, footerData());
		const before = process.env.PI_EXPERIMENTAL;
		try {
			process.env.PI_EXPERIMENTAL = "1";
			expect(component.render(200).join("\n")).toContain("xp");
			process.env.PI_EXPERIMENTAL = "0";
			expect(component.render(200).join("\n")).not.toContain("xp");
		} finally {
			if (before === undefined) delete process.env.PI_EXPERIMENTAL;
			else process.env.PI_EXPERIMENTAL = before;
		}
	});

	test("takes the selection from the context, not the branch", () => {
		// The branch names a model that is no longer selected; the footer must
		// show the selected one, or it sticks on the stale model forever.
		currentCtx = ctx(
			[{ type: "model_change", provider: "litellm", modelId: "stale-model" }],
			42.5,
			{ provider: "litellm", id: "actually-selected" },
		);
		const line = footer()(tui, theme, footerData()).render(200).join("\n");
		expect(line).toContain("actually-selected");
		expect(line).not.toContain("stale-model");
	});
});
