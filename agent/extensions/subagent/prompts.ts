/**
 * Reading back the prompt recorded at spawn (docs/adr/0045, docs/adr/0047).
 *
 * The prompt is recorded at spawn as `prompt.md` in the Run directory, so
 * reading it back is a disk operation even for the current session — the
 * registry only says *which* Runs a Task has. Resolution therefore spans
 * sessions the same way the Run Index does (docs/adr/0028): the live
 * lookup serves the current session, and the Run directories serve what
 * the registry lost when the process died (docs/adr/0001). An ID present
 * in both is resolved from the registry, which knows the exact Runs; the
 * disk fills in the rest. That is the ADR's stated motivation for
 * recording the prompt at spawn: the evidence must survive the registry
 * and serve historical Runs, not just the live one.
 *
 * This module has no extension runtime, so it can be unit-tested by
 * running it directly.
 *
 * @module prompts
 */

import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { runsRoot } from "./rundir.js";
import { groupRunsByTask, scanRunDirs } from "./runindex.js";

/**
 * The standard note for a Run without a `prompt.md`: one that predates
 * prompt recording, or was refused before spawn. The live and historical
 * paths must report it identically, so both read this one constant.
 */
export const NO_PROMPT =
	"(no prompt recorded — the Run predates prompt recording, or was refused before spawn)";

/** One Run as the prompt reader needs it: identity, label, chain position. */
export interface PromptRun {
	runId: string;
	agent: string;
	/** Ordinal position within a chain, if any. */
	step?: number;
}

/** A Task as the prompt reader needs it. The registry's `Task` satisfies it. */
export interface PromptTask {
	id: string;
	runs: PromptRun[];
}

/**
 * Read one Run's `prompt.md` from its Run directory.
 *
 * Never throws: a missing prompt is a reportable state, not an error
 * (docs/adr/0045).
 *
 * For a plan-spawned Run the file additionally carries the **Delegation brief**,
 * marked as the first user message (docs/adr/0047).
 */
export async function readRunPrompt(
	agentDir: string,
	runDirName: string,
): Promise<string> {
	try {
		const text = await readFile(
			path.join(runsRoot(agentDir), runDirName, "prompt.md"),
			"utf-8",
		);
		return text.trimEnd();
	} catch {
		return NO_PROMPT;
	}
}

/** The Run's ordinal within its Task: `sub-6748-2` → 2, unnumbered → 0. */
function ordinalOf(runDirName: string): number {
	const m = /-(\d+)$/.exec(runDirName);
	return m ? Number(m[1]) : 0;
}

/**
 * Resolve requested Task IDs to their Injected prompts: the live lookup
 * first (it knows the exact Runs of the current session), the on-disk Run
 * directories for what the registry lacks. An ID present in BOTH is
 * resolved from the registry alone — the same rule the Run Index uses
 * (docs/adr/0028) — so a retained run dir sharing an ID can never leak
 * into a live Task's output.
 *
 * Each resolvable ID contributes a block of lines, in request order: an
 * `<id>:` header (`(earlier session)` when resolved from disk), then per
 * Run a label and the prompt text. Live Runs are labelled by agent and,
 * in a chain, by step; disk Runs by ordinal (from the dir name) and agent
 * (from the Run Meta) — a Run's prompt is read back against the Run it
 * started, and the label is what identifies a Run that has no `prompt.md`
 * (docs/adr/0045).
 *
 * @param agentDir - The pi agent directory (`getAgentDir()`).
 * @param resolveLive - Registry lookup; `(id) => registry.get(id)`.
 * @param ids - Requested Task IDs.
 * @returns `lines` in request order; `live`, the IDs the live lookup
 *          resolved (for `details`); `missing`, the IDs in neither source.
 */
export async function collectTaskPrompts(
	agentDir: string,
	resolveLive: (id: string) => PromptTask | undefined,
	ids: string[],
): Promise<{ lines: string[]; live: string[]; missing: string[] }> {
	const live: string[] = [];
	const blocks = new Map<string, string[]>();
	const historicalIds: string[] = [];
	for (const id of ids) {
		const task = resolveLive(id);
		if (task) {
			live.push(id);
			const block: string[] = [`${task.id}:`];
			for (const run of task.runs) {
				block.push(`─── ${run.step ? `step ${run.step}: ` : ""}${run.agent}`);
				block.push(await readRunPrompt(agentDir, run.runId));
			}
			blocks.set(id, block);
		} else {
			historicalIds.push(id);
		}
	}

	if (historicalIds.length > 0) {
		// One scan serves every disk ID; groupRunsByTask orders each Task's
		// Runs by ordinal, so #1 reads before #2 whatever the scan saw.
		const byTask = groupRunsByTask(await scanRunDirs(agentDir));
		for (const id of historicalIds) {
			const runs = byTask.get(id);
			if (!runs || runs.length === 0) continue;
			const block: string[] = [`${id} (earlier session):`];
			for (const run of runs) {
				const ordinal = ordinalOf(run.runId);
				block.push(
					`─── ${ordinal > 0 ? `#${ordinal} ` : ""}${run.agent}`,
				);
				block.push(await readRunPrompt(agentDir, run.runId));
			}
			blocks.set(id, block);
		}
	}

	const lines: string[] = [];
	const missing: string[] = [];
	for (const id of ids) {
		const block = blocks.get(id);
		if (block) lines.push(...block);
		else missing.push(id);
	}
	return { lines, live, missing };
}
