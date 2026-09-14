/**
 * The on-disk contract for a Run directory, shared by every producer.
 *
 * `<agentDir>/subagent-sessions/<runId>/` holding a `<iso>_<runId>.jsonl`
 * transcript and a `run.json` sidecar is not private to the subagent extension.
 * It is a published layout with three independent consumers — the Run Index
 * (`/runs`), the Board's per-card progress, and the Mirror Pane viewer — none of
 * which hold any handle on the process that produced it. That is deliberate: the
 * reaper explicitly protects directories owned by *another* pi process
 * (`freshnessGuardMs`), so a second producer was always anticipated.
 *
 * This module exists because the plan extension became that second producer when
 * it started spawning autonomous reviews. Without a shared writer the two would
 * each re-implement the layout, and the invariant most likely to be dropped is
 * the one that is easiest to miss: **`run.json` is written twice.** It starts
 * `outcome: "running"` and is rewritten to a terminal outcome when the child
 * ends. The Mirror Pane relies on exactly that transition to tell "this Run died
 * before writing anything" from "this Run has not started yet", which look
 * identical on disk (docs/adr/0036). A producer that writes the sidecar once
 * leaves a dead Run claiming forever that it is about to start.
 *
 * Deliberately NOT the Task registry (docs/adr/0039). The registry is in-memory
 * lifecycle machinery — waiters, cancellation, admission — and the Reminder it
 * would have been extracted for lives in the subagent extension's host closure,
 * not in the registry, so sharing it would buy nothing a spawner cannot already
 * do by awaiting its own child.
 */

import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * A Run's lifecycle as recorded in `run.json` by whoever spawned it.
 *
 * `dismissed` is terminal, like `completed` and `failed`, but deliberately a
 * separate value: it names a Run whose pane the user closed before it
 * finished. A Run the user waved away is not a Run that went wrong, so folding
 * it into `failed` would conflate a user decision with a fault (docs/adr/0044).
 */
export type RunOutcome = "running" | "completed" | "failed" | "dismissed";

/** The directory holding all Run session directories. */
export function runsRoot(agentDir: string): string {
	return path.join(agentDir, "subagent-sessions");
}

/** The directory for one Run. */
export function runDirFor(agentDir: string, runId: string): string {
	return path.join(runsRoot(agentDir), runId);
}

/**
 * Create a Run's directory and write its opening `run.json`.
 *
 * Best-effort by design: the sidecar is labelling, and a Run that works while
 * unlabelled is better than a Run refused because labelling failed. Consumers
 * already degrade to `unknown` on a missing sidecar.
 *
 * @param agentDir - The pi agent directory (`getAgentDir()`).
 * @param runId - The Run's ID, which is also its directory name.
 * @param agent - The specialist this Run is, e.g. `oracle`.
 * @returns The Run directory path, whether or not the sidecar was written.
 */
export async function createRunDir(
	agentDir: string,
	runId: string,
	agent: string,
): Promise<string> {
	const dir = runDirFor(agentDir, runId);
	await writeRunSidecar(dir, { runId, agent }, "running");
	return dir;
}

/**
 * Rewrite a Run's `run.json` with its terminal outcome.
 *
 * **Must be called from a `finally`**, not from the success path. A Run that
 * threw, was killed, or wedged is exactly the Run whose outcome a reader most
 * needs, and it is the one a success-path write would skip.
 */
export async function finalizeRunDir(
	runDir: string,
	runId: string,
	agent: string,
	outcome: Exclude<RunOutcome, "running">,
): Promise<void> {
	await writeRunSidecar(runDir, { runId, agent }, outcome);
}

/**
 * Write the `run.json` sidecar.
 *
 * Never throws: labelling is decoration, the Run matters. `step` is carried
 * only when present so a single-Run producer does not have to invent one.
 *
 * Exported as the primitive for producers that already hold their own run shape
 * (the subagent extension holds a `RunResult`); prefer {@link createRunDir} and
 * {@link finalizeRunDir}, which name the two moments this is called at.
 */
export async function writeRunSidecar(
	runDir: string,
	run: { runId: string; agent: string; step?: number },
	outcome: RunOutcome,
): Promise<void> {
	try {
		await mkdir(runDir, { recursive: true });
		await writeFile(
			path.join(runDir, "run.json"),
			JSON.stringify({
				runId: run.runId,
				agent: run.agent,
				...(run.step !== undefined ? { step: run.step } : {}),
				// The Run's lifecycle, for readers holding no handle on the child.
				outcome,
			}),
		);
	} catch {
		// Deliberately silent: see the doc comment.
	}
}

/**
 * The short form of a Run ID, for labels.
 *
 * Handles any producer's prefix rather than hard-coding `sub-`, so a
 * plan-spawned `pln-9f2a1c04-1` shortens like a subagent Run instead of
 * rendering in full. An ID with no recognised shape is returned unchanged.
 */
export function shortRunId(id: string): string {
	return /^[a-z]+-([^-]+)/.exec(id)?.[1] ?? id;
}

/**
 * The herdr pane label for a Run's Mirror Pane.
 *
 * Shared because this exact string is also the `findPaneByLabel` key used to
 * decide whether a pane is already open. A second, separately-written copy would
 * drift from this one and silently open duplicate panes for the same Run.
 */
export function mirrorPaneLabel(run: {
	runId: string;
	agent: string;
	multiRun?: boolean;
	step?: number;
}): string {
	const ordinal = /-(\d+)$/.exec(run.runId)?.[1];
	return run.multiRun
		? `${run.agent} #${run.step ?? ordinal ?? "?"}`
		: `${run.agent} (#${shortRunId(run.runId)})`;
}
