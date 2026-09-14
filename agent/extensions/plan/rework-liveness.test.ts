/**
 * Tests for {@link reworkStillRunning} — whether a **Rework** is still working an
 * Item, which decides if its autonomous review may start.
 *
 * ## Why this file exists
 *
 * Two bugs, in opposite directions, both about the word `running` in `run.json`.
 *
 * First a rework finished its work, died with its orchestrator before rewriting
 * its own sidecar, and left `running` on disk forever — wedging the Item's review
 * permanently, because nothing else ever revises that file.
 *
 * The fix for that was then wrong in the *dangerous* direction: it stamped the
 * spawner's pid and probed it. But herdr owns a **Native Run**'s process
 * (docs/adr/0044), so the child outlives its spawner — a dead spawner would have
 * been read as "the rework stopped" and started a review against a tree the
 * rework was still editing.
 *
 * So liveness is judged only by evidence the **child** writes. These tests pin
 * that: the **Done signal** and `.exitcode` end it, transcript mtime decides
 * otherwise, and the ambiguous cases fail toward *blocking* a review rather than
 * running one against half-finished work.
 */
import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { reworkStillRunning } from "./index.js";
import { REWORK_TIMEOUT_MS } from "./review.js";

const RUNS_ROOT = path.join(
	process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent"),
	"subagent-sessions",
);

const RUNNING = JSON.stringify({
	runId: "x",
	agent: "worker",
	outcome: "running",
});

/**
 * Materialise a Run directory, ageing any transcript so staleness is testable.
 *
 * @param id - Run id, used as the directory name.
 * @param files - File name to contents.
 * @param idleMs - How long ago the transcript was last written.
 */
function makeRunDir(
	id: string,
	files: Record<string, string>,
	idleMs = 0,
): string {
	const dir = path.join(RUNS_ROOT, id);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(path.join(dir, name), contents);
	}
	if (idleMs > 0) {
		const when = (Date.now() - idleMs) / 1000;
		for (const name of Object.keys(files)) {
			if (name.endsWith(".jsonl")) utimesSync(path.join(dir, name), when, when);
		}
	}
	return dir;
}

describe("reworkStillRunning", () => {
	const made: string[] = [];
	const fixture = (
		id: string,
		files: Record<string, string>,
		idleMs = 0,
	): string => {
		made.push(makeRunDir(id, files, idleMs));
		return id;
	};
	const cleanup = () => {
		for (const dir of made) rmSync(dir, { recursive: true, force: true });
		made.length = 0;
	};

	it("is over once the child wrote its Done signal", async () => {
		// The child writes this itself, so it survives the orchestrator's death.
		const id = fixture("pln-test-done", {
			"run.json": RUNNING,
			"s.jsonl": "{}",
			"s.jsonl.exit": JSON.stringify({ type: "done" }),
		});
		expect(await reworkStillRunning(id)).toBe(false);
		cleanup();
	});

	it("is over once the wrapper wrote an exit code", async () => {
		const id = fixture("pln-test-exitcode", {
			"run.json": RUNNING,
			"s.jsonl": "{}",
			"pln-test-exitcode.exitcode": "0",
		});
		expect(await reworkStillRunning(id)).toBe(false);
		cleanup();
	});

	it("still counts as running while the transcript is being written", async () => {
		// The regression the pid probe would have caused: a herdr-owned rework whose
		// spawner is long gone is STILL WORKING, and a review must not start.
		const id = fixture(
			"pln-test-fresh",
			{ "run.json": RUNNING, "s.jsonl": "{}" },
			5_000,
		);
		expect(await reworkStillRunning(id)).toBe(true);
		cleanup();
	});

	it("is over once the transcript has been idle past the rework timeout", async () => {
		const id = fixture(
			"pln-test-stale",
			{ "run.json": RUNNING, "s.jsonl": "{}" },
			REWORK_TIMEOUT_MS + 5 * 60 * 1000,
		);
		expect(await reworkStillRunning(id)).toBe(false);
		cleanup();
	});

	it("believes a FRESH running record that has no transcript yet", async () => {
		// Too early to judge: the child may be starting up. Blocking costs a delay,
		// while releasing reviews a half-edited tree — but this is bounded by the
		// directory's age, proved by the abandoned-startup case below.
		const id = fixture("pln-test-notranscript", { "run.json": RUNNING });
		expect(await reworkStillRunning(id)).toBe(true);
		cleanup();
	});

	it("does not block on a terminal outcome", async () => {
		const id = fixture("pln-test-terminal", {
			"run.json": JSON.stringify({
				runId: "x",
				agent: "worker",
				outcome: "completed",
			}),
		});
		expect(await reworkStillRunning(id)).toBe(false);
		cleanup();
	});

	it("does not block when there is no Run directory at all", async () => {
		expect(await reworkStillRunning("pln-test-absent")).toBe(false);
	});

	// The three cases a review of the first attempt rejected. Each is a way the
	// weaker signals get the answer wrong, and each is why the child's own pid is
	// consulted before transcript age.

	it("counts a LIVE child as running even when its transcript is stale", async () => {
		// The dangerous case: a rework sitting inside one long build writes nothing
		// for longer than its deadline. Transcript age alone would call it finished
		// and release a review against a tree it is still editing.
		const child = spawn("sleep", ["45"], { stdio: "ignore" });
		try {
			const id = fixture(
				"pln-test-livestale",
				{
					"run.json": RUNNING,
					"s.jsonl": "{}",
					"pln-test-livestale.pid": String(child.pid),
				},
				REWORK_TIMEOUT_MS + 10 * 60 * 1000,
			);
			expect(await reworkStillRunning(id)).toBe(true);
		} finally {
			child.kill("SIGKILL");
			cleanup();
		}
	});

	it("counts a DEAD child as finished even when its transcript is fresh", async () => {
		// Killed with its pane: no Done signal, no exit code, but definitely over.
		const child = spawn("true", [], { stdio: "ignore" });
		await new Promise((r) => child.on("exit", r));
		const id = fixture("pln-test-deadchild", {
			"run.json": RUNNING,
			"s.jsonl": "{}",
			"pln-test-deadchild.pid": String(child.pid),
		});
		expect(await reworkStillRunning(id)).toBe(false);
		cleanup();
	});

	it("does not wedge forever on a record with no pid and no transcript", async () => {
		// The original bug, relocated: a spawner that died between writing run.json
		// and the child producing anything must not block the Item permanently. The
		// directory's own age bounds it.
		const id = fixture("pln-test-abandoned", { "run.json": RUNNING });
		const dir = path.join(RUNS_ROOT, id);
		const old = (Date.now() - (REWORK_TIMEOUT_MS + 10 * 60 * 1000)) / 1000;
		utimesSync(dir, old, old);
		expect(await reworkStillRunning(id)).toBe(false);
		cleanup();
	});
});
