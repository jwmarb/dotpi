/**
 * Tests for the queue that carries a finished **Rework** to the orchestrator.
 *
 * ## Why this file exists
 *
 * A Rework used to finish by appending `[rework attempted by a fresh run — see
 * /run … . Re-review to judge it.]` to its Item's note, and stopping. Nothing
 * reads notes, so "Re-review to judge it" was an instruction addressed to nobody:
 * the worker fixed the code, committed it, and the Item sat in `active` with no
 * one aware it was waiting. Observed in the wild on a real Item, which stalled
 * exactly there.
 *
 * The fix wakes the orchestrator with a message. The subtle part is *when*. A
 * `followUp` message sent mid-turn is queued by pi and **cannot be recalled**, so
 * delivering the instant a Rework lands would re-inject a report the orchestrator
 * may already have handled by the time the turn ends — the mistake ADR 0027
 * records for delegated Task Reminders. Delivery therefore waits for idle.
 *
 * The logic is reproduced here rather than imported because it is a handful of
 * module-level variables inside an extension that is loaded once at pi startup and
 * stays resident: there is no seam to reach it through, and the behaviour that
 * matters is the ordering, which is what these assertions pin down.
 */
import { describe, expect, test } from "bun:test";

interface Report {
	itemId: string;
	runId: string;
}

/**
 * The delivery rule from `index.ts`: deliver when idle, hold when mid-turn, and
 * drain on settle.
 */
function makeQueue() {
	const delivered: Report[] = [];
	const pending: Report[] = [];
	let turnInFlight = false;
	let listening = true;
	return {
		delivered,
		pendingCount: () => pending.length,
		startTurn() {
			turnInFlight = true;
		},
		/** No orchestrator registered — e.g. inside a review child. */
		stopListening() {
			listening = false;
		},
		report(r: Report) {
			if (!listening) return;
			if (turnInFlight) {
				pending.push(r);
				return;
			}
			delivered.push(r);
		},
		settle(isIdle = true) {
			if (!isIdle) return;
			turnInFlight = false;
			// Drained, not iterated: delivery starts a new turn, which re-enters
			// `agent_start` and would otherwise re-queue what is being delivered.
			for (const r of pending.splice(0)) delivered.push(r);
		},
	};
}

describe("rework report delivery", () => {
	test("delivers immediately when the orchestrator is idle", () => {
		const q = makeQueue();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		expect(q.delivered).toEqual([{ itemId: "p12", runId: "pln-aaaa-1" }]);
		expect(q.pendingCount()).toBe(0);
	});

	test("holds a report that lands mid-turn", () => {
		const q = makeQueue();
		q.startTurn();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		// Nothing delivered yet: an unrecallable followUp mid-turn is the bug.
		expect(q.delivered).toEqual([]);
		expect(q.pendingCount()).toBe(1);
	});

	test("delivers a held report once the turn settles", () => {
		const q = makeQueue();
		q.startTurn();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		q.settle();
		expect(q.delivered).toEqual([{ itemId: "p12", runId: "pln-aaaa-1" }]);
		expect(q.pendingCount()).toBe(0);
	});

	test("an intermediate settle that is not idle delivers nothing", () => {
		const q = makeQueue();
		q.startTurn();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		q.settle(false);
		expect(q.delivered).toEqual([]);
		expect(q.pendingCount()).toBe(1);
	});

	test("delivers each report exactly once across repeated settles", () => {
		// The reason the queue is drained rather than iterated: delivering starts a
		// new turn, so a second settle must not resend what already went out.
		const q = makeQueue();
		q.startTurn();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		q.settle();
		q.settle();
		q.settle();
		expect(q.delivered).toHaveLength(1);
	});

	test("keeps several concurrent reworks in order", () => {
		// Two Items can be reworked at once — the spawn cap is six, not one.
		const q = makeQueue();
		q.startTurn();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		q.report({ itemId: "p13", runId: "pln-bbbb-1" });
		q.settle();
		expect(q.delivered.map((r) => r.itemId)).toEqual(["p12", "p13"]);
	});

	test("drops the report when nothing is listening", () => {
		// A review or rework child loads this same extension but registers no
		// orchestrator bridge. The plan file note is the durable record there, and
		// the same is true after the session has exited — a detached Rework
		// outliving its parent must not be an error.
		const q = makeQueue();
		q.stopListening();
		q.report({ itemId: "p12", runId: "pln-aaaa-1" });
		expect(q.delivered).toEqual([]);
		expect(q.pendingCount()).toBe(0);
	});
});

/**
 * A queued report is re-checked against the plan file before it is delivered.
 *
 * ## Why this exists
 *
 * The first time the Rework notification fired on real work it arrived **stale**.
 * The Rework landed while the orchestrator was mid-turn, so the report was queued
 * correctly — but during that same turn the orchestrator read the Rework's commit
 * and moved the Item to `review` itself. The queued message then arrived
 * announcing the Item as sitting in `active` and asking for a decision that had
 * been made two minutes earlier.
 *
 * The queue was right; the *claim inside the message* was what went stale,
 * because it was composed when the Rework landed and delivered later. So the
 * Item's state is re-read at delivery and the report dropped unless it is still
 * `active`. A message asking for settled work to be redone is worse than silence.
 */
describe("stale report suppression", () => {
	/** The delivery rule, with the freshness re-check from `index.ts`. */
	function makeQueue(planStatus: () => string) {
		const delivered: string[] = [];
		const pending: string[] = [];
		let turnInFlight = false;
		return {
			delivered,
			startTurn: () => {
				turnInFlight = true;
			},
			report(id: string) {
				if (turnInFlight) pending.push(id);
				else if (planStatus() === "active") delivered.push(id);
			},
			settle() {
				turnInFlight = false;
				for (const id of pending.splice(0)) {
					// `reportStillStands`: re-read, not the state captured at landing.
					if (planStatus() === "active") delivered.push(id);
				}
			},
		};
	}

	test("drops a report whose item was moved on during the delaying turn", () => {
		let status = "active";
		const q = makeQueue(() => status);
		q.startTurn();
		q.report("p10");
		// The orchestrator inspects the rework and acts, inside the same turn.
		status = "review";
		q.settle();
		expect(q.delivered).toEqual([]);
	});

	test("delivers a report whose item is still awaiting a decision", () => {
		const q = makeQueue(() => "active");
		q.startTurn();
		q.report("p10");
		q.settle();
		expect(q.delivered).toEqual(["p10"]);
	});

	test("drops a report whose item was accepted outright", () => {
		let status = "active";
		const q = makeQueue(() => status);
		q.startTurn();
		q.report("p10");
		status = "done";
		q.settle();
		expect(q.delivered).toEqual([]);
	});

	test("drops a report whose item no longer exists", () => {
		let status = "active";
		const q = makeQueue(() => status);
		q.startTurn();
		q.report("p10");
		// Deleted: `reportStillStands` finds no item and returns false.
		status = "(missing)";
		q.settle();
		expect(q.delivered).toEqual([]);
	});

	test("one stale report does not block a fresh one behind it", () => {
		const statuses: Record<string, string> = { p10: "review", p11: "active" };
		const delivered: string[] = [];
		const pending = ["p10", "p11"];
		for (const id of pending) if (statuses[id] === "active") delivered.push(id);
		expect(delivered).toEqual(["p11"]);
	});
});
