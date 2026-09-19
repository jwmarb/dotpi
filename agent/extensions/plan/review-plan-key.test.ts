/**
 * Pin the ADR 0048 plan-key decisions for plan-spawned Runs: the child
 * receives its OWN runId as `PI_PLAN_KEY` (the shared `__review__` sentinel is
 * gone), and the Rework's findings seed split into the items the worker works
 * through. The seeding is pinned at the seam that owns the key — the spawner,
 * and the dispatch paths that call it without a per-call spawn — and the
 * seeded `plans/<runId>.jsonl` files are read back off disk.
 *
 * House rules: one-line imports and module-level expected strings, as in
 * planfile.test.ts (bun v1.4.0 link flakes on this machine).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setSpawnCapRoot } from "../subagent/spawnlimit.js";
import { dispatchRework, dispatchReview, reworkSeedItems } from "./index.js";
import { loadPlan } from "./planfile.js";
import { runReview, setSpawnFn } from "./review.js";

const AGENT_BODY = "You are the test oracle. Agent definition body.";
const ITEM = "The item under test.";
const REWORK_ITEM = "The item sent back for rework.";

// The contract items every rework seed ends with.
const VERIFY_ITEM = "Verify by running the repo's checks.";
const COMMIT_ITEM = "Commit exactly one commit.";

// The one item a review Run's plan is seeded with (docs/adr/0048).
const REVIEW_SEED_TEXT = "Carry out the review and emit the Verdict";
const FINDINGS_BULLETED = "- first objection\n\n- second objection";
const EXPECTED_BULLETED = [
	"first objection",
	"second objection",
	VERIFY_ITEM,
	COMMIT_ITEM,
];
const FINDINGS_SINGLE = "- only one";
const EXPECTED_SINGLE = [FINDINGS_SINGLE, VERIFY_ITEM, COMMIT_ITEM];
const FINDINGS_PARAGRAPHS = "para one line\nmore of para one\n\npara two";
const EXPECTED_PARAGRAPHS = [
	"para one line more of para one",
	"para two",
	VERIFY_ITEM,
	COMMIT_ITEM,
];

describe("reworkSeedItems", () => {
	test("bulleted findings split into one item per block", () => {
		expect(reworkSeedItems(FINDINGS_BULLETED)).toEqual(EXPECTED_BULLETED);
	});

	test("a single block keeps the whole findings text", () => {
		expect(reworkSeedItems(FINDINGS_SINGLE)).toEqual(EXPECTED_SINGLE);
	});

	test("non-bulleted findings split on blank lines, lines joined", () => {
		expect(reworkSeedItems(FINDINGS_PARAGRAPHS)).toEqual(EXPECTED_PARAGRAPHS);
	});
});

describe("plan-spawned Runs carry their own plan key (ADR 0048)", () => {
	let workDir: string;
	let runDir: string;
	let agentFile: string;
	let seenEnv: Record<string, string> | undefined;
	let savedHerdrSocket: string | undefined;
	let savedReviewFlag: string | undefined;

	const fakeSpawn = ((_command: string, _args: string[], opts: { env: Record<string, string> }): ChildProcess => {
		seenEnv = opts.env;
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const child = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			kill: () => true,
		}) as ChildProcess;
		setTimeout(() => {
			stdout.emit("data", Buffer.from("VERDICT: pass\n"));
			child.emit("close", 0);
		}, 5);
		return child;
	}) as typeof import("node:child_process").spawn;

	beforeEach(async () => {
		workDir = await mkdtemp(path.join(os.tmpdir(), "review-plan-key-"));
		// An isolated budget, so the test never contends with production runs.
		setSpawnCapRoot(workDir);
		runDir = path.join(workDir, "pln-test-key-1");
		agentFile = path.join(workDir, "agent.md");
		await writeFile(
			agentFile,
			`---\nname: oracle\ntools: read\n---\n${AGENT_BODY}\n`,
		);
		seenEnv = undefined;
		// Force the piped path and prove this process is not itself a review.
		savedHerdrSocket = process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_SOCKET_PATH;
		savedReviewFlag = process.env.PI_PLAN_IN_REVIEW;
		delete process.env.PI_PLAN_IN_REVIEW;
	});

	afterEach(async () => {
		if (savedHerdrSocket) process.env.HERDR_SOCKET_PATH = savedHerdrSocket;
		if (savedReviewFlag) process.env.PI_PLAN_IN_REVIEW = savedReviewFlag;
		await rm(workDir, { recursive: true, force: true });
	});

	test("review: the child's PI_PLAN_KEY is its own runId, not the reviewed plan's", async () => {
		const runId = "pln-test-key-1";
		const outcome = await runReview({
			agentFile,
			itemText: ITEM,
			cwd: workDir,
			runDir,
			runId,
			spawnFn: fakeSpawn,
		});
		expect(outcome.deadReason).toBeNull();
		expect(seenEnv).toBeDefined();
		// Non-empty (a falsy key would make the child believe it is the main
		// session) and distinct from the reviewed plan's key.
		expect(seenEnv!.PI_PLAN_KEY).toBe(runId);
	});

	test("rework: the same rule for the rework child", async () => {
		const reworkRunId = "pln-test-rework-1";
		const reworkDir = path.join(workDir, "pln-test-rework-1");
		const outcome = await runReview({
			purpose: "rework",
			agentFile,
			itemText: REWORK_ITEM,
			cwd: workDir,
			runDir: reworkDir,
			runId: reworkRunId,
			spawnFn: fakeSpawn,
		});
		expect(outcome.deadReason).toBeNull();
		expect(seenEnv!.PI_PLAN_KEY).toBe(reworkRunId);
	});
});

describe("seed-at-spawn through the dispatch seam (ADR 0048)", () => {
	let workDir: string;
	let agentDir: string;
	let seenEnv: Record<string, string> | undefined;
	let savedAgentDir: string | undefined;
	let savedHerdrSocket: string | undefined;
	let savedReviewFlag: string | undefined;

	// The dispatch path calls runReview WITHOUT a per-call spawn, so the fake
	// is installed at the module seam (setSpawnFn) — exactly the seam a test
	// cannot reach through the per-call option.
	const fakeSpawn = ((_command: string, _args: string[], opts: { env: Record<string, string> }): ChildProcess => {
		seenEnv = opts.env;
		const stdout = new EventEmitter();
		const stderr = new EventEmitter();
		const child = Object.assign(new EventEmitter(), {
			stdout,
			stderr,
			kill: () => true,
		}) as ChildProcess;
		setTimeout(() => {
			stdout.emit("data", Buffer.from("VERDICT: pass\n"));
			child.emit("close", 0);
		}, 5);
		return child;
	}) as typeof import("node:child_process").spawn;

	beforeEach(async () => {
		workDir = await mkdtemp(path.join(os.tmpdir(), "review-dispatch-"));
		agentDir = path.join(workDir, "agent");
		// The agent files the dispatch path computes from the agent dir itself.
		mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		await writeFile(
			path.join(agentDir, "agents", "oracle.md"),
			`---\nname: oracle\ntools: read\n---\n${AGENT_BODY}\n`,
		);
		await writeFile(
			path.join(agentDir, "agents", "worker.md"),
			`---\nname: worker\ntools: read\n---\nYou are the test worker.\n`,
		);
		// An isolated budget, so the test never contends with production runs.
		setSpawnCapRoot(workDir);
		seenEnv = undefined;
		// Every agent-dir lookup (seed, Run dir, agent file) lands in the fixture.
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		// Force the piped path and prove this process is not itself a review.
		savedHerdrSocket = process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_SOCKET_PATH;
		savedReviewFlag = process.env.PI_PLAN_IN_REVIEW;
		delete process.env.PI_PLAN_IN_REVIEW;
		setSpawnFn(fakeSpawn);
	});

	afterEach(async () => {
		setSpawnFn(null);
		if (savedAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		else delete process.env.PI_CODING_AGENT_DIR;
		if (savedHerdrSocket) process.env.HERDR_SOCKET_PATH = savedHerdrSocket;
		if (savedReviewFlag) process.env.PI_PLAN_IN_REVIEW = savedReviewFlag;
		await rm(workDir, { recursive: true, force: true });
	});

	/** The pln- plan files the dispatch seeded under the agent dir. */
	const seededPlans = async (): Promise<string[]> =>
		(
			await readdir(path.join(agentDir, "plans"))
		).filter((n) => n.startsWith("pln-")).sort();

	test("dispatchReview: the review Run's plan is seeded under its own runId", async () => {
		const planFile = path.join(workDir, "main.jsonl");
		await writeFile(
			planFile,
			JSON.stringify({ id: "p1", text: ITEM, status: "review", route: "oracle" }) +
				"\n",
			"utf-8",
		);

		await dispatchReview(planFile, "p1", workDir);

		// Exactly one new pln- plan — and the child's key IS the runId that keys
		// the file: the seed and the key come out of the same code path.
		const names = await seededPlans();
		expect(names).toHaveLength(1);
		const runId = names[0]!.replace(/\.jsonl$/, "");
		expect(runId).toMatch(/^pln-/);
		expect(seenEnv).toBeDefined();
		expect(seenEnv!.PI_PLAN_KEY).toBe(runId);

		// The file is the review's own plan: the one item that names its work,
		// seeded with the child's schema (backlog, route skip).
		const items = await loadPlan(path.join(agentDir, "plans", names[0]!));
		expect(items).toHaveLength(1);
		expect(items[0]!.id).toBe("p1");
		expect(items[0]!.text).toBe(REVIEW_SEED_TEXT);
		expect(items[0]!.status).toBe("backlog");
		expect(items[0]!.route).toBe("skip");

		// The Verdict still landed on the reviewed Item, and the in-flight
		// marker was cleared once the review ended.
		const main = await loadPlan(planFile);
		expect(main[0]!.status).toBe("done");
		expect(main[0]!.reviewRunId).toBeUndefined();
	});

	test("dispatchRework: the worker's plan is seeded from the findings, under its runId", async () => {
		const planFile = path.join(workDir, "main.jsonl");
		await writeFile(
			planFile,
			JSON.stringify({ id: "p1", text: REWORK_ITEM, status: "active", route: "oracle" }) +
				"\n",
			"utf-8",
		);

		await dispatchRework(planFile, "p1", workDir, REWORK_ITEM, FINDINGS_BULLETED);

		const names = await seededPlans();
		expect(names).toHaveLength(1);
		const runId = names[0]!.replace(/\.jsonl$/, "");
		expect(runId).toMatch(/^pln-/);
		expect(seenEnv).toBeDefined();
		expect(seenEnv!.PI_PLAN_KEY).toBe(runId);

		// The findings split into the items the worker works through, plus the
		// contract's verify and commit — the same split reworkSeedItems pins.
		const items = await loadPlan(path.join(agentDir, "plans", names[0]!));
		expect(items.map((i) => i.text)).toEqual(EXPECTED_BULLETED);
		for (const item of items) {
			expect(item.status).toBe("backlog");
			expect(item.route).toBe("skip");
		}

		// The Item's in-flight marker is cleared once the worker ended, and the
		// Item itself is untouched by the Rework's own plan.
		const main = await loadPlan(planFile);
		expect(main[0]!.status).toBe("active");
		expect(main[0]!.reworkRunId).toBeUndefined();
	});
});
