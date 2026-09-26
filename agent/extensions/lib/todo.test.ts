import { describe, expect, test } from "bun:test";

import {
	activeItem,
	applyOp,
	counts,
	emptyState,
	summarize,
	TodoError,
	type TodoState,
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
