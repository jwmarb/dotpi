import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { visibleWidth } from "@earendil-works/pi-tui";

import {
	actionableCards,
	applyOp,
	buildProjection,
	cleanText,
	compactLines,
	decideSplit,
	describeOp,
	emptyState,
	findOnPath,
	paneCommand,
	formatCardList,
	KanbanError,
	linkedRunIds,
	MAX_CARDS,
	MAX_TERMINAL_DIM,
	nudgeFor,
	opFromParams,
	parseBoardArgs,
	parseColumn,
	parseCommand,
	parseProjection,
	parseSnapshot,
	PLAIN_STYLE,
	reconstructFromEntries,
	renderBody,
	renderFrame,
	settleSignature,
	shellJoin,
	shellQuote,
	staleRuntimeOwner,
	STATE_ENTRY_TYPE,
	stateDigest,
	summarize,
	TOOL_NAME,
	type KanbanOp,
	type KanbanState,
	type RunInfos,
	type SessionEntryLike,
} from "./lib.js";
import { readRunInfo, readRunInfos } from "./runs.js";

const run = (...ops: KanbanOp[]): KanbanState => ops.reduce(applyOp, emptyState());

const board = (): KanbanState =>
	run(
		{ op: "add", titles: ["parse the header", "write the test", "wire the pane"] },
		{ op: "move", id: "k1", column: "in_progress" },
	);

const card = (s: KanbanState, id: string) => s.cards.find((c) => c.id === id)!;

const toolEntry = (state: unknown, extra: Record<string, unknown> = {}): SessionEntryLike => ({
	type: "message",
	message: { role: "toolResult", toolName: TOOL_NAME, details: { state }, ...extra },
});
const customEntry = (state: unknown): SessionEntryLike => ({ type: "custom", customType: STATE_ENTRY_TYPE, data: { state } });

describe("applyOp: add", () => {
	test("mints sequential ids into backlog and bumps revision once", () => {
		const s = run({ op: "add", titles: ["a", "b"] });
		expect(s.cards.map((c) => [c.id, c.column])).toEqual([
			["k1", "backlog"],
			["k2", "backlog"],
		]);
		expect(s.nextId).toBe(3);
		expect(s.revision).toBe(1);
	});

	test("ids are never reused after a drop", () => {
		const s = run({ op: "add", titles: ["a", "b"] }, { op: "drop", id: "k2" }, { op: "add", titles: ["c"] });
		expect(s.cards.map((c) => c.id)).toEqual(["k1", "k3"]);
	});

	test("accepts a starting column but refuses blocked (it needs a note)", () => {
		expect(run({ op: "add", titles: ["a"], column: "in_progress" }).cards[0]!.column).toBe("in_progress");
		expect(() => run({ op: "add", titles: ["a"], column: "blocked" })).toThrow(KanbanError);
	});

	test("trims, drops empty titles, refuses an all-empty add", () => {
		expect(run({ op: "add", titles: ["  a  ", "", "  "] }).cards.map((c) => c.title)).toEqual(["a"]);
		expect(() => run({ op: "add", titles: ["", " "] })).toThrow(KanbanError);
	});

	test("strips control bytes so a title cannot inject terminal escapes", () => {
		const s = run({ op: "add", titles: ["evil\x1b[2J\x1b]8;;x\x07 title\nline"] });
		expect(s.cards[0]!.title).not.toContain("\x1b");
		expect(s.cards[0]!.title).not.toContain("\n");
	});

	test("refuses past the card cap", () => {
		let s = emptyState();
		for (let i = 0; i < MAX_CARDS / 20; i++) s = applyOp(s, { op: "add", titles: Array.from({ length: 20 }, (_, j) => `t${i}-${j}`) });
		expect(s.cards.length).toBe(MAX_CARDS);
		expect(() => applyOp(s, { op: "add", titles: ["one more"] })).toThrow(/clear_done/);
		expect(s.cards.length).toBe(MAX_CARDS);
	});

	test("a snapshot past the card cap is not a valid board", () => {
		let s = emptyState();
		for (let i = 0; i < MAX_CARDS / 20; i++) s = applyOp(s, { op: "add", titles: Array.from({ length: 20 }, (_, j) => `t${i}-${j}`) });
		expect(parseSnapshot(s)).toBeDefined();
		const over = { ...s, cards: [...s.cards, { ...s.cards[0]!, id: `k${s.nextId}` }], nextId: s.nextId + 1 };
		expect(parseSnapshot(over)).toBeUndefined();
	});
});

describe("applyOp: move and note", () => {
	test("several cards may be in progress at once (no WIP limit)", () => {
		const s = run(
			{ op: "add", titles: ["a", "b", "c"] },
			{ op: "move", id: "k1", column: "in_progress" },
			{ op: "move", id: "k2", column: "in_progress" },
		);
		expect(s.cards.filter((c) => c.column === "in_progress").length).toBe(2);
	});

	test("blocked needs a note; leaving blocked drops the stale blocker note", () => {
		const s = board();
		expect(() => applyOp(s, { op: "move", id: "k2", column: "blocked" })).toThrow(/note/);
		const blocked = applyOp(s, { op: "move", id: "k2", column: "blocked", note: "waits on API key" });
		expect(blocked.cards.find((c) => c.id === "k2")!.note).toBe("waits on API key");
		const resumed = applyOp(blocked, { op: "move", id: "k2", column: "in_progress" });
		expect(resumed.cards.find((c) => c.id === "k2")!.note).toBeUndefined();
	});

	test("a move to the same column is refused unless it carries a note", () => {
		const s = board();
		expect(() => applyOp(s, { op: "move", id: "k1", column: "in_progress" })).toThrow(/already/);
		expect(applyOp(s, { op: "move", id: "k1", column: "in_progress", note: "half done" }).cards.find((c) => c.id === "k1")!.note).toBe(
			"half done",
		);
	});

	test("a blank note on move keeps the existing note instead of erasing it", () => {
		const noted = applyOp(board(), { op: "note", id: "k1", note: "evidence: 12 tests pass" });
		const moved = applyOp(noted, { op: "move", id: "k1", column: "review", note: "  " });
		expect(card(moved, "k1").note).toBe("evidence: 12 tests pass");
		expect(() => applyOp(noted, { op: "move", id: "k1", column: "in_progress", note: "" })).toThrow(/already/);
		expect(() => applyOp(board(), { op: "move", id: "k2", column: "blocked", note: " \u001b " })).toThrow(/note/);
	});

	test("a moved card goes to the end of the array (arrival order in its column)", () => {
		const s = applyOp(board(), { op: "move", id: "k2", column: "done", note: "tests pass" });
		expect(s.cards.map((c) => c.id)).toEqual(["k3", "k1", "k2"]);
	});

	test("note sets and clears; a blocked card keeps its note", () => {
		const s = applyOp(board(), { op: "note", id: "k1", note: "found the bug" });
		expect(card(s, "k1").note).toBe("found the bug");
		expect(card(applyOp(s, { op: "note", id: "k1", note: "" }), "k1").note).toBeUndefined();
		const blocked = applyOp(s, { op: "move", id: "k2", column: "blocked", note: "x" });
		expect(() => applyOp(blocked, { op: "note", id: "k2", note: " " })).toThrow(KanbanError);
	});

	test("unknown ids and columns are refused with the known ids named", () => {
		expect(() => applyOp(board(), { op: "move", id: "k9", column: "done" })).toThrow(/Existing ids: k2, k3, k1/);
		expect(() => applyOp(board(), { op: "move", id: "k1", column: "nope" as never })).toThrow(/Columns/);
	});
});

describe("applyOp: link, drop, clear_done, immutability", () => {
	test("links validated, deduplicated run ids; unlink removes them", () => {
		const s = applyOp(board(), { op: "link", id: "k1", runId: "sub-a3f1" });
		expect(card(s, "k1").runIds).toEqual(["sub-a3f1"]);
		expect(() => applyOp(s, { op: "link", id: "k1", runId: "sub-a3f1" })).toThrow(/already/);
		expect(() => applyOp(s, { op: "link", id: "k1", runId: "../../etc" })).toThrow(/run id/);
		expect(card(applyOp(s, { op: "unlink", id: "k1", runId: "sub-a3f1" }), "k1").runIds).toBeUndefined();
		expect(() => applyOp(s, { op: "unlink", id: "k1", runId: "sub-0000" })).toThrow(/not linked/);
	});

	test("clear_done removes done cards and refuses when there are none", () => {
		const s = applyOp(board(), { op: "move", id: "k2", column: "done" });
		expect(applyOp(s, { op: "clear_done" }).cards.map((c) => c.id).sort()).toEqual(["k1", "k3"]);
		expect(() => applyOp(board(), { op: "clear_done" })).toThrow(KanbanError);
	});

	test("never mutates the input snapshot", () => {
		const s = board();
		const frozen = JSON.stringify(s);
		applyOp(s, { op: "link", id: "k1", runId: "sub-a3f1" });
		applyOp(s, { op: "move", id: "k2", column: "done" });
		applyOp(s, { op: "drop", id: "k3" });
		expect(JSON.stringify(s)).toBe(frozen);
	});

	test("a refused op leaves revision and cards untouched", () => {
		const s = board();
		expect(() => applyOp(s, { op: "drop", id: "k42" })).toThrow();
		expect(stateDigest(s)).toBe(stateDigest(board()));
	});
});

describe("parseSnapshot", () => {
	test("round-trips a real state and returns a defensive copy", () => {
		const s = applyOp(board(), { op: "link", id: "k1", runId: "sub-a3f1" });
		const parsed = parseSnapshot(JSON.parse(JSON.stringify(s)))!;
		expect(stateDigest(parsed)).toBe(stateDigest(s));
		card(parsed, "k1").title = "changed";
		expect(card(s, "k1").title).toBe("parse the header");
	});

	test.each([
		["wrong schema", { ...board(), schemaVersion: 2 }],
		["non-array cards", { ...board(), cards: {} }],
		["id at or above nextId", { ...board(), nextId: 2 }],
		["duplicate id", { ...board(), cards: [board().cards[0], board().cards[0]] }],
		["unknown column", { ...board(), cards: [{ id: "k1", title: "x", column: "doing" }] }],
		["bad run id", { ...board(), cards: [{ id: "k1", title: "x", column: "backlog", runIds: ["../x"] }] }],
		["negative revision", { ...board(), revision: -1 }],
		["null", null],
	])("rejects %s", (_name, value) => {
		expect(parseSnapshot(value)).toBeUndefined();
	});
});

describe("reconstructFromEntries (branch replay)", () => {
	const s1 = run({ op: "add", titles: ["a"] });
	const s2 = applyOp(s1, { op: "move", id: "k1", column: "in_progress" });
	const s3 = applyOp(s2, { op: "move", id: "k1", column: "done" });

	test("empty branch is an empty board", () => {
		expect(reconstructFromEntries([])).toEqual(emptyState());
	});

	test("latest snapshot wins across tool results and custom entries", () => {
		expect(stateDigest(reconstructFromEntries([toolEntry(s1), customEntry(s2)]))).toBe(stateDigest(s2));
		expect(stateDigest(reconstructFromEntries([customEntry(s1), toolEntry(s2), customEntry(s3)]))).toBe(stateDigest(s3));
	});

	test("rewind/fork: a branch cut before a snapshot does not see it", () => {
		const full = [toolEntry(s1), { type: "message", message: { role: "user" } }, toolEntry(s2), customEntry(s3)];
		expect(stateDigest(reconstructFromEntries(full.slice(0, 2)))).toBe(stateDigest(s1)); // before the tool result
		expect(stateDigest(reconstructFromEntries(full.slice(0, 3)))).toBe(stateDigest(s2)); // before the custom entry
	});

	test("ignores errored results, other tools, other custom types and malformed snapshots", () => {
		const entries: SessionEntryLike[] = [
			toolEntry(s2),
			toolEntry(s3, { isError: true }),
			{ type: "message", message: { role: "toolResult", toolName: "todo", details: { state: s3 } } },
			{ type: "custom", customType: "other", data: { state: s3 } },
			customEntry({ ...s3, schemaVersion: 99 }),
		];
		expect(stateDigest(reconstructFromEntries(entries))).toBe(stateDigest(s2));
	});

	test("equal revisions with different content are told apart by the digest", () => {
		const a = run({ op: "add", titles: ["a"] });
		const b = run({ op: "add", titles: ["b"] });
		expect(a.revision).toBe(b.revision);
		expect(stateDigest(a)).not.toBe(stateDigest(b));
	});
});

describe("projection", () => {
	test("build → JSON → parse round-trips", () => {
		const p = buildProjection({ seq: 4, ownerPid: 123, sessionId: "abc", leafId: null, state: board(), generatedAt: "t" });
		expect(parseProjection(JSON.parse(JSON.stringify(p)))).toEqual(p);
	});

	test("rejects a malformed state or missing identity", () => {
		const p = buildProjection({ seq: 1, ownerPid: 1, sessionId: "s", leafId: "l", state: board() });
		expect(parseProjection({ ...p, state: { cards: [] } })).toBeUndefined();
		expect(parseProjection({ ...p, sessionId: 3 })).toBeUndefined();
		expect(parseProjection({ ...p, seq: 1.5 })).toBeUndefined();
	});
});

describe("settle guard", () => {
	const delegated = (): KanbanState =>
		run(
			{ op: "add", titles: ["implement", "write docs", "verify"] },
			{ op: "move", id: "k1", column: "in_progress" },
			{ op: "link", id: "k1", runId: "sub-0001" },
		);
	const running: RunInfos = { "sub-0001": { status: "running", agent: "worker" } };
	const finished: RunInfos = { "sub-0001": { status: "done", agent: "worker" } };

	test("a card waiting on a running run is exempt, and so is the backlog queued behind it", () => {
		expect(actionableCards(delegated(), running)).toEqual([]);
		expect(nudgeFor(delegated(), running)).toBeUndefined();
	});

	test("once the run finishes, the card and the backlog need attention", () => {
		expect(actionableCards(delegated(), finished).map((c) => c.id).sort()).toEqual(["k1", "k2", "k3"]);
	});

	test("an in-progress card with no running run is never exempt", () => {
		const s = applyOp(delegated(), { op: "move", id: "k2", column: "in_progress" });
		expect(actionableCards(s, running).map((c) => c.id)).toEqual(["k2"]);
	});

	test("missing/unknown status does not exempt", () => {
		expect(actionableCards(delegated(), {}).map((c) => c.id)).toContain("k1");
	});

	test("blocked and done are accounted for", () => {
		const s = run(
			{ op: "add", titles: ["a", "b"] },
			{ op: "move", id: "k1", column: "blocked", note: "user decision" },
			{ op: "move", id: "k2", column: "done" },
		);
		expect(nudgeFor(s, {})).toBeUndefined();
	});

	test("review is accounted for only while something else is waiting", () => {
		// `dynamic-prompt.ts`'s `## Kanban Board` lists the accounted dispositions and omits
		// `review` on purpose, and extensions/AGENTS.md requires that list to stay a subset of
		// `actionableCards`' exemptions. This is the source of that claim: a `review` card is
		// counted while nothing is waiting, so moving a card to `review` does not settle the
		// turn — it is the one disposition `nudgeFor`'s own text offers that this guard does
		// not exempt, which is why the prompt must not list it.
		const toReview = run(
			{ op: "add", titles: ["a"] },
			{ op: "move", id: "k1", column: "review" },
		);
		expect(actionableCards(toReview, {}).map((c) => c.id)).toEqual(["k1"]);
		expect(nudgeFor(toReview, {})).toBeDefined();
		// With a sibling waiting on a running run it is exempt — the only condition under
		// which `review` settles a turn.
		const waiting = run(
			{ op: "add", titles: ["a", "b"] },
			{ op: "move", id: "k1", column: "review" },
			{ op: "move", id: "k2", column: "in_progress" },
			{ op: "link", id: "k2", runId: "sub-0001" },
		);
		expect(actionableCards(waiting, running)).toEqual([]);
	});

	test("the signature re-arms when a linked run changes status", () => {
		expect(settleSignature(delegated(), running)).not.toBe(settleSignature(delegated(), finished));
		expect(nudgeFor(delegated(), finished)!.signature).toBe(settleSignature(delegated(), finished));
	});

	test("the nudge names cards, flags finished runs and forbids gaming", () => {
		const text = nudgeFor(delegated(), finished)!.text;
		expect(text).toContain("k1");
		expect(text).toContain("collect their results");
		expect(text).toContain("Never move a card just to clear this message");
		// The offered dispositions must match `actionableCards`: a `review` card is counted
		// while nothing is waiting, so the guard may not offer `review` flat — that wording
		// told the model to perform the shuffle this same sentence forbids.
		expect(text).toContain("to review only while another card is waiting");
		expect(text).toContain("a review card is counted otherwise");
	});

	test("linkedRunIds skips done cards", () => {
		const s = applyOp(delegated(), { op: "move", id: "k1", column: "done" });
		expect(linkedRunIds(s)).toEqual([]);
		expect(linkedRunIds(delegated())).toEqual(["sub-0001"]);
	});
});

describe("text", () => {
	test("summarize is terse and empty-safe", () => {
		expect(summarize(emptyState())).toBe("Board is empty.");
		expect(summarize(board())).toBe("0/3 done · 1 in progress · 2 backlog");
	});

	test("describeOp names the new ids an add minted", () => {
		const before = board();
		const op: KanbanOp = { op: "add", titles: ["x", "y"] };
		expect(describeOp(before, applyOp(before, op), op)).toBe('Added k4 "x", k5 "y" to backlog.');
	});

	test("formatCardList groups by column with run statuses", () => {
		const s = applyOp(board(), { op: "link", id: "k1", runId: "sub-a3f1" });
		const text = formatCardList(s, { "sub-a3f1": { status: "running" } });
		expect(text).toContain("In progress (1)");
		expect(text).toContain("[sub-a3f1 running]");
	});
});

describe("layout", () => {
	const wide = "漢字のタイトル 🚀 emoji and a very long title that will need wrapping across lines";
	const busy = (): KanbanState =>
		run(
			{ op: "add", titles: [wide, "short", "another"] },
			{ op: "move", id: "k1", column: "in_progress", note: "a note that is quite long as well, long enough to wrap" },
			{ op: "link", id: "k1", runId: "sub-a3f1" },
			{ op: "move", id: "k2", column: "blocked", note: "waits" },
		);
	const runs: RunInfos = { "sub-a3f1": { status: "running", agent: "worker" } };

	test.each([1, 4, 12, 20, 36, 60, 80, 120, 140, 200])("every body line fits width %i", (width) => {
		for (const line of renderBody(busy(), runs, width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	test.each([
		[40, 10],
		[75, 69],
		[140, 20],
		[30, 3],
		[10, 1],
	])("frame %ix%i fits exactly", (width, height) => {
		const f = renderFrame({ state: busy(), runs, width, height, scroll: 0 });
		expect(f.lines.length).toBeLessThanOrEqual(height);
		for (const line of f.lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	});

	test("narrow panes stack, wide panes go side by side", () => {
		const narrow = renderBody(busy(), runs, 70).join("\n");
		expect(narrow).toContain("IN PROGRESS 1");
		expect(narrow).not.toContain("│");
		const wideBody = renderBody(busy(), runs, 140).join("\n");
		expect(wideBody).toContain("│");
		expect(wideBody).toContain("BACKLOG");
	});

	test("scroll is clamped and reported", () => {
		let s = emptyState();
		s = applyOp(s, { op: "add", titles: Array.from({ length: 20 }, (_, i) => `card ${i}`) });
		const f = renderFrame({ state: s, runs: {}, width: 40, height: 10, scroll: 999 });
		expect(f.scroll).toBe(f.maxScroll);
		expect(f.maxScroll).toBeGreaterThan(0);
		expect(f.lines.at(-1)).toContain("q close");
	});

	test("the frame reports its page size: the body rows, which shrink by one under a banner", () => {
		let s = emptyState();
		s = applyOp(s, { op: "add", titles: Array.from({ length: 20 }, (_, i) => `card ${i}`) });
		const plain = renderFrame({ state: s, runs: {}, width: 40, height: 12, scroll: 0 });
		const banner = renderFrame({ state: s, runs: {}, width: 40, height: 12, scroll: 0, banner: "stale" });
		expect(plain.room).toBe(12 - 2 - 1);
		expect(banner.room).toBe(plain.room - 1);
		expect(plain.lines.length).toBe(12);
	});

	test("a non-finite scroll falls back to the top instead of blanking the body", () => {
		const f = renderFrame({ state: board(), runs: {}, width: 40, height: 20, scroll: Number.NaN });
		expect(f.scroll).toBe(0);
		expect(f.lines.join("\n")).toContain("k1");
	});

	test("foreign text in the header and run badges cannot inject escapes", () => {
		const evil = "nm\u001b]0;HIJACKED\u0007\u001b[2J";
		const s = applyOp(board(), { op: "link", id: "k1", runId: "sub-a3f1" });
		const f = renderFrame({ state: s, runs: { "sub-a3f1": { status: "running", agent: evil } }, width: 80, height: 30, scroll: 0, label: evil });
		const out = f.lines.join("\n");
		expect(out).not.toContain("\u001b");
		expect(out).not.toContain("\u0007");
		expect(out).toContain("HIJACKED"); // degraded to harmless visible text
	});

	test("waiting and banner states render", () => {
		expect(renderFrame({ state: undefined, runs: {}, width: 40, height: 5, scroll: 0 }).lines.join("\n")).toContain("Waiting for pi");
		expect(renderFrame({ state: board(), runs: {}, width: 40, height: 6, scroll: 0, banner: "stale" }).lines[1]).toContain("stale");
	});

	test("a finished linked run on an in-progress card shows the attention badge", () => {
		expect(renderBody(busy(), { "sub-a3f1": { status: "done" } }, 60).join("\n")).toContain("collect results");
	});

	test("compact widget lines list open cards first and fit", () => {
		const lines = compactLines(busy(), runs, 50, PLAIN_STYLE);
		expect(lines[0]).toContain("Kanban");
		expect(lines[1]).toContain("k1");
		for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50);
		expect(compactLines(emptyState(), {}, 50, PLAIN_STYLE)).toEqual([]);
	});
});

describe("decideSplit", () => {
	test("wide panes split right, keeping pi ≥ 80 columns", () => {
		const d = decideSplit({ width: 251, height: 69 });
		expect(d.kind).toBe("right");
		if (d.kind === "right") expect(Math.round(251 * d.ratio)).toBeGreaterThanOrEqual(80);
	});

	test("the 116/117 boundary", () => {
		expect(decideSplit({ width: 116, height: 20 }).kind).toBe("right");
		expect(decideSplit({ width: 115, height: 40 }).kind).toBe("down");
	});

	test("too small for either is none", () => {
		expect(decideSplit({ width: 100, height: 20 }).kind).toBe("none");
		expect(decideSplit({ width: Number.NaN, height: 40 }).kind).toBe("none");
	});
});

// The quoting under test is POSIX `sh` semantics (single-quote escaping), so it
// can only be round-tripped where a POSIX shell exists. On Windows `/bin/sh` is
// absent from bun's PATH, so these skip rather than fail; the PowerShell twin
// (powershellQuote) is covered by the platform-tagged paneCommand tests.
const sh = process.platform === "win32" ? undefined : "/bin/sh";
describe("shell quoting", () => {
	test.each(["plain", "with space", "it's", "$HOME", "`id`", "a\nb", "", "--flag=x"]).skipIf(!sh)("round-trips %p through sh", (value) => {
		const out = execFileSync(sh!, ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf-8" });
		expect(out).toBe(value);
	});

	test.skipIf(!sh)("join quotes each argument independently", () => {
		const out = execFileSync(sh!, ["-c", `printf '[%s]' ${shellJoin(["a b", "c'd", "e"])}`], { encoding: "utf-8" });
		expect(out).toBe("[a b][c'd][e]");
	});
});

describe("findOnPath", () => {
	test("searches PATH in order, then extras", () => {
		const has = new Set(["/b/bun", "/x/bun"]);
		expect(findOnPath("bun", "/a:/b:/c", (p) => has.has(p), [], "linux")).toBe("/b/bun");
		expect(findOnPath("bun", "/a", (p) => has.has(p), ["/x/bun"], "linux")).toBe("/x/bun");
		expect(findOnPath("bun", undefined, () => false)).toBeUndefined();
	});
	test("posix PATH on linux is unchanged", () => {
		expect(findOnPath("bun", "/a:/b", (p) => p === "/b/bun", [], "linux")).toBe("/b/bun");
	});
	test("windows: ';' separator, drive letters, PATHEXT", () => {
		const want = String.raw`C:\Users\me\.bun\bin\bun.exe`;
		const pathEnv = String.raw`C:\Windows;C:\Users\me\.bun\bin` + "\\"; // trailing separator is stripped
		expect(findOnPath("bun", pathEnv, (p) => p === want, [], "win32", ".COM;.EXE")).toBe(want);
		expect(findOnPath("bun", "", (p) => p === "D:/x/bun.exe", ["D:/x/bun"], "win32", ".EXE")).toBe("D:/x/bun.exe");
	});
});

describe("parseCommand / opFromParams / parseColumn", () => {
	test("columns accept human aliases", () => {
		expect(parseColumn("in-progress")).toBe("in_progress");
		expect(parseColumn("WIP")).toBe("in_progress");
		expect(parseColumn("todo")).toBe("backlog");
		expect(parseColumn("nope")).toBeUndefined();
	});

	test("subcommands", () => {
		// Bare /kanban is what a user types to get the board back after closing it.
		expect(parseCommand("")).toEqual({ kind: "default" });
		expect(parseCommand("   ")).toEqual({ kind: "default" });
		expect(parseCommand("show")).toEqual({ kind: "show" });
		expect(parseCommand("open")).toEqual({ kind: "open" });
		expect(parseCommand("restart")).toEqual({ kind: "restart" });
		expect(parseCommand("add write the docs")).toEqual({ kind: "op", op: { op: "add", titles: ["write the docs"] } });
		expect(parseCommand("move k2 in-progress")).toEqual({ kind: "op", op: { op: "move", id: "k2", column: "in_progress" } });
		expect(parseCommand("move k2 blocked waits on the user")).toEqual({
			kind: "op",
			op: { op: "move", id: "k2", column: "blocked", note: "waits on the user" },
		});
		expect(parseCommand("clear-done")).toEqual({ kind: "op", op: { op: "clear_done" } });
		expect(parseCommand("move k2").kind).toBe("error");
		expect(parseCommand("move k2 sideways").kind).toBe("error");
		expect(parseCommand("frobnicate").kind).toBe("error");
	});

	test("opFromParams refuses missing fields", () => {
		expect(() => opFromParams({ op: "move", id: "k1" })).toThrow(/column/);
		expect(() => opFromParams({ op: "link", id: "k1" })).toThrow(/run_id/);
		expect(() => opFromParams({ op: "add" })).toThrow(/titles/);
		expect(opFromParams({ op: "move", id: "k1", column: "review" })).toEqual({ op: "move", id: "k1", column: "review" });
	});
});

describe("parseBoardArgs", () => {
	test("parses the launch argv", () => {
		expect(parseBoardArgs(["--file", "/r/p.json", "--owner-pid", "42", "--agent-dir", "/a"])).toEqual({
			file: "/r/p.json",
			ownerPid: 42,
			agentDir: "/a",
			once: false,
		});
	});

	test("refuses bad input with usage", () => {
		expect(typeof parseBoardArgs([])).toBe("string");
		expect(parseBoardArgs(["--file", "f", "--owner-pid", "x", "--agent-dir", "a"])).toMatch(/owner-pid/);
		expect(parseBoardArgs(["--bogus"])).toMatch(/unknown argument/);
	});

	test("bounds the frame size: an integer like 1e9 would exhaust memory", () => {
		const base = ["--file", "f", "--owner-pid", "1", "--agent-dir", "a"];
		expect(parseBoardArgs([...base, "--width", "1e9"])).toMatch(/--width/);
		expect(parseBoardArgs([...base, "--height", "100000"])).toMatch(/--height/);
		expect(parseBoardArgs([...base, "--width", "0"])).toMatch(/--width/);
		expect(parseBoardArgs([...base, "--width", "2.5"])).toMatch(/--width/);
		expect(parseBoardArgs([...base, "--width", String(MAX_TERMINAL_DIM)])).toMatchObject({ width: MAX_TERMINAL_DIM });
	});
});

describe("cleanText", () => {
	test("collapses whitespace and removes C0/C1 controls", () => {
		expect(cleanText(" a\tb\r\n\x1b[31mc\x9b ")).toBe("a b [31mc");
	});
});

describe("runs.ts (meta.json reader)", () => {
	const agent = mkdtempSync(join(tmpdir(), "kanban-runs-"));
	const write = (runId: string, meta: unknown, files: Record<string, string> = {}) => {
		const dir = join(agent, "subagent-runs", runId);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "meta.json"), typeof meta === "string" ? meta : JSON.stringify(meta));
		for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
	};
	write("sub-0001", { runId: "sub-0001", agent: "worker", status: "running" });
	write("sub-0002", { runId: "sub-0002", agent: "reviewer", status: "done" });
	write("sub-0003", "{not json");
	write("sub-0004", { runId: "sub-9999", status: "done" });
	write("sub-0005", { runId: "sub-0005", agent: "explorer", status: "running" }, {
		"2026-10-08T00-00-00-000Z_sub-0005.jsonl": "",
		"2026-10-08T00-00-00-000Z_sub-0005.jsonl.exit": "{}",
	});

	test("reads status and agent", () => {
		expect(readRunInfo(agent, "sub-0001")).toEqual({ status: "running", agent: "worker" });
		expect(readRunInfo(agent, "sub-0002")).toEqual({ status: "done", agent: "reviewer" });
	});

	test("unreadable, mismatched, missing and malformed ids are unknown", () => {
		expect(readRunInfo(agent, "sub-0003").status).toBe("unknown");
		expect(readRunInfo(agent, "sub-0004").status).toBe("unknown");
		expect(readRunInfo(agent, "sub-ffff").status).toBe("unknown");
		expect(readRunInfo(agent, "../../etc").status).toBe("unknown");
	});

	test("a running record whose child wrote its exit sidecar reads as done", () => {
		expect(readRunInfo(agent, "sub-0005")).toEqual({ status: "done", agent: "explorer" });
	});

	test("the tail ladder finds a todo snapshot >32 KB from EOF, and a torn final line is dropped", () => {
		// The measured p90 EOF gap is ~1.0 MB — the 32 KB and 512 KB windows
		// both miss, a wider step must find it.
		const todo = JSON.stringify({
			type: "message",
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { state: { items: [{ id: "t1", text: "a", status: "done" }], nextId: 2 } },
			},
		});
		const filler = JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(2048) } });
		const lines: string[] = [todo, ...Array.from({ length: 40 }, () => filler)];
		write("sub-0008", { runId: "sub-0008", agent: "worker", status: "running" }, {
			// ~80 KB past the snapshot: past step 1 (32 KB), inside step 2 (512 KB).
			"2026-10-09T00-00-00-000Z_sub-0008.jsonl": lines.join("\n") + "\n" + "{\"torn\": true",
		});
		expect(readRunInfo(agent, "sub-0008")).toEqual({
			status: "running",
			agent: "worker",
			todos: { done: 1, total: 1, inProgress: 0, blocked: 0 },
		});
	});

	test("a ladder proven EOF-empty is remembered; a snapshot appended later is found via the appended region", () => {
		// The transcript is append-only: after a covered miss, the next read
		// scans only [scanned, size). The appended region starts at the old EOF,
		// so its first line is complete — no step-1 window needed.
		const name = "2026-10-09T00-00-00-000Z_sub-000e.jsonl";
		const first = JSON.stringify({ type: "message", message: { role: "user", content: "go" } }) + "\n";
		write("sub-000e", { runId: "sub-000e", agent: "worker", status: "running" }, { [name]: first });
		expect(readRunInfo(agent, "sub-000e").todos).toBeUndefined(); // covered: marker set
		const appended =
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { state: { items: [{ id: "t1", text: "a", status: "in_progress" }], nextId: 2 } },
				},
			}) + "\n";
		write("sub-000e", { runId: "sub-000e", agent: "worker", status: "running" }, { [name]: first + appended });
		expect(readRunInfo(agent, "sub-000e").todos).toEqual({ done: 0, total: 1, inProgress: 1, blocked: 0 });
	});


	test("a non-todo newest result is skipped; the newest todo snapshot wins; malformed states are skipped", () => {
		const todo = (items: Array<{ id: string; text: string; status: string }>) =>
			JSON.stringify({
				type: "message",
				message: { role: "toolResult", toolName: "todo", details: { state: { items, nextId: 9 } } },
			});
		const bash = JSON.stringify({
			type: "message",
			message: { role: "toolResult", toolName: "bash", details: { state: { items: [] , nextId: 1} } },
		});
		write("sub-0009", { runId: "sub-0009", agent: "worker", status: "running" }, {
			"2026-10-09T00-00-00-000Z_sub-0009.jsonl": [
				todo([{ id: "t1", text: "old", status: "pending" }]),
				bash,
				todo([{ id: "t1", text: "old", status: "done" }, { id: "t2", text: "new", status: "in_progress" }]),
				bash, // newest is a bash result — the walk must keep going back
			].join("\n") + "\n",
		});
		expect(readRunInfo(agent, "sub-0009").todos).toEqual({ done: 1, total: 2, inProgress: 1, blocked: 0 });
		write("sub-000b", { runId: "sub-000b", agent: "worker", status: "running" }, {
			"2026-10-09T00-00-00-000Z_sub-000b.jsonl":
				JSON.stringify({ type: "message", message: { role: "toolResult", toolName: "todo", details: { state: { items: "nope" } } } }) +
				"\n",
		});
		expect(readRunInfo(agent, "sub-000b").todos).toBeUndefined();
	});

	test("a resumed run dir reads the newest session file; a sidecar-terminal run drops its cache entry", () => {
		const todo = (text: string) =>
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { state: { items: [{ id: "t1", text, status: "done" }], nextId: 2 } },
				},
			}) + "\n";
		// Two session files (a relaunch): the ISO prefix sorts chronologically.
		write("sub-000c", { runId: "sub-000c", agent: "worker", status: "running" }, {
			"2026-10-08T00-00-00-000Z_sub-000c.jsonl": todo("old session"),
			"2026-10-09T00-00-00-000Z_sub-000c.jsonl": todo("new session"),
		});
		expect(readRunInfo(agent, "sub-000c").todos).toEqual({ done: 1, total: 1, inProgress: 0, blocked: 0 });
		// The sidecar terminal transition (meta `running` + `.exit`): reads as
		// done, renders no todos — and the cache entry must be DROPPED, not
		// pinned. Assert the drop through behaviour: no todos on the terminal read.
		write("sub-000d", { runId: "sub-000d", agent: "worker", status: "running" }, {
			"2026-10-09T00-00-00-000Z_sub-000d.jsonl": todo("live"),
		});
		expect(readRunInfo(agent, "sub-000d").todos).toBeDefined();
		write("sub-000d", { runId: "sub-000d", agent: "worker", status: "running" }, {
			"2026-10-09T00-00-00-000Z_sub-000d.jsonl": todo("live"),
			"2026-10-09T00-00-00-000Z_sub-000d.jsonl.exit": "{}",
		});
		expect(readRunInfo(agent, "sub-000d")).toEqual({ status: "done", agent: "worker" });
	});

	test("readRunInfos maps every id", () => {
		expect(Object.keys(readRunInfos(agent, ["sub-0001", "sub-0002"]))).toEqual(["sub-0001", "sub-0002"]);
	});

	test("the todo sub-row renders for a live run and not for a terminal one", () => {
		const todoLine = (items: Array<{ id: string; text: string; status: string }>, nextId: number) =>
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					details: { state: { items, nextId } },
				},
			}) + "\n";
		write("sub-0006", { runId: "sub-0006", agent: "worker", status: "running" }, {
			"2026-10-09T00-00-00-000Z_sub-0006.jsonl": todoLine(
				[
					{ id: "t1", text: "a", status: "done" },
					{ id: "t2", text: "b", status: "in_progress" },
				],
				3,
			),
		});
		write("sub-0007", { runId: "sub-0007", agent: "worker", status: "running" }, {
			"2026-10-09T00-00-00-000Z_sub-0007.jsonl": todoLine(
				[
					{ id: "t1", text: "a", status: "done" },
					{ id: "t2", text: "b", status: "in_progress" },
					{ id: "t3", text: "c", status: "pending" },
				],
				4,
			),
			"2026-10-09T00-00-00-000Z_sub-0007.jsonl.exit": "{}",
		});

		const infos = readRunInfos(agent, ["sub-0006", "sub-0007"]);
		expect(infos["sub-0006"]).toEqual({ status: "running", agent: "worker", todos: { done: 1, total: 2, inProgress: 1, blocked: 0 } });
		// Terminal (exit sidecar): the session file is not read, so no todos.
		expect(infos["sub-0007"]).toEqual({ status: "done", agent: "worker" });

		const state = run(
			{ op: "add", titles: ["live card", "terminal card"] },
			{ op: "link", id: "k1", runId: "sub-0006" },
			{ op: "link", id: "k2", runId: "sub-0007" },
		);

		// renderBody: the live run's progress sub-row is present; the terminal
		// run's snapshot (different counts) is not rendered at all.
		const body = renderBody(state, infos, 100).join("\n");
		expect(body).toContain("1/2");
		expect(body).not.toContain("1/3");

		// compactLines: the same rule in the widget line.
		const compact = compactLines(state, infos, 100, PLAIN_STYLE).join("\n");
		expect(compact).toContain("1/2");
		expect(compact).not.toContain("1/3");
	});
});

describe("staleRuntimeOwner", () => {
	test("reads the pid from our two dir-name shapes", () => {
		expect(staleRuntimeOwner("3592375-Mwsq7H", "")).toBe(3592375);
		expect(staleRuntimeOwner("pi-kanban-42-abc123", "pi-kanban-")).toBe(42);
	});

	test("ignores every name that is not ours", () => {
		for (const name of ["", "projection.json", "3592375", "3592375-", "3592375-ab", "x3592375-Mwsq7H", "0-Mwsq7H", "-5-Mwsq7H", "12-Mwsq7H.bak"]) {
			expect(staleRuntimeOwner(name, "")).toBeUndefined();
		}
		// A stranger's dir in a shared tmpdir: our prefix or nothing.
		expect(staleRuntimeOwner("systemd-private-42-abc123", "pi-kanban-")).toBeUndefined();
		expect(staleRuntimeOwner("42-abc123", "pi-kanban-")).toBeUndefined();
	});
});

describe("paneCommand", () => {
	test("posix shells exec", () => {
		expect(paneCommand(["/b/bun", "x y"], "linux")).toBe("exec /b/bun 'x y'");
	});
	test("windows uses PowerShell call operator and exits", () => {
		expect(paneCommand([String.raw`C:\b\bun.exe`, "it's"], "win32")).toBe(
			String.raw`& 'C:\b\bun.exe' 'it''s'; exit $LASTEXITCODE`,
		);
	});
});
