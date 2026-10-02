import { describe, expect, test } from "bun:test";

import {
	activeItem,
	applyOp,
	counts,
	demotedBy,
	emptyState,
	nudgeFor,
	progressSignature,
	summarize,
	TodoError,
	type TodoState,
	unfinished,
} from "./todo.js";

/** Build a state by folding ops, the way the extension does across calls. */
const build = (...ops: Parameters<typeof applyOp>[1][]): TodoState =>
	ops.reduce<TodoState>((s, op) => applyOp(s, op), emptyState());

describe("add", () => {
	test("assigns sequential t-prefixed ids", () => {
		const state = build({ op: "add", texts: ["one", "two"] });
		expect(state.items.map((i) => i.id)).toEqual(["t1", "t2"]);
		expect(state.items.every((i) => i.status === "pending")).toBe(true);
	});

	test("continues numbering across calls", () => {
		const state = build({ op: "add", texts: ["one"] }, { op: "add", texts: ["two"] });
		expect(state.items.map((i) => i.id)).toEqual(["t1", "t2"]);
	});

	test("trims and drops empty texts", () => {
		const state = build({ op: "add", texts: ["  padded  ", "", "   "] });
		expect(state.items).toHaveLength(1);
		expect(state.items[0]?.text).toBe("padded");
	});

	test("refuses an all-empty list", () => {
		expect(() => build({ op: "add", texts: ["", "  "] })).toThrow(TodoError);
	});
});

describe("start", () => {
	test("demotes the previous in-progress item, keeping exactly one", () => {
		const state = build(
			{ op: "add", texts: ["one", "two"] },
			{ op: "start", id: "t1" },
			{ op: "start", id: "t2" },
		);
		expect(state.items.find((i) => i.id === "t1")?.status).toBe("pending");
		expect(state.items.find((i) => i.id === "t2")?.status).toBe("in_progress");
		expect(counts(state).inProgress).toBe(1);
	});

	test("refuses an unknown id and names the ones that exist", () => {
		const state = build({ op: "add", texts: ["one"] });
		expect(() => applyOp(state, { op: "start", id: "t9" })).toThrow(/No todo t9.*t1/);
	});

	test("refuses to restart a done item", () => {
		const state = build({ op: "add", texts: ["one"] }, { op: "complete", id: "t1" });
		expect(() => applyOp(state, { op: "start", id: "t1" })).toThrow(TodoError);
	});

	test("does not disturb a blocked sibling", () => {
		const state = build(
			{ op: "add", texts: ["one", "two"] },
			{ op: "block", id: "t1", note: "waiting on review" },
			{ op: "start", id: "t2" },
		);
		expect(state.items.find((i) => i.id === "t1")?.status).toBe("blocked");
	});
});

describe("complete", () => {
	test("records the note as evidence", () => {
		const state = build(
			{ op: "add", texts: ["one"] },
			{ op: "complete", id: "t1", note: "bun test passes" },
		);
		expect(state.items[0]?.status).toBe("done");
		expect(state.items[0]?.note).toBe("bun test passes");
	});

	test("clears a stale blocked-reason when completing without a note", () => {
		const state = build(
			{ op: "add", texts: ["one"] },
			{ op: "block", id: "t1", note: "waiting on the API" },
			{ op: "complete", id: "t1" },
		);
		// The old reason must not survive as if it described the completion.
		expect(state.items[0]?.note).toBeUndefined();
	});

	test("refuses to complete twice", () => {
		const state = build({ op: "add", texts: ["one"] }, { op: "complete", id: "t1" });
		expect(() => applyOp(state, { op: "complete", id: "t1" })).toThrow(/already done/);
	});
});

describe("block", () => {
	test("requires a non-empty reason", () => {
		const state = build({ op: "add", texts: ["one"] });
		expect(() => applyOp(state, { op: "block", id: "t1", note: "   " })).toThrow(TodoError);
	});

	test("refuses to block a done item", () => {
		const state = build({ op: "add", texts: ["one"] }, { op: "complete", id: "t1" });
		expect(() => applyOp(state, { op: "block", id: "t1", note: "nope" })).toThrow(TodoError);
	});
});

describe("drop and clear", () => {
	test("drop removes the item but never recycles its id", () => {
		const state = build(
			{ op: "add", texts: ["one", "two"] },
			{ op: "drop", id: "t1" },
			{ op: "add", texts: ["three"] },
		);
		expect(state.items.map((i) => i.id)).toEqual(["t2", "t3"]);
	});

	test("drop refuses an unknown id", () => {
		const state = build({ op: "add", texts: ["one"] });
		expect(() => applyOp(state, { op: "drop", id: "t7" })).toThrow(TodoError);
	});

	test("clear empties the list but preserves the counter", () => {
		const state = build({ op: "add", texts: ["one", "two"] }, { op: "clear" });
		expect(state.items).toEqual([]);
		expect(applyOp(state, { op: "add", texts: ["fresh"] }).items[0]?.id).toBe("t3");
	});
});

describe("immutability", () => {
	test("applyOp never mutates the input snapshot", () => {
		// Load-bearing: past snapshots are session history. If applyOp edited them
		// in place, rewinding the conversation would replay an already-mutated
		// list and the widget would show the future.
		const before = build({ op: "add", texts: ["one"] });
		const frozen = JSON.stringify(before);
		applyOp(before, { op: "start", id: "t1" });
		applyOp(before, { op: "complete", id: "t1", note: "x" });
		applyOp(before, { op: "clear" });
		expect(JSON.stringify(before)).toBe(frozen);
	});

	test("a refused op leaves no partial change", () => {
		const before = build({ op: "add", texts: ["one"] });
		const frozen = JSON.stringify(before);
		expect(() => applyOp(before, { op: "block", id: "t1", note: "" })).toThrow();
		expect(JSON.stringify(before)).toBe(frozen);
	});
});

describe("counts, activeItem and summarize", () => {
	test("counts every status exactly once", () => {
		const state = build(
			{ op: "add", texts: ["a", "b", "c", "d"] },
			{ op: "start", id: "t1" },
			{ op: "block", id: "t2", note: "waiting" },
			{ op: "complete", id: "t3" },
		);
		expect(counts(state)).toEqual({ total: 4, done: 1, inProgress: 1, blocked: 1, pending: 1 });
	});

	test("activeItem finds the in-progress item, or nothing", () => {
		expect(activeItem(build({ op: "add", texts: ["one"] }))).toBeUndefined();
		const state = build({ op: "add", texts: ["one"] }, { op: "start", id: "t1" });
		expect(activeItem(state)?.id).toBe("t1");
	});

	test("summarize stays one line and names the active item", () => {
		expect(summarize(emptyState())).toBe("Todo list is empty.");
		const state = build(
			{ op: "add", texts: ["parse header", "write test"] },
			{ op: "complete", id: "t1" },
			{ op: "start", id: "t2" },
		);
		const line = summarize(state);
		expect(line).toContain("1/2 done");
		expect(line).toContain("now: write test");
		expect(line).not.toContain("\n");
	});

	test("summarize reports blocked counts and the absence of an active item", () => {
		const state = build(
			{ op: "add", texts: ["one"] },
			{ op: "block", id: "t1", note: "waiting on CI" },
		);
		expect(summarize(state)).toContain("1 blocked");
		expect(summarize(state)).toContain("nothing in progress");
	});
});

describe("unfinished", () => {
	test("counts pending and in_progress, but not done or blocked", () => {
		// blocked is excluded on purpose: it has already been accounted for with a
		// note, so it is not work the agent silently forgot.
		const state = build(
			{ op: "add", texts: ["a", "b", "c", "d"] },
			{ op: "start", id: "t1" },
			{ op: "block", id: "t2", note: "waiting" },
			{ op: "complete", id: "t3" },
		);
		expect(unfinished(state).map((i) => i.id)).toEqual(["t1", "t4"]);
	});

	test("an empty or fully-settled list owes nothing", () => {
		expect(unfinished(emptyState())).toEqual([]);
		const settled = build(
			{ op: "add", texts: ["a", "b"] },
			{ op: "complete", id: "t1" },
			{ op: "block", id: "t2", note: "waiting" },
		);
		expect(unfinished(settled)).toEqual([]);
	});
});

describe("demotedBy", () => {
	test("names the item a start knocked back to pending", () => {
		const before = build({ op: "add", texts: ["one", "two"] }, { op: "start", id: "t1" });
		const after = applyOp(before, { op: "start", id: "t2" });
		expect(demotedBy(before, after)?.id).toBe("t1");
	});

	test("reports nothing when the start displaced no one", () => {
		const before = build({ op: "add", texts: ["one", "two"] });
		expect(demotedBy(before, applyOp(before, { op: "start", id: "t1" }))).toBeUndefined();
	});

	test("a completed item is not a demotion", () => {
		// complete moves in_progress -> done, which is the agent doing the right
		// thing. Only a slide back to pending is worth warning about.
		const before = build({ op: "add", texts: ["one"] }, { op: "start", id: "t1" });
		expect(demotedBy(before, applyOp(before, { op: "complete", id: "t1" }))).toBeUndefined();
	});
});

describe("progressSignature", () => {
	test("changes when a status changes", () => {
		const state = build({ op: "add", texts: ["one", "two"] });
		const started = applyOp(state, { op: "start", id: "t1" });
		expect(progressSignature(state)).not.toBe(progressSignature(started));
	});

	test("ignores note-only changes, which are not progress", () => {
		// The signature gates the settle-time reminder. Blocking an already-blocked
		// item with a new note must not re-arm it, or an agent that keeps rewording
		// a note could be nudged forever.
		const a = build({ op: "add", texts: ["one"] }, { op: "block", id: "t1", note: "first" });
		const b = applyOp(a, { op: "block", id: "t1", note: "second" });
		expect(progressSignature(a)).toBe(progressSignature(b));
	});
});

describe("nudgeFor", () => {
	test("stays silent on an empty list", () => {
		expect(nudgeFor(emptyState())).toBeUndefined();
	});

	test("stays silent once every item is resolved", () => {
		const state = build(
			{ op: "add", texts: ["a", "b"] },
			{ op: "complete", id: "t1" },
			{ op: "block", id: "t2", note: "waiting on CI" },
		);
		expect(nudgeFor(state)).toBeUndefined();
	});

	test("names each open item and its state", () => {
		const state = build(
			{ op: "add", texts: ["parse header", "write test"] },
			{ op: "start", id: "t1" },
		);
		const nudge = nudgeFor(state);
		expect(nudge?.text).toContain("t1 (in progress) parse header");
		expect(nudge?.text).toContain("t2 (pending) write test");
		expect(nudge?.text).toContain("2 todo items are still open");
	});

	test("offers all three exits and forbids the dishonest one", () => {
		// The failure mode a bare "you forgot" reminder would create: the model
		// completes unfinished work to silence the warning.
		const nudge = nudgeFor(build({ op: "add", texts: ["one"] }));
		expect(nudge?.text).toContain("'complete'");
		expect(nudge?.text).toContain("'block'");
		expect(nudge?.text).toContain("'drop'");
		expect(nudge?.text).toMatch(/[Nn]ever mark an item done just to clear/);
	});

	test("uses singular phrasing for one item", () => {
		expect(nudgeFor(build({ op: "add", texts: ["one"] }))?.text).toContain("1 todo item is");
	});

	test("caps the list it names but still reports the true total", () => {
		const texts = Array.from({ length: 11 }, (_, i) => `task ${i + 1}`);
		const nudge = nudgeFor(build({ op: "add", texts }));
		expect(nudge?.text).toContain("11 todo items are still open");
		expect(nudge?.text).toContain("task 8");
		expect(nudge?.text).not.toContain("task 9");
		expect(nudge?.text).toContain("3 more");
	});

	test("carries the signature of the state that produced it", () => {
		// This is what the extension dedupes on, so it must match the state the
		// nudge describes rather than being recomputed later.
		const state = build({ op: "add", texts: ["one"] });
		expect(nudgeFor(state)?.signature).toBe(progressSignature(state));
	});

	test("completing the last open item ends the nagging", () => {
		const state = build({ op: "add", texts: ["one"] }, { op: "start", id: "t1" });
		expect(nudgeFor(state)).toBeDefined();
		expect(nudgeFor(applyOp(state, { op: "complete", id: "t1", note: "tests pass" }))).toBeUndefined();
	});
});
