/**
 * Tests for {@link deletePlanItem} — op `delete` against the plan file store.
 *
 * ## Why this file exists
 *
 * The delete policy itself is covered by `canDelete` in review-route.test.ts.
 * What that suite cannot prove is that the operation applies it to the very
 * snapshot it removes. The first attempt validated a snapshot read *before*
 * the mutation lock, then filtered the re-read list by id — so a concurrent
 * writer that moved the item to `done`, `failed` or `dropped`, or started a
 * Rework for it, in between, would still see it erased. That is exactly the
 * record ADR 0014 keeps immutable (and ADR 0041 says a live Rework's item
 * must not vanish under it), so the two regression tests here force that
 * interleaving: the file lock is held while the delete is queued, the item
 * changes while it waits, and the refusal must still land.
 *
 * Holding the lock from the test plays the other writer's role: it is the
 * same mechanism another pi session uses, and the fresh `owner.json` the
 * test writes is what `acquirePlanLock` reads to judge the lock live rather
 * than abandoned — so the delete genuinely waits on it instead of breaking
 * it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { deletePlanItem } from "./index.ts";

const KEY = "k";
const RUN_ID = "pln-test-race";

const TMP = mkdtempSync(path.join(os.tmpdir(), "plan-delete-test-"));
const AGENT_DIR = path.join(TMP, "agent");
const PLAN_FILE = path.join(TMP, "plans", "test-key.jsonl");

/** One plan item, as a line of the JSONL file. */
type Item = {
	id: string;
	text: string;
	status: string;
	reworkRunId?: string;
};

function writePlan(items: Item[]): void {
	mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
	writeFileSync(PLAN_FILE, items.map((i) => JSON.stringify(i)).join("\n") + "\n");
}

function readPlan(): Item[] {
	return readFileSync(PLAN_FILE, "utf-8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Item);
}

/**
 * Hold the plan file's lock the way a concurrent writer's acquisition does:
 * the directory is the lock, and a fresh `owner.json` keeps it from being
 * judged abandoned (10 s stale threshold) while the test manipulates the
 * file behind it.
 */
function holdPlanLock(): () => void {
	const lockDir = `${PLAN_FILE}.lock`;
	mkdirSync(lockDir);
	writeFileSync(
		path.join(lockDir, "owner.json"),
		JSON.stringify({ pid: process.pid, at: Date.now(), token: "test-hold" }),
	);
	return () => rmSync(lockDir, { recursive: true, force: true });
}

/** A Run the liveness probe reads as *running*: fresh transcript, no exit. */
function makeLiveRun(): void {
	const runDir = path.join(AGENT_DIR, "subagent-sessions", RUN_ID);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		path.join(runDir, "run.json"),
		JSON.stringify({ runId: RUN_ID, agent: "worker", outcome: "running" }),
	);
	writeFileSync(path.join(runDir, "s.jsonl"), "{}");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("deletePlanItem", () => {
	// The liveness probe reads Run directories under the agent dir, so point
	// it at a throwaway tree: these tests must not touch the real sessions.
	beforeAll(() => {
		process.env.PI_CODING_AGENT_DIR = AGENT_DIR;
	});
	afterAll(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(TMP, { recursive: true, force: true });
	});

	test("deletes a non-terminal item and leaves the survivors and their ids alone", async () => {
		writePlan([
			{ id: "p1", text: "first", status: "active" },
			{ id: "p2", text: "second", status: "backlog" },
			{ id: "p3", text: "third", status: "ready" },
		]);
		const res = await deletePlanItem(PLAN_FILE, KEY, "p1");
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.text).toBe("first");
			expect(res.wasStatus).toBe("active");
			expect(res.remaining.map((i) => i.id)).toEqual(["p2", "p3"]);
		}
		// On disk, and with ids NOT renumbered: p2 and p3 keep what they were.
		expect(readPlan().map((i) => i.id)).toEqual(["p2", "p3"]);
	});

	test("refuses an unknown id and changes nothing", async () => {
		writePlan([{ id: "p1", text: "only", status: "active" }]);
		const before = readFileSync(PLAN_FILE, "utf-8");
		const res = await deletePlanItem(PLAN_FILE, KEY, "p99");
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("Unknown item id");
		expect(readFileSync(PLAN_FILE, "utf-8")).toBe(before);
	});

	test("refuses when the item goes terminal while the delete is queued", async () => {
		// The regression: validation must happen on the locked snapshot, not on
		// a pre-read one. The lock holds the delete in its queue, the item goes
		// done behind it, and the delete must refuse the now-terminal record
		// instead of filtering it out of the re-read list.
		writePlan([{ id: "p1", text: "first", status: "active" }]);
		const release = holdPlanLock();
		const del = deletePlanItem(PLAN_FILE, KEY, "p1");
		// Let it reach the lock's poll loop (50 ms interval) before we act.
		await sleep(150);
		// The concurrent writer completes the item.
		writePlan([{ id: "p1", text: "first", status: "done" }]);
		release();
		const res = await del;
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toContain("already done");
		const p1 = readPlan().find((i) => i.id === "p1");
		expect(p1).toBeDefined();
		expect(p1?.status).toBe("done");
	});

	test("refuses when a rework is attached while the delete is queued", async () => {
		// The other half of the regression: the liveness probe must re-run on
		// the locked snapshot, so a Rework started AFTER the request refuses
		// the delete just like one already recorded (docs/adr/0041).
		makeLiveRun();
		writePlan([{ id: "p1", text: "first", status: "active" }]);
		const release = holdPlanLock();
		const del = deletePlanItem(PLAN_FILE, KEY, "p1");
		await sleep(150);
		// The concurrent writer starts a Rework for the item.
		writePlan([
			{ id: "p1", text: "first", status: "active", reworkRunId: RUN_ID },
		]);
		release();
		const res = await del;
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toContain("still running");
			// The message must name the Run, or the user cannot go look at it.
			expect(res.error).toContain(RUN_ID);
		}
		const p1 = readPlan().find((i) => i.id === "p1");
		expect(p1).toBeDefined();
		expect(p1?.reworkRunId).toBe(RUN_ID);
	});

	test("deletes the item once the rework behind it has finished", async () => {
		// The refusal is about liveness, not the marker: a finished Rework does
		// not wedge the delete, so a stale `reworkRunId` alone cannot block it.
		const runDir = path.join(AGENT_DIR, "subagent-sessions", RUN_ID);
		mkdirSync(runDir, { recursive: true });
		writeFileSync(
			path.join(runDir, "run.json"),
			JSON.stringify({ runId: RUN_ID, agent: "worker", outcome: "running" }),
		);
		writeFileSync(path.join(runDir, "s.jsonl"), "{}");
		writeFileSync(
			path.join(runDir, `${RUN_ID}.exitcode`),
			"0",
		);
		writePlan([
			{ id: "p1", text: "first", status: "active", reworkRunId: RUN_ID },
		]);
		const res = await deletePlanItem(PLAN_FILE, KEY, "p1");
		expect(res.ok).toBe(true);
		expect(readPlan()).toEqual([]);
	});
	/**
	 * A refusal must leave the file **byte-for-byte** as it was.
	 *
	 * `mutatePlan` used to rewrite the file after every callback, so a refused
	 * delete still serialised the plan from its parsed items. That is lossy, and
	 * silently so: `loadPlan` skips malformed lines and drops unrecognised fields,
	 * so refusing to delete a terminal Item could destroy a corrupt line and an
	 * unknown field on an operation that reported changing nothing.
	 *
	 * The earlier "unknown id changes nothing" test could not catch it, because a
	 * canonical one-line plan survives a round-trip unchanged. This one uses
	 * content that does not.
	 */
	test("a refusal leaves a non-canonical file byte-for-byte intact", async () => {
		mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
		const original = [
			'{"kind":"plan-meta","autonomous":true}',
			// An unrecognised field, which loadPlan drops on a round-trip.
			'{"id":"p1","text":"terminal","status":"done","customField":"KEEP ME"}',
			// A malformed line, which loadPlan skips entirely.
			"THIS LINE IS NOT JSON",
			'{"id":"p2","text":"live","status":"active"}',
		].join("\n") + "\n";
		writeFileSync(PLAN_FILE, original);

		// Refused: p1 is terminal.
		const terminal = await deletePlanItem(PLAN_FILE, KEY, "p1");
		expect(terminal.ok).toBe(false);
		expect(readFileSync(PLAN_FILE, "utf-8")).toBe(original);

		// Refused: no such item.
		const unknown = await deletePlanItem(PLAN_FILE, KEY, "p99");
		expect(unknown.ok).toBe(false);
		expect(readFileSync(PLAN_FILE, "utf-8")).toBe(original);

		// A real delete may rewrite the file — that is the point of it — but it must
		// still not invent or lose items it was not asked about.
		const ok = await deletePlanItem(PLAN_FILE, KEY, "p2");
		expect(ok.ok).toBe(true);
		expect(readFileSync(PLAN_FILE, "utf-8")).not.toBe(original);
		// `readPlan` here parses every line, so the plan-meta line appears as an
		// entry with no id — filter it out rather than assert on its shape.
		expect(readPlan().filter((i) => i.id).map((i) => i.id)).toEqual(["p1"]);
		// The meta line survived the real write, which is the bug ADR 0032 records.
		expect(readFileSync(PLAN_FILE, "utf-8")).toContain('"kind":"plan-meta"');
	});
});
