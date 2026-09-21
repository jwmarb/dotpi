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
import {
	cachedByWidth,
	fitLines,
	fittedWidget,
	frame,
	row,
} from "./widget.js";

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
	// A widget may delegate to Text instead of fitting, which is only safe if
	// Text itself holds pi's width assertion. That is the standing justification
	// for leaving such a widget alone; if a pi upgrade breaks the guarantee, this
	// fails here rather than by killing a subagent in a narrow Run Pane.
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

/** A path long enough to need truncating in any realistic pane. */
const LONG_PATH = "agent/extensions/subagent-herdr/child-done.ts";

describe("row", () => {
	test("gives the flexing cell whatever the fixed cells leave", () => {
		const line = row(
			[{ text: ">" }, { text: LONG_PATH, flex: true }, { text: " +3/-1" }],
			30,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(30);
		// The fixed cells survive in full; only the flexing cell gives ground.
		expect(line.startsWith(">")).toBe(true);
		expect(line.endsWith(" +3/-1")).toBe(true);
	});

	test("keeps the row within the width at every hostile width", () => {
		// The crash class: a row built for one width rendered into a narrower one.
		for (let width = 1; width <= 60; width++) {
			const line = row(
				[
					{ text: "  " },
					{ text: MCP_LINE, flex: true },
					{ text: "  +120/-8" },
				],
				width,
			);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	test("measures visible columns, so a styled cell is not over-truncated", () => {
		// MCP_LINE is ~90 bytes and 31 columns. A byte-counting row would cut it.
		const line = row([{ text: MCP_LINE, flex: true }], 40);
		expect(line).toBe(MCP_LINE);
	});

	test("a row with no flexing cell is still measured", () => {
		const line = row([{ text: MCP_LINE }], 13);
		expect(visibleWidth(line)).toBeLessThanOrEqual(13);
	});

	test("fill pads the flexing cell so later cells sit at the right edge", () => {
		const line = row(
			[{ text: "ab", flex: true, fill: true }, { text: "|" }],
			10,
		);
		expect(visibleWidth(line)).toBe(10);
		expect(line.endsWith("|")).toBe(true);
	});

	test("honours the flexing cell's minimum when the fixed cells overflow", () => {
		// Fixed cells alone exceed the width: the flex cell keeps `min`, and the
		// finished row is still cut to the width rather than reaching the host.
		const line = row(
			[{ text: "x".repeat(40) }, { text: LONG_PATH, flex: true, min: 6 }],
			20,
		);
		expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});

	test("an unusable width does not blank the row", () => {
		for (const width of [0, -1, Number.NaN]) {
			expect(row([{ text: "ab", flex: true }], width)).toBe("ab");
		}
	});
});

describe("frame", () => {
	test("emits lines of exactly the width, never wider", () => {
		const lines = frame(["short", MCP_LINE], { title: "Changed Files", width: 40 });
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	test("holds the assertion at every width, including below the border", () => {
		// The hand-rolled version floored the width at 10 and so emitted lines
		// WIDER than the width it was given — the exact shape that kills pi.
		for (let width = 1; width <= 60; width++) {
			for (const line of frame([MCP_LINE, LONG_PATH], { title: LONG_PATH, width })) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("drops the border rather than overflowing when it cannot fit", () => {
		const lines = frame(["abcdef"], { title: "T", width: 5 });
		expect(lines.some((l) => l.includes("╭"))).toBe(false);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(5);
		}
	});

	test("truncates a title too long for the border", () => {
		const [top] = frame([], { title: LONG_PATH, width: 24 });
		expect(visibleWidth(top!)).toBe(24);
	});

	test("styles the title through the callback, not a Theme", () => {
		const [top] = frame([], {
			title: "Files",
			width: 30,
			styleTitle: (t) => `<${t}>`,
		});
		expect(top).toContain("<Files>");
		// Assert the width too: this test used to pass while emitting 32 columns
		// for a declared 30, because a styling callback may add visible columns
		// and the dash budget was measured from the unstyled title.
		expect(visibleWidth(top!)).toBe(30);
	});

	test("holds the width when styleTitle adds visible columns", () => {
		for (const width of [10, 13, 20, 30, 40]) {
			for (const styleTitle of [
				(t: string) => `<${t}>`,
				(t: string) => `          ${t}          `,
			]) {
				for (const line of frame(["body"], { title: "Files", width, styleTitle })) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("an unusable width passes the body through", () => {
		expect(frame(["ab"], { title: "T", width: 0 })).toEqual(["ab"]);
	});
});

describe("cachedByWidth", () => {
	test("rebuilds when the width changes, so a resize cannot serve stale lines", () => {
		// The bug this replaces: a cache keyed on nothing returned lines built
		// for the first width forever.
		let calls = 0;
		const c = cachedByWidth((width) => {
			calls++;
			return [`w=${width}`];
		});
		expect(c.render(80)).toEqual(["w=80"]);
		expect(c.render(80)).toEqual(["w=80"]);
		expect(calls).toBe(1); // same width: served from cache
		expect(c.render(20)).toEqual(["w=20"]);
		expect(calls).toBe(2); // narrower width: rebuilt
	});

	test("invalidate discards the cached draw for a state change", () => {
		let n = 0;
		const c = cachedByWidth(() => [`call ${++n}`]);
		expect(c.render(80)).toEqual(["call 1"]);
		c.invalidate();
		expect(c.render(80)).toEqual(["call 2"]);
	});

	test("fits what the builder produced", () => {
		const c = cachedByWidth(() => [MCP_LINE]);
		expect(visibleWidth(c.render(13)[0]!)).toBeLessThanOrEqual(13);
	});

	test("a caller mutating the result cannot poison the cache", () => {
		// An injected line is an unmeasured line, which is the fatal class.
		const c = cachedByWidth(() => ["real"]);
		c.render(20).push("x".repeat(99));
		expect(c.render(20)).toEqual(["real"]);
	});
});

describe("hostile widths and wide characters", () => {
	// Cases an ANSI-naive or byte-counting implementation gets wrong. A wide
	// grapheme is two columns, so `.length` under-measures and a careless
	// truncate can split one in half.
	const CJK = "\u65e5\u672c\u8a9e\u306e\u30d5\u30a1\u30a4\u30eb\u540d";
	const EMOJI = "\ud83c\udf89\ud83c\udf89\ud83c\udf89\ud83c\udf89\ud83c\udf89";
	const FAMILY = "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66";

	test("row holds the width for wide graphemes", () => {
		for (const text of [CJK, EMOJI, FAMILY]) {
			for (let width = 1; width <= 30; width++) {
				expect(
					visibleWidth(row([{ text, flex: true }], width)),
				).toBeLessThanOrEqual(width);
			}
		}
	});

	test("frame holds the width for wide graphemes, in body and title", () => {
		for (const text of [CJK, EMOJI, FAMILY]) {
			for (let width = 1; width <= 30; width++) {
				for (const line of frame([text], { title: text, width })) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("a fractional width is treated as its floor, never rounded up", () => {
		for (const width of [10.5, 7.9, 12.1, 1.2]) {
			expect(
				visibleWidth(row([{ text: LONG_PATH, flex: true }], width)),
			).toBeLessThanOrEqual(Math.floor(width));
			for (const line of frame([LONG_PATH], { title: "T", width })) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(Math.floor(width));
			}
		}
	});

	test("an infinite width does not truncate and does not throw", () => {
		expect(row([{ text: "ab", flex: true }], Number.POSITIVE_INFINITY)).toBe("ab");
	});

	test("an empty cells array yields an empty row", () => {
		expect(row([], 10)).toBe("");
	});
});
