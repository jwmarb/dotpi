import { describe, expect, test } from "bun:test";
import {
	FIRST_MESSAGE_MAX_CHARS,
	formatSessionDate,
	normalizePreview,
	truncatePreview,
} from "../sessions.js";

describe("normalizePreview", () => {
	test("strips control characters and collapses whitespace", () => {
		expect(normalizePreview("line1\nline2\ttab\x01ctrl  double")).toBe(
			"line1 line2 tab ctrl double",
		);
	});

	test("returns empty string for all-control input", () => {
		expect(normalizePreview("\n\t\x01\x00")).toBe("");
	});

	test("trims leading and trailing whitespace", () => {
		expect(normalizePreview("  hello  ")).toBe("hello");
	});
});

describe("truncatePreview", () => {
	test("leaves short text unchanged", () => {
		expect(truncatePreview("short")).toBe("short");
	});

	test("keeps text at exactly the cap unchanged", () => {
		const text = "a".repeat(FIRST_MESSAGE_MAX_CHARS);
		expect(truncatePreview(text)).toBe(text);
	});

	test("truncates text over the cap and appends an ellipsis", () => {
		const text = "a".repeat(FIRST_MESSAGE_MAX_CHARS + 1);
		const out = truncatePreview(text);
		expect(out.length).toBe(FIRST_MESSAGE_MAX_CHARS + 1); // cap + "…"
		expect(out.endsWith("…")).toBe(true);
		expect(out.slice(0, FIRST_MESSAGE_MAX_CHARS)).toBe("a".repeat(FIRST_MESSAGE_MAX_CHARS));
	});
});

describe("formatSessionDate", () => {
	test("formats the current year without a year suffix", () => {
		const year = new Date().getFullYear();
		expect(formatSessionDate(new Date(year, 8, 21, 9, 5))).toBe("Sep 21 09:05");
	});

	test("formats other years with a two-digit year suffix", () => {
		expect(formatSessionDate(new Date(2025, 3, 14, 8, 7))).toBe("Apr 14 '25 08:07");
	});

	test("pads single-digit days", () => {
		const year = new Date().getFullYear();
		expect(formatSessionDate(new Date(year, 0, 5, 3, 2))).toBe("Jan 05 03:02");
	});
});
