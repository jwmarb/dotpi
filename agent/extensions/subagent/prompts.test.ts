/**
 * Regression tests for the `prompt` action's resolution (docs/adr/0045).
 *
 * The finding under test (oracle review, 2026-09-14): the action resolved
 * requested IDs exclusively through the in-memory registry, so a Task from an
 * earlier session — whose `prompt.md` exists on disk and which `list` can
 * show — was reported as unknown. The prompt is disk evidence precisely
 * because the registry dies with the session (docs/adr/0001), so the action
 * must resolve against the on-disk Run index as well, exactly like `list`
 * and `open` already do (docs/adr/0028).
 *
 * Not discovered by pi's extension loader (a subdirectory exposes only its
 * `index.ts`); run directly: `bun test agent/extensions/subagent/prompts.test.ts`
 *
 * @module prompts.test
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	collectTaskPrompts,
	NO_PROMPT,
	readRunPrompt,
	type PromptTask,
} from "./prompts.js";
import { emptyUsage, type RunResult, type Task } from "./tasks.js";

async function tempAgentDir(): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), "prompt-test-"));
	return dir;
}

/** Tear down a temp agent dir; tests never leak into the real one. */
async function cleanup(dir: string): Promise<void> {
	await rm(dir, { recursive: true, force: true });
}

/**
 * Materialise one Run directory the way the producers write it: `run.json`
 * sidecar (agent omitted when `agent === null`), plus `prompt.md` when the
 * recording is present.
 */
async function makeRun(
	agentDir: string,
	runId: string,
	agent: string | null,
	prompt?: string,
): Promise<void> {
	const dir = path.join(agentDir, "subagent-sessions", runId);
	await mkdir(dir, { recursive: true });
	if (agent !== null)
		await writeFile(
			path.join(dir, "run.json"),
			JSON.stringify({ runId, agent }),
		);
	if (prompt !== undefined)
		await writeFile(path.join(dir, "prompt.md"), prompt);
}

/** A minimal registry-shaped Run, for the live-path tests. */
function fakeRun(runId: string, agent: string, step?: number): RunResult {
	return {
		agent,
		runId,
		agentSource: "project",
		task: "test task",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		...(step !== undefined ? { step } : {}),
	};
}

/** A minimal registry-shaped Task, for the live-path tests. */
function fakeTask(id: string, runs: RunResult[]): Task {
	return {
		id,
		mode: "single",
		state: "completed",
		agentScope: "project",
		projectAgentsDir: null,
		agentNames: runs.map((r) => r.agent),
		runs,
		startedAt: Date.now(),
		abort: new AbortController(),
		notified: true,
	};
}

describe("readRunPrompt", () => {
	it("returns the recorded prompt, trailing whitespace trimmed", async () => {
		const agentDir = await tempAgentDir();
		try {
			await makeRun(agentDir, "sub-abc-1", "worker", "the prompt text\n\n");
			expect(await readRunPrompt(agentDir, "sub-abc-1")).toBe("the prompt text");
		} finally {
			await cleanup(agentDir);
		}
	});

	it("reports the placeholder when prompt.md is absent", async () => {
		const agentDir = await tempAgentDir();
		try {
			await makeRun(agentDir, "sub-abc-1", "worker");
			expect(await readRunPrompt(agentDir, "sub-abc-1")).toBe(NO_PROMPT);
		} finally {
			await cleanup(agentDir);
		}
	});

	it("reports the placeholder for a run that never existed", async () => {
		const agentDir = await tempAgentDir();
		try {
			expect(await readRunPrompt(agentDir, "sub-nope-1")).toBe(NO_PROMPT);
		} finally {
			await cleanup(agentDir);
		}
	});
});

describe("collectTaskPrompts", () => {
	const liveTask = fakeTask("sub-live1", [
		fakeRun("sub-live1-1", "worker", 1),
		fakeRun("sub-live1-2", "worker", 2),
	]);
	const resolveLive = (id: string): PromptTask | undefined =>
		id === "sub-live1" ? liveTask : undefined;
	const emptyRegistry = () => undefined;

	it("serves a current-session task from the live lookup, labelled per step", async () => {
		const agentDir = await tempAgentDir();
		try {
			await makeRun(agentDir, "sub-live1-1", "worker", "first prompt");
			await makeRun(agentDir, "sub-live1-2", "worker", "second prompt");
			const { lines, live, missing } = await collectTaskPrompts(
				agentDir,
				resolveLive,
				["sub-live1"],
			);
			expect(live).toEqual(["sub-live1"]);
			expect(missing).toEqual([]);
			expect(lines).toEqual([
				"sub-live1:",
				"─── step 1: worker",
				"first prompt",
				"─── step 2: worker",
				"second prompt",
			]);
		} finally {
			await cleanup(agentDir);
		}
	});

	it("serves an earlier-session task from disk with no registry entry", async () => {
		const agentDir = await tempAgentDir();
		try {
			await makeRun(agentDir, "sub-old123-1", "worker", "old prompt text");
			const { lines, live, missing } = await collectTaskPrompts(
				agentDir,
				emptyRegistry,
				["sub-old123"],
			);
			expect(live).toEqual([]);
			expect(missing).toEqual([]);
			expect(lines).toEqual([
				"sub-old123 (earlier session):",
				"─── #1 worker",
				"old prompt text",
			]);
		} finally {
			await cleanup(agentDir);
		}
	});

	it("serves a multi-run earlier-session task in ordinal order", async () => {
		const agentDir = await tempAgentDir();
		try {
			// #2 materialised before #1 on disk: the order must come from the
			// ordinal, not the scan.
			await makeRun(agentDir, "sub-abc-2", "worker", "run two prompt");
			await makeRun(agentDir, "sub-abc-1", "worker", "run one prompt");
			const { lines, missing } = await collectTaskPrompts(
				agentDir,
				emptyRegistry,
				["sub-abc"],
			);
			expect(missing).toEqual([]);
			expect(lines).toEqual([
				"sub-abc (earlier session):",
				"─── #1 worker",
				"run one prompt",
				"─── #2 worker",
				"run two prompt",
			]);
		} finally {
			await cleanup(agentDir);
		}
	});

	it("resolves an id present in BOTH sources from the registry alone", async () => {
		const agentDir = await tempAgentDir();
		try {
			// The registry row wins (docs/adr/0028): a retained run dir sharing
			// the ID must not leak into the live Task's output.
			await makeRun(agentDir, "sub-live1-1", "worker", "first prompt");
			await makeRun(agentDir, "sub-live1-2", "worker", "second prompt");
			await makeRun(agentDir, "sub-live1-9", "worker", "stray disk run");
			const { lines, live, missing } = await collectTaskPrompts(
				agentDir,
				resolveLive,
				["sub-live1"],
			);
			expect(live).toEqual(["sub-live1"]);
			expect(missing).toEqual([]);
			expect(lines.join("\n")).toContain("second prompt");
			expect(lines.join("\n")).not.toContain("stray disk run");
		} finally {
			await cleanup(agentDir);
		}
	});

	it("serves live, disk and unknown ids in one call, missing only the unknown", async () => {
		const agentDir = await tempAgentDir();
		try {
			await makeRun(agentDir, "sub-live1-1", "worker", "live prompt");
			await makeRun(agentDir, "sub-live1-2", "worker", "live prompt 2");
			await makeRun(agentDir, "sub-old123-1", "worker", "old prompt");
			const { lines, live, missing } = await collectTaskPrompts(
				agentDir,
				resolveLive,
				["sub-live1", "sub-nope", "sub-old123"],
			);
			expect(live).toEqual(["sub-live1"]);
			expect(missing).toEqual(["sub-nope"]);
			const text = lines.join("\n");
			expect(text).toContain("live prompt");
			expect(text).toContain("old prompt");
		} finally {
			await cleanup(agentDir);
		}
	});

	it("leaves lines empty when every id is unknown", async () => {
		const agentDir = await tempAgentDir();
		try {
			const { lines, live, missing } = await collectTaskPrompts(
				agentDir,
				emptyRegistry,
				["sub-nope"],
			);
			expect(lines).toEqual([]);
			expect(live).toEqual([]);
			expect(missing).toEqual(["sub-nope"]);
		} finally {
			await cleanup(agentDir);
		}
	});

	it("reports the placeholder for an earlier-session run without prompt.md", async () => {
		const agentDir = await tempAgentDir();
		try {
			// A run from before prompt recording: a directory, no prompt.md.
			await makeRun(agentDir, "sub-nop-1", "worker");
			const { lines, missing } = await collectTaskPrompts(
				agentDir,
				emptyRegistry,
				["sub-nop"],
			);
			expect(missing).toEqual([]);
			expect(lines).toContain(NO_PROMPT);
		} finally {
			await cleanup(agentDir);
		}
	});

	it("names the agent from run.json, degrading to unknown without it", async () => {
		const agentDir = await tempAgentDir();
		try {
			await makeRun(agentDir, "sub-lbl-1", null, "labelled prompt");
			const { lines } = await collectTaskPrompts(
				agentDir,
				emptyRegistry,
				["sub-lbl"],
			);
			// run.json is best-effort (docs/adr/0026): the Run Index degrades
			// its agent to `unknown`, and the label carries what it has.
			expect(lines).toContain("─── #1 unknown");
		} finally {
			await cleanup(agentDir);
		}
	});

	it("never matches a run dir whose id only starts with the task id", async () => {
		const agentDir = await tempAgentDir();
		try {
			// `sub-x` must not pick up `sub-x0-1` (docs/adr/0028).
			await makeRun(agentDir, "sub-x0-1", "worker", "other task prompt");
			const { lines, missing } = await collectTaskPrompts(
				agentDir,
				emptyRegistry,
				["sub-x"],
			);
			expect(lines).toEqual([]);
			expect(missing).toEqual(["sub-x"]);
		} finally {
			await cleanup(agentDir);
		}
	});
});
