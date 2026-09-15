/**
 * Tests for the widget line fitter.
 *
 * The bug these guard against killed a subagent outright: an over-wide widget
 * line makes pi's TUI host throw an uncaughtException, so "the line is too
 * wide" and "the process died" are the same event. The cases below are the ones
 * a hand-rolled `slice` gets wrong — ANSI styling, OSC-8 links, and the
 * unusable widths pi reports around startup and resize.
 */

import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Text } from "@earendil-works/pi-tui/dist/components/text.js";
import { fitLines, fittedWidget } from "./widget.js";

/** The exact line that crashed a 13-column Run Pane, styling and all. */
const MCP_LINE =
	"\u001b[38;2;158;206;106m●\u001b[39m mcp: \u001b[38;2;192;202;245mlitellm-gateway\u001b[39m\u001b[38;2;86;95;137m 59 tools\u001b[39m";

describe("fitLines", () => {
	test("truncates the line that crashed a narrow Run Pane", () => {
		expect(visibleWidth(MCP_LINE)).toBe(31);
		const [fitted] = fitLines([MCP_LINE], 13);
		expect(visibleWidth(fitted!)).toBeLessThanOrEqual(13);
	});

	test("measures visible columns, not bytes — a styled line that fits is untouched", () => {
		// .length here is ~90; the visible width is 31. A byte-counting fitter
		// would truncate this needlessly and cut mid-escape.
		expect(MCP_LINE.length).toBeGreaterThan(31);
		expect(fitLines([MCP_LINE], 40)).toEqual([MCP_LINE]);
	});

	test("does not pad a line narrower than the width", () => {
		expect(fitLines(["ab"], 10)).toEqual(["ab"]);
	});

	test("holds the width assertion for every line, not just the first", () => {
		const lines = ["short", MCP_LINE, "also short"];
		for (const line of fitLines(lines, 8)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(8);
		}
	});

	test("an unusable width passes lines through rather than blanking the widget", () => {
		// pi reports 0 before its first measurement and can go negative mid-resize.
		for (const width of [0, -1, Number.NaN]) {
			expect(fitLines([MCP_LINE], width)).toEqual([MCP_LINE]);
		}
	});

	test("never returns the caller's array, so a widget cannot be mutated by us", () => {
		const lines = ["a"];
		expect(fitLines(lines, 0)).not.toBe(lines);
	});
});

describe("fittedWidget", () => {
	test("rebuilds lines on each render, so a widget cannot go stale", () => {
		let n = 0;
		const widget = fittedWidget(() => [`call ${++n}`]);
		expect(widget.render(80)).toEqual(["call 1"]);
		expect(widget.render(80)).toEqual(["call 2"]);
	});

	test("fits what the builder produced", () => {
		const widget = fittedWidget(() => [MCP_LINE]);
		expect(visibleWidth(widget.render(13)[0]!)).toBeLessThanOrEqual(13);
	});
});

describe("pi-tui's Text component", () => {
	// The plan extension's widget delegates to Text instead of fitting, which is
	// only safe if Text itself holds pi's width assertion. An architecture review
	// flagged that widget as the last member of the fatal crash class; this test
	// is why it was left alone. If a pi upgrade breaks the guarantee, this fails
	// here rather than by killing a subagent in a narrow Run Pane.
	test("wraps to the assertion at hostile widths, unbroken tokens included", () => {
		const text = new Text(
			"● p7 agent/extensions/subagent/index.ts:1249-executeAttemptWithSlot",
			0,
			0,
		);
		for (const width of [80, 13, 8, 4, 2]) {
			text.invalidate();
			for (const line of text.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});
