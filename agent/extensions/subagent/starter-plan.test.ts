/**
 * Pin the ADR 0048 Starter Plan decisions for delegated Runs: a Run's plan
 * file is seeded at spawn in the same code path that computes its plan key,
 * the nudge crosses inside the delegation brief (before the Run directory
 * records the prompt), and a Run without items gets neither seed nor nudge.
 *
 * The test drives the real extension headless (no UI): the `subagent` tool
 * then drains the Task inline, and a fake spawn stands in for the child pi.
 * House rules: one-line imports and module-level expected strings (bun
 * v1.4.0 link flakes, see planfile.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YOUR_PLAN_NUDGE } from "../plan/planfile.js";
import { setSpawnCapRoot } from "../subagent/spawnlimit.js";

const AGENT_NAME = "worker";
const TASK = "Do the thing.";
const PLAN_ITEMS = ["Item one", "Item two", "Item three"];
const NUDGE_THREE = YOUR_PLAN_NUDGE(3);
const NUDGED_TASK = TASK + "\n\n" + NUDGE_THREE;
const P_IDS = ["p1", "p2", "p3"];
const P_ONE = ["p1"];
const CHILD_RESULT =
	"Done.\n<result>\nAll three items are complete.\n</result>";

let agentDir: string;
let workDir: string;
let seenArgs: string[] | null;
let seenEnv: Record<string, string> | undefined;
let savedAgentDir: string | undefined;
let savedHerdrSocket: string | undefined;

type ToolDef = {
	name: string;
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal,
		onUpdate: () => void,
		ctx: { hasUI: boolean; cwd: string },
	) => Promise<{
		content: { type: string; text: string }[];
		details: { taskId: string; mode: string };
	}>;
};

async function parsePlanFile(file: string): Promise<{ id: string; status: string; route: string }[]> {
	const raw = await readFile(file, "utf-8");
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => {
			const o = JSON.parse(l) as { id: string; status: string; route: string };
			return { id: o.id, status: o.status, route: o.route };
		});
}

describe("Starter Plan seeding at subagent spawn (ADR 0048)", () => {
	let tools: Map<string, ToolDef>;

	beforeEach(async () => {
		workDir = await import("node:fs/promises").then((m) =>
			m.mkdtemp(path.join(os.tmpdir(), "starter-plan-")),
		);
		agentDir = path.join(workDir, "agent");
		mkdirSync(path.join(agentDir, "agents"), { recursive: true });
		// The spawn-cap token dir must exist: claimSlot's exclusive mkdir
		// refuses when the parent is missing.
		mkdirSync(path.join(agentDir, "subagent-sessions"), { recursive: true });
		// The plan store nests under plans/; the production agent dir has it,
		// so the fixture does too.
		mkdirSync(path.join(agentDir, "plans"), { recursive: true });
		await writeFile(
			path.join(agentDir, "agents", "worker.md"),
			`---\nname: ${AGENT_NAME}\ndescription: Test worker.\n---\nYou are the test worker.\n`,
		);
		// Redirect every agent-dir lookup to the fixture before the extension
		// module loads, so its registration and the Run all land here.
		savedAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		savedHerdrSocket = process.env.HERDR_SOCKET_PATH;
		delete process.env.HERDR_SOCKET_PATH;
		seenArgs = null;
		seenEnv = undefined;

		const { setSpawnFn, default: install } = await import("./index.js");
		setSpawnFn(
			((_command: string, args: string[], opts: { env: Record<string, string> }): ChildProcess => {
				seenArgs = args;
				seenEnv = opts.env;
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
						Buffer.from(
							JSON.stringify({
								type: "message_end",
								message: {
									role: "assistant",
									content: [{ type: "text", text: CHILD_RESULT }],
									stopReason: "stop",
								},
							}) + "\n",
						),
					);
					child.emit("close", 0);
				}, 5);
				return child;
			}) as typeof import("node:child_process").spawn,
		);

		tools = new Map();
		install({
			registerTool: (def: ToolDef) => {
				tools.set(def.name, def);
			},
			registerCommand: () => {},
			registerMessageRenderer: () => {},
			on: () => {},
			sendMessage: () => {},
			appendEntry: () => {},
		});
		// Isolate the spawn cap on this temp dir (the review-brief.test.ts
		// pattern), after install() so it wins over the fixture agent dir.
		setSpawnCapRoot(workDir);
	});

	afterEach(async () => {
		// Clear the spawn override so a later test file in the same process
		// cannot inherit this one's fake.
		(await import("./index.js")).setSpawnFn(null);
		if (savedAgentDir) process.env.PI_CODING_AGENT_DIR = savedAgentDir;
		else delete process.env.PI_CODING_AGENT_DIR;
		if (savedHerdrSocket) process.env.HERDR_SOCKET_PATH = savedHerdrSocket;
		await rm(workDir, { recursive: true, force: true });
	});

	const launch = async (params: unknown) => {
		const tool = tools.get("subagent")!;
		return tool.execute(
			"tc-1",
			params,
			new AbortController().signal,
			() => {},
			{ hasUI: false, cwd: workDir },
		);
	};

	test("single Run: seeded under the Task ID, nudged inside the brief", async () => {
		const result = await launch({
			agent: AGENT_NAME,
			task: TASK,
			plan: PLAN_ITEMS,
		});
		const taskId = result.details.taskId;

		// The plan file is the child's: same key the plan tool would compute.
		const planFile = path.join(agentDir, "plans", `${taskId}.jsonl`);
		const items = await parsePlanFile(planFile);
		expect(items.map((i) => i.id)).toEqual(P_IDS);
		for (const item of items) {
			expect(item.status).toBe("backlog");
			expect(item.route).toBe("skip");
		}

		// The child's plan tool addresses the same file.
		expect(seenEnv!.PI_PLAN_KEY).toBe(taskId);

		// The nudge crosses inside the delegation brief — the last argv element.
		const brief = seenArgs!.at(-1)!;
		expect(brief).toBe("Task: " + NUDGED_TASK);
	});

	test("single Run without items: no seed, no nudge", async () => {
		const result = await launch({
			agent: AGENT_NAME,
			task: TASK,
		});
		const taskId = result.details.taskId;

		let present = true;
		try {
			await readFile(path.join(agentDir, "plans", `${taskId}.jsonl`), "utf-8");
		} catch {
			present = false;
		}
		expect(present).toBe(false);

		const brief = seenArgs!.at(-1)!;
		expect(brief).toBe("Task: " + TASK);
	});

	test("parallel Runs: each sibling seeds under its own run-suffixed key", async () => {
		const result = await launch({
			tasks: [
				{ agent: AGENT_NAME, task: TASK, plan: ["A one"] },
				{ agent: AGENT_NAME, task: TASK, plan: ["B one", "B two"] },
			],
		});
		const taskId = result.details.taskId;

		const run1 = await parsePlanFile(
			path.join(agentDir, "plans", `${taskId}.r1.jsonl`),
		);
		const run2 = await parsePlanFile(
			path.join(agentDir, "plans", `${taskId}.r2.jsonl`),
		);
		expect(run1.map((i) => i.id)).toEqual(P_ONE);
		expect(run2.map((i) => i.id)).toEqual(["p1", "p2"]);
		// Seeded items carry the child's schema, in both siblings.
		for (const item of [...run1, ...run2]) {
			expect(item.status).toBe("backlog");
			expect(item.route).toBe("skip");
		}
	});

	test("chain: the nudge lands on the {previous}-interpolated task text", async () => {
		const result = await launch({
			chain: [
				{ agent: AGENT_NAME, task: "First step." },
				{
					agent: AGENT_NAME,
					task: "Second step, given: {previous}",
					plan: ["Chained item"],
				},
			],
		});
		const taskId = result.details.taskId;

		// The first step produced CHILD_RESULT, so the second step's {previous}
		// interpolates to its extracted <result> text — and the seed's nudge is
		// appended AFTER that interpolation (subagent/index.ts: the
		// interpolation rewrites run.task, THEN seeding appends the nudge). A
		// reordering that appended the nudge first would drop it from every
		// chain step, because the interpolation rewrites run.task from the
		// un-nudged item text.
		const brief = seenArgs!.at(-1)!;
		expect(brief).toBe(
			"Task: Second step, given: All three items are complete.\n\n" +
				YOUR_PLAN_NUDGE(1),
		);

		// The chained Run's own plan file is seeded under its run-suffixed key.
		const chained = await parsePlanFile(
			path.join(agentDir, "plans", `${taskId}.r2.jsonl`),
		);
		expect(chained.map((i) => i.id)).toEqual(["p1"]);
		expect(chained[0]!.status).toBe("backlog");
		expect(chained[0]!.route).toBe("skip");
	});
});
