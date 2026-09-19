/**
 * Pin the ADR 0048 Board decisions: a card lists the plans of the Runs it
 * carries — the Task's own plan, its `.rN` variants, and the rework/review
 * Runs the Item records — read live from each Run's own plan file, and a
 * DONE item in one of those plans is drawn dimmed, the way the note is.
 *
 * The lifecycle suite drives the real dispatch-completion path (dispatchReview
 * and its fail-Verdict rework dispatch), clears what that path clears, and
 * proves the archived Run plans still render afterwards: the in-flight
 * markers die with the Runs, and the durable last-Run records are what the
 * post-hoc draw reads (docs/adr/0048).
 *
 * `readRunPlans` and `render` are the Board's own functions, imported
 * directly: board.ts guards its entrypoint code (terminal, watch loop) on
 * `process.argv[1]`, so importing it runs nothing. The fixtures are real
 * files under a temp dir — the plan file is the single source of truth, and
 * a render that does not come from one is not the render a user sees.
 *
 * House rules: one-line imports and module-level expected strings, as in
 * planfile.test.ts (bun v1.4.0 link flakes on this machine).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readRunPlans, render } from "./board.js";
import { setSpawnCapRoot } from "../subagent/spawnlimit.js";
import { dispatchReview } from "./index.js";
import { loadPlan, type PlanItem } from "./planfile.js";
import { setSpawnFn } from "./review.js";

const TASK_ID = "sub-fixture-1";
const REWORK_RUN = "pln-fixture-r-1";
const REVIEW_RUN = "pln-fixture-v-1";
const CARD_TEXT = "Ship the Board card plan lines";
const META_LINE = '{"kind":"plan-meta","autonomous":true}';
const NOT_JSON = "not-json-at-all";
const SUFFIX_ARCHIVED_ITEM = "Suffix archived item";
const REVIEW_SEED_TEXT = "Carry out the review and emit the Verdict";
const LIFECYCLE_TASK = "sub-lifecycle-1";
const LIFECYCLE_ITEM_TEXT = "Ship the fix";
const LIFECYCLE_FINDING = "The fix is wrong";

/** The card: one active item that carries a Task plus a rework and a review Run. */
const CARD: PlanItem = {
	id: "p1",
	text: CARD_TEXT,
	status: "active",
	taskId: TASK_ID,
	reworkRunId: REWORK_RUN,
	reviewRunId: REVIEW_RUN,
};

/** readRunPlans file order is the sorted file name order: pln- before sub-. */
const RUN_PLAN_LINES = [
	"p1 Fix the dimming",
	"p1 Judge the fix",
	"p1 Refactor the seed path",
	"p2 Wire the render test",
	"p1 Sibling run item",
	"p2 Unknown state item",
];

// The done state in a Run's plan renders dimmed — the exact escapes, not a
// substring: a done item that renders at full colour is the bug this pins.
const DIM_JUDGE = "\x1b[2m✓ Judge the fix\x1b[0m";
const DIM_REFACTOR = "\x1b[2m✓ Refactor the seed path\x1b[0m";
// A non-done item renders in its state's colour (active is 45).
const COLORED_WIRE = "\x1b[38;5;45m▸\x1b[0m Wire the render test";
const NOT_ON_CARD = "Not on this card";

let agentDir: string;
let mainFile: string;

async function writeRunPlan(name: string, lines: string[]): Promise<void> {
	await writeFile(
		path.join(agentDir, "plans", name),
		lines.join("\n") + "\n",
		"utf-8",
	);
}

beforeEach(async () => {
	agentDir = await mkdtemp(path.join(os.tmpdir(), "board-render-"));
	await mkdir(path.join(agentDir, "plans"), { recursive: true });
	await writeFile(
		path.join(agentDir, "plans", `${TASK_ID}.jsonl`),
		[
			META_LINE,
			JSON.stringify({ id: "p1", text: "Refactor the seed path", status: "done" }),
			JSON.stringify({ id: "p2", text: "Wire the render test", status: "active" }),
		].join("\n") +
			"\n",
		"utf-8",
	);
	// The Task's `.r1` sibling Run: found by the variant regex, not by the card.
	await writeRunPlan(`${TASK_ID}.r1.jsonl`, [
		JSON.stringify({ id: "p1", text: "Sibling run item", status: "ready" }),
		// An unrecognised status must keep the item, filed backlog.
		JSON.stringify({ id: "p2", text: "Unknown state item", status: "groomed" }),
	]);
	// The Runs the card records. A corrupt line dies in the file, not the draw.
	await writeRunPlan(`${REWORK_RUN}.jsonl`, [
		NOT_JSON,
		JSON.stringify({ id: "p1", text: "Fix the dimming", status: "backlog" }),
	]);
	await writeRunPlan(
		`${REVIEW_RUN}.jsonl`,
		[JSON.stringify({ id: "p1", text: "Judge the fix", status: "done" })],
	);
	// A decoy: a plan file that is NOT this card's must not appear on it.
	await writeRunPlan("sub-other-1.jsonl", [
		JSON.stringify({ id: "p1", text: NOT_ON_CARD, status: "active" }),
	]);
	mainFile = path.join(agentDir, "main.jsonl");
});

afterEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

describe("readRunPlans (ADR 0048)", () => {
	test("reads the Task plan, its .rN variant and the recorded rework/review Runs", async () => {
		const items = await readRunPlans(agentDir, TASK_ID, [REWORK_RUN, REVIEW_RUN]);
		expect(items.map((i) => `${i.id} ${i.text}`)).toEqual(RUN_PLAN_LINES);
	});

	test("keeps an unknown status, filed backlog", async () => {
		const items = await readRunPlans(agentDir, TASK_ID, []);
		const unknown = items.find((i) => i.text === "Unknown state item");
		expect(unknown).toBeDefined();
		expect(unknown!.status).toBe("backlog");
	});

	test("returns nothing when the plans dir is missing", async () => {
		expect(await readRunPlans(path.join(agentDir, "elsewhere"), TASK_ID, [])).toEqual([]);
	});
	test("falls back to the archive when the live file is absent, picking newest by mtime", async () => {
		// Remove the live rework plan so the key is missing from the live directory.
		await rm(path.join(agentDir, "plans", `${REWORK_RUN}.jsonl`));
		const archiveDir = path.join(agentDir, "plans", "archive");
		await mkdir(archiveDir, { recursive: true });
		const olderFile = path.join(archiveDir, "2026-09-18-pln-fixture-r-1.jsonl");
		const newerFile = path.join(archiveDir, "2026-09-19-pln-fixture-r-1.2.jsonl");
		await writeFile(olderFile, JSON.stringify({ id: "p1", text: "Old archived item", status: "done" }) + "\n", "utf-8");
		await writeFile(newerFile, JSON.stringify({ id: "p1", text: "New archived item", status: "done" }) + "\n", "utf-8");
		// Pin mtime explicitly: the .2 suffix sorts AFTER the plain name
		// lexicographically here, so this test proves mtime (not name) decides.
		utimesSync(olderFile, new Date("2026-09-19T10:00:00Z"), new Date("2026-09-19T10:00:00Z"));
		utimesSync(newerFile, new Date("2026-09-18T10:00:00Z"), new Date("2026-09-18T10:00:00Z"));

		const items = await readRunPlans(agentDir, TASK_ID, [REWORK_RUN]);
		const reworkItems = items.filter((i) => i.text === "Old archived item" || i.text === "New archived item");
		expect(reworkItems).toHaveLength(1);
		expect(reworkItems[0]!.text).toBe("Old archived item");
	});

	test("live file wins over archive when both exist", async () => {
		const archiveDir = path.join(agentDir, "plans", "archive");
		await mkdir(archiveDir, { recursive: true });
		await writeFile(
			path.join(archiveDir, "2026-09-19-pln-fixture-r-1.jsonl"),
			JSON.stringify({ id: "p1", text: "Archived decoy item", status: "done" }) + "\n",
			"utf-8",
		);
		// The live rework file (created in beforeEach) has a different item.
		const items = await readRunPlans(agentDir, TASK_ID, [REWORK_RUN]);
		expect(items.some((i) => i.text === "Fix the dimming")).toBe(true);
		expect(items.some((i) => i.text === "Archived decoy item")).toBe(false);
	});

	test("archive match is key-exact: a shorter key never pulls a longer key's file", async () => {
		const archiveDir = path.join(agentDir, "plans", "archive");
		await mkdir(archiveDir, { recursive: true });
		// The archive file is for the LONGER key (REWORK_RUN), which contains the
		// requested key as a strict prefix — substring matching would select it.
		await writeFile(
			path.join(archiveDir, "2026-09-19-pln-fixture-r-1.2.jsonl"),
			JSON.stringify({ id: "p1", text: NOT_ON_CARD, status: "active" }) + "\n",
			"utf-8",
		);
		const items = await readRunPlans(agentDir, TASK_ID, ["pln-fixture-r"]);
		expect(items.some((i) => i.text === NOT_ON_CARD)).toBe(false);
	});

	test("archive match is key-exact: a longer key never pulls a shorter key's file", async () => {
		const archiveDir = path.join(agentDir, "plans", "archive");
		await mkdir(archiveDir, { recursive: true });
		// The archive file is for the SHORTER key; the request is REWORK_RUN.
		await writeFile(
			path.join(archiveDir, "2026-09-19-pln-fixture-r.jsonl"),
			JSON.stringify({ id: "p1", text: NOT_ON_CARD, status: "active" }) + "\n",
			"utf-8",
		);
		// Remove the live rework plan so its key is missing from the live directory.
		await rm(path.join(agentDir, "plans", `${REWORK_RUN}.jsonl`));
		const items = await readRunPlans(agentDir, TASK_ID, [REWORK_RUN]);
		expect(items.some((i) => i.text === NOT_ON_CARD)).toBe(false);
	});

	test("archive match accepts the numeric collision suffix of the exact key", async () => {
		const archiveDir = path.join(agentDir, "plans", "archive");
		await mkdir(archiveDir, { recursive: true });
		await writeFile(
			path.join(archiveDir, "2026-09-19-pln-fixture-r-1.2.jsonl"),
			JSON.stringify({ id: "p1", text: SUFFIX_ARCHIVED_ITEM, status: "done" }) + "\n",
			"utf-8",
		);
		// Remove the live rework plan so the key is missing from the live directory.
		await rm(path.join(agentDir, "plans", `${REWORK_RUN}.jsonl`));
		const items = await readRunPlans(agentDir, TASK_ID, [REWORK_RUN]);
		expect(items.some((i) => i.text === SUFFIX_ARCHIVED_ITEM)).toBe(true);
	});
});

describe("Board card render (ADR 0048)", () => {
	test("lists the Run plans under the card, with done items dimmed", async () => {
		const runPlans = new Map(
			[[TASK_ID, await readRunPlans(agentDir, TASK_ID, [REWORK_RUN, REVIEW_RUN])]],
		);
		const frame = render([CARD], mainFile, 80, false, new Map(), runPlans);

		// The card itself drew.
		expect(frame).toContain(CARD_TEXT);

		// Every done item in a carried plan is drawn dimmed — the whole line,
		// both of them, exactly the dim style the note uses.
		expect(frame).toContain(DIM_JUDGE);
		expect(frame).toContain(DIM_REFACTOR);

		// Non-done items keep their state colour.
		expect(frame).toContain(COLORED_WIRE);

		// A plan file that is not the card's never reaches it.
		expect(frame).not.toContain(NOT_ON_CARD);
	});

	test("a card with no readable Run plans draws exactly as before", async () => {
		const frame = render([CARD], mainFile, 80, false);
		expect(frame).toContain(CARD_TEXT);
		expect(frame).not.toContain(DIM_JUDGE);
		expect(frame).not.toContain(COLORED_WIRE);
		expect(frame).not.toContain(NOT_ON_CARD);
	});
});

// ---------------------------------------------------------------------------
// Post-hoc lifecycle (ADR 0048): the Runs end, the in-flight markers are
// cleared and the Runs' plans self-archive. The durable last-Run records are
// what the post-hoc draw reads — the archived plans must still render.
// ---------------------------------------------------------------------------

describe("post-hoc Run plans survive dispatch completion (ADR 0048)", () => {
	let workDir: string;
	let agentDir: string;
	let mainFile: string;
	let savedAgentDir: string | undefined;
	let savedHerdrSocket: string | undefined;
	let savedReviewFlag: string | undefined;
	let spawnCalls: number;

	// The fake child: the review emits findings plus a fail Verdict — which is
	// what makes dispatchReview dispatch the rework through the same real path
	// — and the rework emits a plain report. Installed at the module seam the
	// dispatch path consults when no per-call spawn is given.
	const fakeSpawn = ((_command: string, _args: string[], _opts: { env: Record<string, string> }): ChildProcess => {
		spawnCalls++;
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const child = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			kill: () => true,
		}) as ChildProcess;
		setTimeout(() => {
			stdout.emit(
				"data",
				Buffer.from(spawnCalls === 1 ? `${LIFECYCLE_FINDING}.\nVERDICT: fail\n` : "rework done\n"),
			);
			child.emit("close", 0);
		}, 5);
		return child;
	}) as typeof import("node:child_process").spawn;

	beforeEach(async () => {
		workDir = await mkdtemp(path.join(os.tmpdir(), "board-lifecycle-"));
		agentDir = path.join(workDir, "agent");
		// The agent files the dispatch path computes from the agent dir itself.
		mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		await writeFile(
			path.join(agentDir, "agents", "oracle.md"),
			"---\nname: oracle\ntools: read\n---\nYou are the test oracle.\n",
			"utf-8",
		);
		await writeFile(
			path.join(agentDir, "agents", "worker.md"),
			"---\nname: worker\ntools: read\n---\nYou are the test worker.\n",
			"utf-8",
		);
		// An isolated budget, so the test never contends with production runs.
		setSpawnCapRoot(workDir);
		spawnCalls = 0;
		// Every agent-dir lookup (seed, Run dir, agent file) lands in the fixture.
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		// Force the piped path and prove this process is not itself a review.
		savedHerdrSocket = process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_SOCKET_PATH;
		savedReviewFlag = process.env.PI_PLAN_IN_REVIEW;
		delete process.env.PI_PLAN_IN_REVIEW;
		setSpawnFn(fakeSpawn);
		// The main plan: one oracle-routed item in review, carrying a Task — the
		// card the Board draws is the one that lists the Runs' plans.
		mainFile = path.join(workDir, "main.jsonl");
		await writeFile(
			mainFile,
			JSON.stringify({
				id: "p1",
				text: LIFECYCLE_ITEM_TEXT,
				status: "review",
				route: "oracle",
				taskId: LIFECYCLE_TASK,
			}) + "\n",
			"utf-8",
		);
	});

	afterEach(async () => {
		setSpawnFn(null);
		if (savedAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		else delete process.env.PI_CODING_AGENT_DIR;
		if (savedHerdrSocket) process.env.HERDR_SOCKET_PATH = savedHerdrSocket;
		if (savedReviewFlag) process.env.PI_PLAN_IN_REVIEW = savedReviewFlag;
		await rm(workDir, { recursive: true, force: true });
	});

	test("archived review and rework plans render after the in-flight markers are cleared", async () => {
		// The real dispatch-completion path: the review runs, its fail Verdict
		// returns the item to active, and the Rework dispatch runs the same seam.
		await dispatchReview(mainFile, "p1", workDir);
		expect(spawnCalls).toBe(2);

		const [item] = (await loadPlan(mainFile)) as PlanItem[];
		// The fail Verdict landed and both Runs ended: the in-flight markers are
		// cleared — that is exactly what the previous state could not survive.
		expect(item!.status).toBe("active");
		expect(item!.reviewRunId).toBeUndefined();
		expect(item!.reworkRunId).toBeUndefined();
		// The durable records are what the post-hoc Board reads.
		expect(item!.lastReviewRunId).toMatch(/^pln-/);
		expect(item!.lastReworkRunId).toMatch(/^pln-/);

		// The Runs' plans self-archive, exactly as the children's own plan
		// extensions do when their last item goes terminal.
		const plansDir = path.join(agentDir, "plans");
		const date = new Date().toISOString().slice(0, 10);
		await mkdir(path.join(plansDir, "archive"), { recursive: true });
		for (const runId of [item!.lastReviewRunId!, item!.lastReworkRunId!]) {
			await rename(path.join(plansDir, `${runId}.jsonl`), path.join(plansDir, "archive", `${date}-${runId}.jsonl`));
		}
		// The live files are gone: the exact case the post-hoc fallback exists for.
		const live = await readdir(plansDir);
		expect(live).not.toContain(`${item!.lastReviewRunId}.jsonl`);
		expect(live).not.toContain(`${item!.lastReworkRunId}.jsonl`);

		// Collect the Runs' IDs exactly as the Board's draw does: the in-flight
		// marker first, the durable record after.
		const extra = [
			item!.reworkRunId ?? item!.lastReworkRunId,
			item!.reviewRunId ?? item!.lastReviewRunId,
		].filter((r): r is string => !!r);
		const plans = await readRunPlans(agentDir, LIFECYCLE_TASK, extra);
		// Both archived plans are found through the durable records alone.
		expect(plans.some((i) => i.text === REVIEW_SEED_TEXT)).toBe(true);
		expect(plans.some((i) => i.text.includes(LIFECYCLE_FINDING))).toBe(true);

		// And the card renders them: the review's own seeded item and the rework's
		// seeded findings item — read from the archive, since the live files are gone.
		const frame = render([item!], mainFile, 80, false, new Map(), new Map([[LIFECYCLE_TASK, plans]]));
		expect(frame).toContain(REVIEW_SEED_TEXT);
		expect(frame).toContain(LIFECYCLE_FINDING);
	});
});
