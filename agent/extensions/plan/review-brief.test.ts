/**
 * Pin the ADR 0047 decisions against a fake `spawn`: the **Delegation brief**
 * crosses as the child's first user message (the last argv element, bare),
 * the `--append-system-prompt` file carries the agent definition alone, and
 * the Run directory records the whole delegation payload as `prompt.md`.
 *
 * Only the piped path is exercised here: the native path takes the same
 * `brief` into `buildLaunchPlan` (docs/adr/0047) and is covered live by the
 * dispatch itself, which a test would pay for. The decisions pinned are the
 * ones a future refactor could re-prefix or re-route by accident — one manual
 * oracle run does not hold them.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setSpawnCapRoot } from "../subagent/spawnlimit.js";
import { reworkContract, reviewContract, runReview } from "./review.js";

const AGENT_BODY = "You are the test oracle. Agent definition body.";
const ITEM = "The item under test.";
const NOTE = "The implementer says it is done.";

describe("plan-spawned brief crossing (ADR 0047)", () => {
	let workDir: string;
	let runDir: string;
	let agentFile: string;
	let seenArgs: string[] | null = null;
	let appendContent: string | null = null;
	let savedHerdrSocket: string | undefined;
	let savedReviewFlag: string | undefined;

	const fakeSpawn = ((
		_command: string,
		args: string[],
	): ChildProcess => {
		seenArgs = args;
		const i = args.indexOf("--append-system-prompt");
		appendContent = i >= 0 ? readFileSync(args[i + 1], "utf-8") : null;
		// A child the piped runReview can read: stdout data, then close 0.
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
		workDir = await mkdtemp(path.join(os.tmpdir(), "review-brief-"));
		// An isolated budget, so the test never contends with production runs.
		setSpawnCapRoot(workDir);
		runDir = path.join(workDir, "pln-test-brief-1");
		agentFile = path.join(workDir, "agent.md");
		await writeFile(
			agentFile,
			`---\nname: oracle\ntools: read\n---\n${AGENT_BODY}\n`,
		);
		seenArgs = null;
		appendContent = null;
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

	test("review: brief is the first user message, append is the agent definition, prompt.md records both", async () => {
		const outcome = await runReview({
			agentFile,
			itemText: ITEM,
			note: NOTE,
			cwd: workDir,
			runDir,
			runId: "pln-test-brief-1",
			spawnFn: fakeSpawn,
		});
		expect(outcome.deadReason).toBeNull();
		expect(outcome.output).toContain("VERDICT: pass");

		const brief = reviewContract(ITEM, NOTE);
		expect(seenArgs).not.toBeNull();
		// The brief is the last argv element — bare, no "Task: " prefix.
		expect(seenArgs!.at(-1)).toBe(brief);
		expect(brief.startsWith("## Autonomous review")).toBe(true);

		// The append channel carries the agent definition and nothing else.
		expect(appendContent).toBe(AGENT_BODY);

		// The Run directory records the whole delegation payload.
		const recorded = await readFile(path.join(runDir, "prompt.md"), "utf-8");
		expect(recorded).toBe(
			[AGENT_BODY, "## First user message", brief].join("\n\n---\n\n"),
		);
	});

	test("rework: the same channel shape", async () => {
		const reworkDir = path.join(workDir, "pln-test-rework-1");
		const outcome = await runReview({
			purpose: "rework",
			agentFile,
			itemText: ITEM,
			note: NOTE,
			cwd: workDir,
			runDir: reworkDir,
			runId: "pln-test-rework-1",
			spawnFn: fakeSpawn,
		});
		expect(outcome.deadReason).toBeNull();

		const brief = reworkContract(ITEM, NOTE);
		expect(seenArgs!.at(-1)).toBe(brief);
		expect(brief.startsWith("## Autonomous rework")).toBe(true);
		expect(appendContent).toBe(AGENT_BODY);

		const recorded = await readFile(
			path.join(reworkDir, "prompt.md"),
			"utf-8",
		);
		expect(recorded).toBe(
			[AGENT_BODY, "## First user message", brief].join("\n\n---\n\n"),
		);
	});
});
