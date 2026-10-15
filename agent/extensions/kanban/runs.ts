/**
 * Linked-run status for the kanban board — the one filesystem reader of
 * `subagent-runs/<runId>/meta.json` this extension has.
 *
 * The *shape* belongs to `subagent-herdr/rundir.ts` (`metaPath`, `isRunRecord`,
 * `RunStatus`, plus `hasExitSidecar` for the completion sidecar);
 * this module only reads, through those, so the record grammar is still spelled
 * once. Both the extension (settle guard, `show`) and the board process import
 * it, which is why it is separate from the pure `lib.ts`.
 *
 * Status is advisory: it never moves a card. A record still saying `running`
 * after its child wrote the `.exit` sidecar (the parent reconciles lazily) is
 * reported `done`, because the sidecar is what the parent itself classifies by.
 */

import { readFileSync } from "node:fs";

import { hasExitSidecar, isRunRecord, metaPath, runDir } from "../subagent-herdr/rundir.js";
import { RUN_ID_PATTERN, type RunInfo, type RunInfos } from "./lib.js";

const KNOWN_STATUS = new Set(["running", "done", "failed", "cancelled"]);

/** One run's status, `unknown` when its record is absent or unreadable. Never throws. */
export function readRunInfo(agentDir: string, runId: string): RunInfo {
	// The id is joined into a path: anything but the minted shape is refused.
	if (!RUN_ID_PATTERN.test(runId)) return { status: "unknown" };
	const dir = runDir(agentDir, runId);
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(metaPath(dir), "utf-8"));
	} catch {
		return { status: "unknown" };
	}
	if (!isRunRecord(record) || record.runId !== runId) return { status: "unknown" };
	const agent = typeof record.agent === "string" ? record.agent : undefined;
	const status = KNOWN_STATUS.has(record.status) ? record.status : "unknown";
	if (status === "running" && hasExitSidecar(dir, runId)) return { status: "done", ...(agent ? { agent } : {}) };
	return { status, ...(agent ? { agent } : {}) } as RunInfo;
}

/** Status for each id. Small and synchronous: a board links a handful of runs. */
export function readRunInfos(agentDir: string, runIds: readonly string[]): RunInfos {
	const out: Record<string, RunInfo> = {};
	for (const id of runIds) out[id] = readRunInfo(agentDir, id);
	return out;
}
