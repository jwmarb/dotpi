/**
 * OpenCode-style footer.
 *
 * Replaces pi's built-in footer with a layout modelled on OpenCode's chrome:
 * a dim location line, a stats line with the model right-aligned, and a dim
 * keybind-hint row.
 *
 * `ctx.ui.setFooter` replaces the built-in footer wholesale, so everything the
 * built-in showed is reproduced here — cwd, git branch, session name, token
 * totals, cost, context percent, model, thinking level, and extension statuses
 * (which is where live subagent progress arrives). Dropping any of it would be
 * a silent downgrade, so the hint row is the only thing sacrificed when narrow.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as os from "node:os";

/** Minimum gap between the left stats and the right-aligned model. */
const MIN_PADDING = 2;

/**
 * Below this width the keybind hints are dropped.
 *
 * They are decorative: a hint you already know is worth less than a number you
 * cannot otherwise see, so they yield before anything informational.
 */
const HINTS_MIN_WIDTH = 60;

/** Keybind hints, mirroring OpenCode's footer row. */
const HINTS: ReadonlyArray<readonly [string, string]> = [
	["esc", "interrupt"],
	["ctrl+p", "commands"],
];

/** Format a token count compactly (1.5k, 12k, 1.2M). */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

/** Collapse whitespace so a status can never break the single-line layout. */
function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/** Replace the home directory prefix with `~`. */
function shortenHome(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Lay `left` and `right` on one line of `width`, right-aligning `right`.
 *
 * Truncates the left side first and the right only as a last resort, matching
 * the built-in footer so behaviour at small widths is unsurprising.
 */
function fit(left: string, right: string, width: number): string {
	let leftStr = left;
	let leftWidth = visibleWidth(leftStr);
	if (leftWidth > width) {
		leftStr = truncateToWidth(leftStr, width, "...");
		leftWidth = visibleWidth(leftStr);
	}

	const rightWidth = visibleWidth(right);
	if (leftWidth + MIN_PADDING + rightWidth <= width)
		return leftStr + " ".repeat(width - leftWidth - rightWidth) + right;

	const available = width - leftWidth - MIN_PADDING;
	if (available <= 0) return leftStr;

	const truncatedRight = truncateToWidth(right, available, "");
	const pad = Math.max(0, width - leftWidth - visibleWidth(truncatedRight));
	return leftStr + " ".repeat(pad) + truncatedRight;
}

export default function (pi: ExtensionAPI) {
	/** Whether our footer is currently installed, so the command can toggle. */
	let installed = false;

	pi.registerCommand("oc-footer", {
		description: "Toggle the OpenCode-style footer",
		handler: async (_args, ctx) => {
			if (installed) {
				ctx.ui.setFooter(undefined);
				installed = false;
				ctx.ui.notify("Built-in footer restored", "info");
				return;
			}

			ctx.ui.setFooter((tui, theme, footerData) => {
				// Without this the branch would only refresh on the next unrelated
				// render, so a checkout would appear stale.
				const unsub = footerData.onBranchChange(() => tui.requestRender());

				return {
					dispose: unsub,
					invalidate() {
						// Nothing cached: render() reads live state every call.
					},

					render(width: number): string[] {
						const lines: string[] = [];

						// ── Location ────────────────────────────────────────────
						let location = shortenHome(ctx.sessionManager.getCwd());
						const branch = footerData.getGitBranch();
						if (branch) location += ` (${branch})`;
						const sessionName = ctx.sessionManager.getSessionName();
						if (sessionName) location += ` • ${sessionName}`;
						lines.push(
							truncateToWidth(theme.fg("dim", location), width, theme.fg("dim", "...")),
						);

						// ── Usage totals ────────────────────────────────────────
						let input = 0;
						let output = 0;
						let cost = 0;
						for (const e of ctx.sessionManager.getBranch()) {
							if (e.type === "message" && e.message.role === "assistant") {
								const m = e.message as AssistantMessage;
								// Cache reads/writes are real context spend, so they belong
								// in the input figure rather than being dropped.
								input += m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
								output += m.usage.output;
								cost += m.usage.cost.total;
							}
						}

						const stats: string[] = [];
						if (input) stats.push(theme.fg("dim", `↑${formatTokens(input)}`));
						if (output) stats.push(theme.fg("dim", `↓${formatTokens(output)}`));
						if (cost) stats.push(theme.fg("dim", `$${cost.toFixed(3)}`));

						// Context percent keeps its severity color: a red 95% must not
						// be muted into the surrounding grey.
						const usage = ctx.getContextUsage();
						if (usage) {
							const pct = usage.percent;
							const label =
								pct === null
									? `?/${formatTokens(usage.contextWindow)}`
									: `${pct.toFixed(0)}%/${formatTokens(usage.contextWindow)}`;
							stats.push(
								pct !== null && pct > 90
									? theme.fg("error", label)
									: pct !== null && pct > 70
										? theme.fg("warning", label)
										: theme.fg("dim", label),
							);
						}

						// Extension statuses share the stats line instead of taking a
						// third: subagent progress is why this footer exists, so it
						// belongs beside the cost it is accruing.
						for (const [, text] of Array.from(
							footerData.getExtensionStatuses().entries(),
						).sort(([a], [b]) => a.localeCompare(b))) {
							const clean = sanitizeStatusText(text);
							if (clean) stats.push(theme.fg("accent", clean));
						}

						let right = ctx.model?.id ?? "no-model";
						if (ctx.model?.reasoning) {
							const level = pi.getThinkingLevel() || "off";
							right += level === "off" ? " • thinking off" : ` • ${level}`;
						}

						lines.push(fit(stats.join(theme.fg("dim", " · ")), theme.fg("dim", right), width));

						// ── Keybind hints ───────────────────────────────────────
						if (width >= HINTS_MIN_WIDTH)
							lines.push(
								HINTS.map(
									([key, label]) => `${theme.fg("muted", key)} ${theme.fg("dim", label)}`,
								).join("  "),
							);

						return lines;
					},
				};
			});
			installed = true;
			ctx.ui.notify("OpenCode-style footer enabled", "info");
		},
	});
}
