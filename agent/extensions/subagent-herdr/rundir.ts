/**
 * The layout of a run directory, and the shapes of the files inside it.
 *
 * A delegated run is a directory under `<agentDir>/subagent-runs/<runId>/`
 * holding everything two processes need to agree on:
 *
 * ```
 * subagent-runs/sub-a3f1/
 *   meta.json                     the parent's registry record
 *   system-prompt.md              the child's composed system prompt
 *   reports.jsonl                 child → orchestrator messages, appended
 *   <timestamp>_sub-a3f1.jsonl    the child's session transcript (pi mints it)
 *   <timestamp>_sub-a3f1.jsonl.exit   the completion sidecar
 * ```
 *
 * ## Why this is its own module
 *
 * The contract spans a process seam: the parent (`index.ts`, `lib.ts`) reads
 * what the child (`child-done.ts`) writes. The child is launched with pi's `-e`
 * and imports nothing from the parent, so both halves used to hand-write the
 * same paths and the same JSON shapes — the `.exit` suffix was spelled in two
 * files, `"reports.jsonl"` in two more, and the report record was built in one
 * place and re-validated field-by-field in another. Nothing linked them, so
 * nothing would have caught them drifting apart.
 *
 * pi's extension loader resolves a `-e` module's imports through jiti with
 * `tryNative: false`, so a child extension can import its siblings exactly like
 * the parent does. That makes one shared module possible, and a writer and a
 * reader that cannot disagree is worth more than either half's independence.
 *
 * ## What is deliberately not here
 *
 * The reads and writes themselves. This module answers "where does it live and
 * what shape is it", not "go and fetch it": `readReports` stays in `lib.ts`
 * where the parent's async I/O lives, and `appendReport`/`writeSidecar` stay in
 * `child-done.ts` where the child's synchronous, crash-path-sensitive writes
 * live. Paths and shapes are the part both sides must agree on.
 *
 * @module subagent-herdr/rundir
 */

import { join } from "node:path";

/**
 * Directory holding every run's session, sidecar and metadata (gitignored).
 *
 * Takes the agent directory rather than resolving it, so this module stays
 * importable by the child without depending on pi's export surface.
 *
 * @param agentDir - pi's agent directory.
 */
export function runsDir(agentDir: string): string {
	return join(agentDir, "subagent-runs");
}

/**
 * One run's directory.
 *
 * Derived from the run id rather than stored: the path is always the same
 * function of the id, and a persisted copy is state that can contradict where
 * the file was actually found (after a moved agent dir, a renamed home, a
 * record copied between machines).
 *
 * @param agentDir - pi's agent directory.
 * @param runId - The run id, e.g. `sub-a3f1`.
 */
export function runDir(agentDir: string, runId: string): string {
	return join(runsDir(agentDir), runId);
}

/** The parent's registry record for a run. */
export function metaPath(runDirPath: string): string {
	return join(runDirPath, "meta.json");
}

/** The child's composed system prompt, passed to pi by path, not by value. */
export function systemPromptPath(runDirPath: string): string {
	return join(runDirPath, "system-prompt.md");
}

/** The child's report log, appended by the child's report tool. */
export function reportsPath(runDirPath: string): string {
	return join(runDirPath, "reports.jsonl");
}

/**
 * The completion sidecar for a session file.
 *
 * Deliberately derived from the session file rather than the run directory: the
 * child knows its session path (pi mints the timestamp prefix) and the parent
 * discovers it by globbing for `*_<runId>.jsonl`, so the sidecar has to hang off
 * whatever that file turned out to be called.
 *
 * @param sessionFile - The child's session transcript path.
 */
export function exitPath(sessionFile: string): string {
	return `${sessionFile}.exit`;
}

/**
 * Does this directory entry look like the session file for `runId`?
 *
 * pi names a session `<timestamp>_<sessionId>.jsonl`, so ownership by run id is
 * unambiguous and a resumed session cannot be mistaken for a different run.
 *
 * @param fileName - A bare file name from the run directory.
 * @param runId - The run id to match.
 */
export function isSessionFileFor(fileName: string, runId: string): boolean {
	return fileName.endsWith(`_${runId}.jsonl`);
}

/** How a run ended, as recorded in `meta.json`. */
export type RunStatus = "running" | "done" | "failed" | "cancelled";

/**
 * One delegated run, persisted verbatim as `meta.json`.
 *
 * No `runDir`: see {@link runDir} — the path is derived from `runId`, so storing
 * it would be a second source of truth for something already known.
 */
export interface RunRecord {
	runId: string;
	agent: string;
	task: string;
	cwd: string;
	model?: string;
	paneId?: string;
	tabId?: string;
	status: RunStatus;
	startedAt: number;
	finishedAt?: number;
}

/**
 * Is this parsed JSON a usable {@link RunRecord}?
 *
 * The registry is rebuilt by reading every `meta.json` on disk, where a record
 * can be truncated (the parent crashed mid-spawn) or predate a field. Only
 * `runId` is load-bearing for keying the registry, so that is what this
 * insists on.
 */
export function isRunRecord(value: unknown): value is RunRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { runId?: unknown }).runId === "string"
	);
}

/** One child → orchestrator message, one JSON object per line of the log. */
export interface ChildReport {
	/** When it was written (ms), for ordering. */
	at: number;
	message: string;
}

/**
 * Serialise one report as a line for {@link reportsPath}.
 *
 * The trailing newline is part of the format, not the caller's business: the log
 * is append-only from a process that may die mid-write, and the reader drops a
 * partial final line.
 */
export function formatReportLine(message: string, at: number = Date.now()): string {
	return `${JSON.stringify({ at, message } satisfies ChildReport)}\n`;
}

/**
 * Parse one line of {@link reportsPath}, or `undefined` if it is not a report.
 *
 * Tolerates the partial final line of a log being appended to as it is read, and
 * defaults a missing `at` to 0 so an old or truncated record still orders.
 */
export function parseReportLine(line: string): ChildReport | undefined {
	if (!line.trim()) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { message?: unknown }).message !== "string"
	) {
		return undefined;
	}
	const rec = parsed as { at?: unknown; message: string };
	return {
		at: typeof rec.at === "number" ? rec.at : 0,
		message: rec.message,
	};
}

/** The completion sidecar's contents. */
export interface ExitSidecar {
	type: "done";
	at: number;
}

/**
 * Serialise the completion sidecar.
 *
 * The sidecar says *when* a run finished, never what it concluded: the child's
 * transcript already carries the answer, and duplicating it here would put a
 * size limit on something that is already on disk in full.
 */
export function formatExitSidecar(at: number = Date.now()): string {
	return JSON.stringify({ type: "done", at } satisfies ExitSidecar);
}
