/**
 * Widget line construction and fitting.
 *
 * pi's TUI host asserts that every line a widget renders is no wider than the
 * terminal, and a violation is not a cosmetic glitch: `TuiMainScreen.doRender`
 * throws an uncaughtException and the whole `pi` process dies. That is fatal in
 * a narrow **Run Pane**, where a **Native Run**'s pane can be a dozen columns
 * wide — a subagent was killed mid-task by a 31-column MCP status line drawn
 * into a 13-column pane.
 *
 * ## Why this module builds lines instead of only measuring them
 *
 * `fitLines` used to be the whole module, which made measurement *opt-in*: a
 * widget that forgot to call it crashed the process, and one did. Every
 * hand-built widget in this repo turned out to need the same three things —
 * a bordered frame, a row of fixed cells with one column absorbing the slack,
 * and a render cache — so each had reimplemented them, with drifting
 * arithmetic (two row builders computed the same path budget as `-1` and `-2`)
 * and one line pushed with no measurement at all.
 *
 * So the seam moved: callers describe a row's *cells* and a frame's *body*, and
 * this module does the measuring. A caller cannot emit an unmeasured line
 * because a caller no longer assembles one.
 *
 * A widget that delegates to pi-tui's own `Text` needs nothing from us — `Text`
 * wraps with `wrapTextWithAnsi` and holds the assertion down to a width of 2,
 * including for an unbroken token like a file path. So "every widget goes
 * through this module" is not the rule; "every widget either measures or
 * delegates to something that does" is. A viewer writing to a real PTY is
 * outside this module's reach in any case: there an over-wide line wraps
 * instead of killing the process.
 *
 * ## Measurement
 *
 * Measurement is `visibleWidth`, never `String.length`: our lines carry ANSI
 * styling and OSC-8 links whose bytes are not columns, so `.length`
 * over-measures wildly and would truncate mid-escape — leaving the terminal
 * bleeding colour into everything below it. `truncateToWidth` is ANSI-aware and
 * closes the sequences it cuts, which is why we do not slice by hand.
 *
 * This module is deliberately free of `pi-coding-agent` imports: it takes a
 * style callback rather than a `Theme`, so it can be tested without a live
 * agent and cannot drift with pi's export surface.
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

/** Default minimum visible columns kept for a flexing cell. */
const FLEX_MIN_WIDTH = 4;

/**
 * One cell of a {@link row}.
 *
 * Spacing between cells is part of a cell's own `text`: cells are concatenated
 * with no separator, because the callers that need this each space their
 * columns differently and an implicit gap would be a fourth thing to get
 * wrong.
 */
export interface RowCell {
	/** The cell's text, ANSI styling included. */
	text: string;
	/**
	 * Marks the one cell that absorbs the row's remaining columns. Every other
	 * cell keeps its natural width; this one is truncated to whatever is left.
	 */
	flex?: boolean;
	/** Minimum columns the flexing cell keeps. Default {@link FLEX_MIN_WIDTH}. */
	min?: number;
	/**
	 * Pad the flexing cell out to its full share, so the cells after it sit at
	 * the row's right edge. Off by default: an unpadded row lets a short value
	 * follow its label immediately.
	 */
	fill?: boolean;
}

/**
 * Build one row of fixed cells plus one flexing cell, fitted to `width`.
 *
 * This replaces the "compute a budget for the long column by subtracting
 * everything else" arithmetic that every row builder was doing by hand. The
 * flexing cell is truncated (ANSI-aware) to the columns its siblings leave it,
 * never below `min`, and the finished row is measured so it satisfies pi's
 * width assertion even when the fixed cells alone overflow.
 *
 * @param cells - The row's cells, in display order. At most one may flex.
 * @param width - The width pi passed to `render`. Non-positive means unknown.
 * @returns A single line no wider than `width`.
 */
export function row(cells: readonly RowCell[], width: number): string {
	const flexIndex = cells.findIndex((c) => c.flex);
	if (flexIndex === -1 || !widthIsUsable(width)) {
		// Nothing to apportion, or no width to apportion it against: the row is
		// still measured, so an over-wide caller cannot reach the host.
		return fitLines([cells.map((c) => c.text).join("")], width)[0] ?? "";
	}

	const flexCell = cells[flexIndex]!;
	const fixedWidth = cells.reduce(
		(sum, c, i) => (i === flexIndex ? sum : sum + visibleWidth(c.text)),
		0,
	);
	const share = Math.max(flexCell.min ?? FLEX_MIN_WIDTH, width - fixedWidth);

	let flexText =
		visibleWidth(flexCell.text) > share
			? truncateToWidth(flexCell.text, share)
			: flexCell.text;
	if (flexCell.fill) {
		flexText += " ".repeat(Math.max(0, share - visibleWidth(flexText)));
	}

	const line = cells
		.map((c, i) => (i === flexIndex ? flexText : c.text))
		.join("");
	return fitLines([line], width)[0] ?? "";
}

/**
 * The narrowest width worth drawing a border at. A frame spends four columns
 * on `"│ "` and `" │"`, so below this there is no room for content.
 */
const FRAME_MIN_WIDTH = 8;

/** Options for {@link frame}. */
export interface FrameOptions {
	/** Plain-text title shown in the top border. */
	title: string;
	/** The width pi passed to `render`. Non-positive means unknown. */
	width: number;
	/**
	 * Styles the title inside the border. Kept as a callback so this module
	 * needs no `Theme`, and so tests can assert on unstyled output.
	 */
	styleTitle?: (title: string) => string;
}

/**
 * Draw `body` inside a rounded border, fitted to `width`.
 *
 * No line the frame emits is ever wider than `width`. The hand-rolled version
 * this replaces widened a narrow render to a floor of 10 columns, which meant it
 * deliberately emitted lines *wider than the width it was handed*: the precise
 * shape that kills the host. Here a width below {@link FRAME_MIN_WIDTH} drops
 * the border instead and returns fitted content (unpadded, so narrower than
 * `width`), because a box that cannot fit its own walls is worth less than the
 * text. At any width that does fit a border, every line is exactly `width`.
 *
 * @param body - Content lines, ANSI styling included.
 * @param opts - Title, width, and optional title styling.
 * @returns The framed lines, each no wider than `width`.
 */
export function frame(
	body: readonly string[],
	opts: FrameOptions,
): string[] {
	const { title, width, styleTitle } = opts;
	if (!widthIsUsable(width)) return [...body];
	if (width < FRAME_MIN_WIDTH) return fitLines(body, width);

	const w = Math.floor(width);
	const innerW = w - 4; // "│ " + content + " │"

	// Top border: `╭─ Title ───╮`
	//
	// The dash budget is measured from the *styled* title, never the plain one:
	// a `styleTitle` callback is free to add visible columns (padding, brackets),
	// and budgeting from the unstyled text let that width escape as pure
	// overflow — a review caught this emitting 32 columns for a declared 30.
	const maxTitle = Math.max(1, w - 8);
	const shownTitle =
		visibleWidth(title) > maxTitle ? truncateToWidth(title, maxTitle) : title;
	let styled = styleTitle ? styleTitle(shownTitle) : shownTitle;
	if (visibleWidth(styled) > maxTitle) {
		// The callback overspent its budget. Cut the styled result, which is
		// ANSI-aware, rather than trusting the caller to have behaved.
		styled = truncateToWidth(styled, maxTitle);
	}
	const dashes = Math.max(
		0,
		w - visibleWidth("╭─ ") - visibleWidth(styled) - 2,
	);
	// Measured, not trusted: the border is assembled from three sources (the
	// styled title, the dash run, the corners) and only measurement can hold the
	// guarantee across all of them.
	const out: string[] = fitLines(
		[`╭─ ${styled} ${"─".repeat(dashes)}╮`],
		w,
	);

	for (const line of body) {
		const fitted =
			visibleWidth(line) > innerW ? truncateToWidth(line, innerW) : line;
		const pad = Math.max(0, innerW - visibleWidth(fitted));
		out.push(`│ ${fitted}${" ".repeat(pad)} │`);
	}

	out.push(`╰${"─".repeat(w - 2)}╯`);
	return out;
}

/**
 * A component that rebuilds its lines whenever the render width changes.
 *
 * The caches this replaces were keyed on nothing: a viewer stored its rendered
 * lines in a variable and returned them for every later render, so the first
 * render's width outlived the terminal it was measured against and a resize
 * served lines built for the old width. Keying the cache on the width is what
 * makes that unrepresentable, and the result is fitted regardless.
 *
 * `invalidate` discards the cached draw, for when the caller's *state* changed
 * rather than the width.
 *
 * @param build - Renders the current lines for a given width, unfitted.
 * @returns A component for `ctx.ui.custom` or `ctx.ui.setWidget`.
 */
export function cachedByWidth(build: (width: number) => readonly string[]): {
	render: (width: number) => string[];
	invalidate: () => void;
} {
	let cachedWidth: number | undefined;
	let cachedLines: string[] | undefined;
	return {
		render: (width: number) => {
			if (!cachedLines || cachedWidth !== width) {
				cachedLines = fitLines(build(width), width);
				cachedWidth = width;
			}
			// A copy, never the cache itself: a caller that mutates what it gets
			// back would otherwise poison every later render at this width, and an
			// injected line is an unmeasured line. `fitLines` holds the same
			// property for the same reason.
			return [...cachedLines];
		},
		invalidate: () => {
			cachedLines = undefined;
			cachedWidth = undefined;
		},
	};
}
