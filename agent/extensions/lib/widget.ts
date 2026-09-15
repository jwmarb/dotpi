/**
 * Widget line fitting.
 *
 * pi's TUI host asserts that every line a widget renders is no wider than the
 * terminal, and a violation is not a cosmetic glitch: `TuiMainScreen.doRender`
 * throws an uncaughtException and the whole `pi` process dies. That is fatal in
 * a narrow **Run Pane**, where a **Native Run**'s pane can be a dozen columns
 * wide — a subagent was killed mid-task by a 31-column MCP status line drawn
 * into a 13-column pane.
 *
 * A widget that builds its own lines must render through `fitLines`. The seam is
 * the widget's `render(width)` argument, which pi already passes and which each
 * of our hand-built widgets used to ignore: building lines eagerly, before a
 * width is known, is exactly the shape that crashes, because nothing measures
 * the result. `fitLines` is the one place that measurement lives.
 *
 * A widget that delegates to pi-tui's own `Text` needs nothing from us — `Text`
 * wraps with `wrapTextWithAnsi` and holds the assertion down to a width of 2,
 * including for an unbroken token like a file path. The plan extension's widget
 * is that shape deliberately, so "every widget goes through `fitLines`" is not
 * the rule; "every widget either measures or delegates to something that does"
 * is. Our two standalone viewers (`plan/board.ts`, `subagent/mirror.ts`) are
 * outside this module's reach in any case: they write to a real PTY, where an
 * over-wide line wraps instead of killing the process.
 *
 * Measurement is `visibleWidth`, never `String.length`: our lines carry ANSI
 * styling and OSC-8 links whose bytes are not columns, so `.length`
 * over-measures wildly and would truncate mid-escape — leaving the terminal
 * bleeding colour into everything below it. `truncateToWidth` is ANSI-aware and
 * closes the sequences it cuts, which is why we do not slice by hand.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * A width pi may hand a widget that is not usable. pi reports `0` before the
 * first real measurement and can report a negative width mid-resize; treating
 * either as "no room at all" would blank the widget on every startup, so an
 * unusable width means "do not truncate" and the caller's lines pass through.
 */
function widthIsUsable(width: number): boolean {
	return Number.isFinite(width) && width > 0;
}

/**
 * Truncate `lines` so none exceeds `width` visible columns.
 *
 * Safe to wrap any widget's output, including lines that already fit — a line
 * narrower than `width` is returned untouched (no padding), so a widget's own
 * spacing survives.
 *
 * @param lines - The widget's rendered lines, ANSI styling included.
 * @param width - The width pi passed to `render`. Non-positive means unknown.
 * @returns Lines guaranteed to satisfy pi's width assertion.
 */
export function fitLines(lines: readonly string[], width: number): string[] {
	if (!widthIsUsable(width)) return [...lines];
	return lines.map((line) =>
		visibleWidth(line) > width ? truncateToWidth(line, width) : line,
	);
}

/**
 * Build a widget component whose lines are fitted to the render width.
 *
 * Takes a *thunk* rather than an array so the lines are rebuilt on each render:
 * a widget's state changes between renders, and capturing an array once is how
 * a stale widget happens. `invalidate` is a no-op because `build` is pure over
 * the caller's current state — there is no cached draw to discard.
 *
 * @param build - Produces the current lines, unfitted.
 * @returns A component for `ctx.ui.setWidget`.
 */
export function fittedWidget(build: () => readonly string[]): {
	render: (width: number) => string[];
	invalidate: () => void;
} {
	return {
		render: (width: number) => fitLines(build(), width),
		invalidate: () => {},
	};
}
