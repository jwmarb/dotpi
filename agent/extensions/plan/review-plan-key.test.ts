/**
 * Pin the ADR 0048 plan-key decisions for plan-spawned Runs: the child
 * receives its OWN runId as `PI_PLAN_KEY` (the shared `__review__` sentinel is
 * gone), and the Rework's findings seed split into the items the worker works
 * through.
 *
 * House rules: one-line imports and module-level expected strings, as in
 * planfile.test.ts (bun v1.4.0 link flakes on this machine).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setSpawnCapRoot } from "../subagent/spawnlimit.js";
import { reworkSeedItems } from "./index.js";
import { runReview } from "./review.js";

const AGENT_BODY = "You are the test oracle. Agent definition body.";
const ITEM = "The item under test.";
const REWORK_ITEM = "The item sent back for rework.";

// The contract items every rework seed ends with.
const VERIFY_ITEM = "Verify by running the repo's checks";
const COMMIT_ITEM = "Commit exactly one commit";

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
