/**
 * model-fallback — a `setFooter` replacement that shows the *in-use* physical
 * model.
 *
 * ## What this actually buys
 *
 * pi's built-in footer already shows where a request went: for a virtual model
 * it appends `→ <routed model>` after the selection, so after the first
 * response it reads `auto • high → gpt-5.6-luna • medium`. Two things it cannot
 * do, and this footer can:
 *
 * 1. **Before the first response** there is no routed model yet, so the
 *    built-in shows only `auto` at startup. This one names the chain's primary,
 *    which is what will actually answer.
 * 2. **The in-use model is the primary label**, not a suffix after `auto →`.
 *
 * That is the whole gain — the fork of pi's `footer.js` is deliberately small
 * and everything else matches the built-in (pi 1.1.0
 * `dist/modes/interactive/components/footer.js`), including the `(auto)`,
 * `(sub)` and `xp` markers, so this replaces it rather than silently degrading
 * it. Keep that true when pi's footer changes.
 *
 * One marker is deliberately *better*, not identical: `(sub)` is evaluated
 * against the physical model in use, where the built-in evaluates it against
 * the selected one — the virtual router, whose provider is never
 * subscription-backed. So a subscription-backed chain entry shows `(sub)` here
 * and would not in the built-in.
 *
 * ## Width
 *
 * pi's TUI host **throws** on a rendered line wider than the terminal, which
 * takes the whole process down — and this footer is installed in every
 * subagent child, whose herdr panes are routinely narrow. So the layout
 * replicates the built-in's own truncation (`statsLeft` clamp included) and
 * every returned line goes through the house {@link fitLines} as a final
 * guarantee, rather than trusting the arithmetic above it.
 *
 * The component is deliberately dumb about *pi*: it reads everything through
 * the callbacks the caller injects, so `lib.ts` stays pi-free and this file
 * never imports from `index.ts` (no cycle).
 *
 * @module model-fallback/footer
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type {
	ContextUsage,
	ExtensionContext,
	ReadonlyFooterDataProvider,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fitLines } from "../lib/widget.js";
import { type ChainEntry, computeDisplay } from "./lib.js";

/**
 * Compact token count for a single-line footer.
 *
 * Replicates pi's `footer.js` `formatTokens` so the readout matches the
 * built-in footer byte-for-byte on the same session.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

/**
 * Replace the home directory with `~` for the footer's pwd line.
 *
 * Replicates pi's `footer.js` `formatCwdForFooter`.
 */
export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Collapse control characters so a status fits one line (replicates footer.js). */
function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

/**
 * Whether pi's experimental features are on.
 *
 * `areExperimentalFeaturesEnabled` is not exported, but its whole body is this
 * environment check (`core/experimental.js`), so reading the variable keeps the
 * footer's `xp` marker in parity with the built-in.
 */
function experimentalEnabled(): boolean {
	return process.env.PI_EXPERIMENTAL === "1";
}

/** The usage fields the footer sums; structurally matches pi-ai's `Usage`. */
interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** One frame's cached whole-session scan. */
interface SessionScan {
	totals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: ContextUsage | undefined;
	/**
	 * Read with the scan, not per frame: `pi.getSettings()` returns a
	 * `structuredClone` of the whole settings tree, so calling it from `render`
	 * would deep-clone every frame of every session to read one boolean. Read
	 * with the scan, so a settings change shows up on the next scan rather than
	 * instantly — which is the point.
	 */
	autoCompact: boolean;
}

function addUsage(totals: UsageTotals, usage: UsageLike): void {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

/**
 * Count session entries without copying them.
 *
 * `getEntryCount()` exists on pi's `SessionManager` but is omitted from the
 * `ReadonlySessionManager` `Pick` the extension context is typed with, so it is
 * reached through a narrow cast and falls back to `getEntries().length` if a
 * future pi drops it.
 */
function entryCountOf(sm: ExtensionContext["sessionManager"]): number {
	const counter = (sm as unknown as { getEntryCount?: () => number }).getEntryCount;
	return typeof counter === "function" ? counter.call(sm) : sm.getEntries().length;
}

/**
 * Whether the model is paid for by a provider subscription rather than per
 * token. Mirrors the built-in's test, including its `kimi-coding` exception
 * (subscription-backed despite using API-key auth).
 */
function usingSubscription(ctx: ExtensionContext, model: Model<Api> | undefined): boolean {
	if (!model) return false;
	if (model.provider === "kimi-coding") return true;
	const provider = ctx.modelRegistry.getProvider(model.provider);
	return ctx.modelRegistry.isUsingOAuth(model) && provider?.auth?.oauth?.isSubscription === true;
}

export interface FallbackFooterOptions {
	/** The router's chain, in priority order. */
	chain: readonly ChainEntry[];
	/** Provider id of the virtual model (the router). */
	provider: string;
	/** Model id of the virtual model (the router). */
	modelId: string;
	/** Live extension context, or undefined after shutdown. */
	getCtx: () => ExtensionContext | undefined;
	/** Resolve a chain entry to a physical model (mirrors index.ts `resolve`). */
	resolveModel: (ctx: ExtensionContext, entry: ChainEntry) => Model<Api> | undefined;
	/**
	 * Whether auto-compaction is on, for the built-in's `(auto)` marker.
	 * Injected because it lives on the live session, not on the extension
	 * context: `pi.getSettings().compaction?.enabled ?? true`.
	 */
	autoCompactionEnabled: () => boolean;
}

/**
 * Build the `setFooter` factory for this extension.
 *
 * Returns `(tui, theme, footerData) => Component`. Per-instance caches:
 * the usage totals, the latest cache-hit rate and the context usage are all
 * whole-session scans (`getContextUsage()` rebuilds the session projection, and
 * `getEntries()` copies the entry list), and `render` runs on every frame — so
 * all three are cached behind `(session, leaf, entry count, selection)`, the
 * conditions the built-in footer keys its own cache on. The selection is in the
 * key because the context window follows the model that is answering.
 *
 * One known lag, shared with the built-in: right after a hop, pi's own context
 * usage still reflects the model that answered the previous request until the
 * new assistant message is persisted, so the context window can be stale for
 * the duration of one stream. The entry count changes at that point, which
 * invalidates this cache and lets it correct.
 */
export function createFallbackFooter(
	options: FallbackFooterOptions,
): (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider) => Component & { dispose?(): void } {
	let cache: (SessionScan & { key: string }) | undefined;

	return (tui, theme, footerData) => {
		// Re-render when the git branch changes, so the pwd line stays honest.
		const onBranch = footerData.onBranchChange(() => tui.requestRender());

		return {
			invalidate(): void {
				cache = undefined;
			},
			dispose(): void {
				onBranch();
				cache = undefined;
			},
			render(width: number): string[] {
				const ctx = options.getCtx();
				if (!ctx) return [];
				const sm = ctx.sessionManager;

				// Which model is in use. The selection comes from pi (`ctx.model`),
				// never from the branch — see computeDisplay. `isReachable` makes the
				// router walk past entries this machine cannot reach, mirroring
				// `route()`, so a credentialed-out primary is not named forever.
				const display = computeDisplay({
					entries: sm.getBranch(),
					chain: options.chain,
					provider: options.provider,
					modelId: options.modelId,
					selection: ctx.model ? { provider: ctx.model.provider, modelId: ctx.model.id } : undefined,
					thinkingLevel: ctx.thinkingLevel,
					isReachable: (index) => {
						const entry = options.chain[index];
						return entry !== undefined && options.resolveModel(ctx, entry) !== undefined;
					},
				});

				let modelName: string;
				let modelProvider: string | undefined;
				let reasoning: boolean;
				let shownModel: Model<Api> | undefined;
				if (display.kind === "fallback") {
					const entry = options.chain[display.index];
					const model = entry ? options.resolveModel(ctx, entry) : undefined;
					shownModel = model;
					modelName = model?.id ?? entry?.ref ?? "no-model";
					modelProvider = model?.provider;
					reasoning = !!model?.reasoning;
				} else {
					shownModel = ctx.modelRegistry.find(display.provider, display.modelId);
					modelName = display.modelId;
					modelProvider = display.provider;
					reasoning = !!shownModel?.reasoning;
				}

				// Whole-session scans: cached (see the factory docstring).
				const modelKey =
					display.kind === "fallback"
						? `chain:${display.index}:${display.level}`
						: `physical:${display.provider}/${display.modelId}:${display.level}`;
				const selectionKey = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "-";
				const key = `${sm.getSessionId()}\u0000${sm.getLeafId()}\u0000${entryCountOf(sm)}\u0000${selectionKey}\u0000${modelKey}`;
				if (!cache || cache.key !== key) {
					const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let latestCacheHitRate: number | undefined;
					for (const entry of sm.getEntries()) {
						if (entry.type === "usage") {
							addUsage(totals, entry.usage);
						} else if (entry.type === "message" && entry.message.role === "assistant") {
							addUsage(totals, entry.message.usage);
							const latestPromptTokens =
								entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
							latestCacheHitRate =
								latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
						} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
							addUsage(totals, entry.message.usage);
						} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
							addUsage(totals, entry.usage);
						}
					}
					cache = {
						key,
						totals,
						latestCacheHitRate,
						contextUsage: ctx.getContextUsage(),
						autoCompact: options.autoCompactionEnabled(),
					};
				}
				const { totals, latestCacheHitRate, contextUsage, autoCompact } = cache;
				// `shownModel` first: under a router selection `ctx.model` is the *virtual*
				// model, whose window is a placeholder — so before the first response it
				// would put the router's window next to the physical model now named here.
				const contextWindow = contextUsage?.contextWindow ?? shownModel?.contextWindow ?? ctx.model?.contextWindow ?? 0;

				// Line 1: pwd (git branch, session name).
				let pwd = formatCwdForFooter(sm.getCwd(), process.env.HOME || process.env.USERPROFILE);
				const branch = footerData.getGitBranch();
				if (branch) pwd = `${pwd} (${branch})`;
				const sessionName = sm.getSessionName();
				if (sessionName) pwd = `${pwd} • ${sessionName}`;

				// Line 2, left: usage stats + context usage.
				const statsParts: string[] = [];
				if (totals.input) statsParts.push(`↑${formatTokens(totals.input)}`);
				if (totals.output) statsParts.push(`↓${formatTokens(totals.output)}`);
				if (totals.cacheRead) statsParts.push(`R${formatTokens(totals.cacheRead)}`);
				if (totals.cacheWrite) statsParts.push(`W${formatTokens(totals.cacheWrite)}`);
				if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
					statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
				}
				// `(sub)` marks subscription-backed usage, as the built-in does.
				const subscription = usingSubscription(ctx, shownModel);
				if (totals.cost || subscription) statsParts.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);

				const contextPercentValue = contextUsage?.percent ?? 0;
				// Mirrors the built-in exactly, including its quirk: an unknown
				// context usage renders as `0.0%`, not `?`.
				const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
				const autoIndicator = autoCompact ? " (auto)" : "";
				const contextPercentDisplay =
					contextPercent === "?"
						? `?/${formatTokens(contextWindow)}${autoIndicator}`
						: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
				let contextPercentStr: string;
				if (contextPercentValue > 90) contextPercentStr = theme.fg("error", contextPercentDisplay);
				else if (contextPercentValue > 70) contextPercentStr = theme.fg("warning", contextPercentDisplay);
				else contextPercentStr = contextPercentDisplay;
				statsParts.push(contextPercentStr);
				if (experimentalEnabled()) {
					statsParts.push(`${theme.fg("dim", "•")} ${theme.bold(theme.fg("warning", "xp"))}`);
				}

				let statsLeft = statsParts.join(" ");
				// The built-in truncates an over-wide `statsLeft` before laying out the
				// right side, and that clamp is load-bearing: without it a narrow pane
				// produces a line wider than the terminal, which pi's TUI host *throws*
				// on — killing the process. `fitLines` below is the second line of
				// defence, not a substitute.
				let statsLeftWidth = visibleWidth(statsLeft);
				if (width > 0 && statsLeftWidth > width) {
					statsLeft = truncateToWidth(statsLeft, width, "...");
					statsLeftWidth = visibleWidth(statsLeft);
				}

				// Line 2, right: the model. `modelName` above is already the physical
				// model in use (the point of this footer).
				const minPadding = 2;
				let rightSideWithoutProvider = modelName;
				if (reasoning) {
					rightSideWithoutProvider =
						display.level === "off" ? `${modelName} • thinking off` : `${modelName} • ${display.level}`;
				}
				let rightSide = rightSideWithoutProvider;
				if (footerData.getAvailableProviderCount() > 1 && modelProvider) {
					const withProvider = `(${modelProvider}) ${rightSideWithoutProvider}`;
					if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
						rightSide = withProvider;
					}
				}

				// Layout: right-align the model, truncating to fit (as built-in).
				const rightSideWidth = visibleWidth(rightSide);
				let statsLine: string;
				if (statsLeftWidth + minPadding + rightSideWidth <= width) {
					const padding = " ".repeat(Math.max(0, width - statsLeftWidth - rightSideWidth));
					statsLine = statsLeft + padding + rightSide;
				} else {
					const availableForRight = width - statsLeftWidth - minPadding;
					if (availableForRight > 0) {
						const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
						const truncatedRightWidth = visibleWidth(truncatedRight);
						const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
						statsLine = statsLeft + padding + truncatedRight;
					} else {
						statsLine = statsLeft;
					}
				}

				// Dim the left and the padding+right separately: statsLeft may end
				// in a coloured (context %) run whose reset would clear an outer dim.
				const dimStatsLeft = theme.fg("dim", statsLeft);
				const remainder = statsLine.slice(statsLeft.length);
				const dimRemainder = theme.fg("dim", remainder);
				const fitWidth = width > 0 ? width : Number.POSITIVE_INFINITY;
				const pwdLine = truncateToWidth(theme.fg("dim", pwd), fitWidth, theme.fg("dim", "..."));
				const lines = [pwdLine, dimStatsLeft + dimRemainder];

				// Line 3: extension statuses (sorted by key, one line, sanitised).
				const extensionStatuses = footerData.getExtensionStatuses();
				if (extensionStatuses.size > 0) {
					const sortedStatuses = Array.from(extensionStatuses.entries())
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([, text]) => sanitizeStatusText(text));
					lines.push(truncateToWidth(sortedStatuses.join(" "), fitWidth, theme.fg("dim", "...")));
				}

				// Final guarantee: no line may exceed the terminal, or pi throws and
				// the process dies. A non-positive width means "not measured yet"
				// (pi reports 0 before the first layout, negative mid-resize) and is
				// passed through rather than blanked, per the house rule.
				return fitLines(lines, width);
			},
		};
	};
}
