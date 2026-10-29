/**
 * Linked-run status for the kanban board — the one filesystem reader of
 * `subagent-runs/<runId>/meta.json` this extension has, plus a bounded tail
 * read of the run's session JSONL for the child's live todo counts.
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

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

import { hasExitSidecar, isRunRecord, isSessionFileFor, metaPath, runDir } from "../subagent-herdr/rundir.js";
import { counts, parseTodoState } from "../lib/todo.js";
import { RUN_ID_PATTERN, type RunInfo, type RunInfos, type RunTodoCounts } from "./lib.js";

const KNOWN_STATUS = new Set(["running", "done", "failed", "cancelled"]);


/**
 * The ladder of tail windows `readRunTodos` walks on a miss: the common case
 * is a recent `todo` op near the end of the transcript, so the first pass is
 * small; a miss expands the window before "no list" is concluded, to the cap.
 *
 * The bounds are measured, not assumed: re-measured over 450 transcripts in
 * 443 recorded run dirs, 37 carry a todo snapshot — 15 sit >32 KB from EOF,
 * the p90 gap is ~1.0 MB, the max ~2.8 MB, and the largest single line ~1.0
 * MB. The 4 MB cap covers 37/37 recorded runs with ~1.2 MB of headroom; a
 * miss with the window already at the cap is evidence the transcript really
 * has no list. A first pass that misses is evidence the window was too small,
 * not that the child never built a list.
 */
const TODO_TAIL_STEPS = [32 * 1024, 512 * 1024, 4 * 1024 * 1024];

/**
 * One run's todo progress, read off its session file: the newest `todo` tool
 * result's snapshot, walked backwards.
 *
 * The session is untrusted, append-only JSONL written by a process that may
 * die mid-line, so:
 * - a line that does not parse is skipped — the torn final line is dropped
 *   by the caller before this runs;
 * - a `todo` result whose `details.state` `parseTodoState` refuses does not
 *   win the scan: the scan keeps looking for an older, well-formed one;
 * - an `isError` result is just as good as a successful one: a refused op's
 *   `details` carries the unchanged previous state, which is the state.
 *
 * @param lines - The session's lines, oldest first.
 */
export function parseRunTodos(lines: readonly string[]): RunTodoCounts | undefined {
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i];
		if (!line || !line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as {
			type?: unknown;
			message?: { role?: unknown; toolName?: unknown; details?: unknown };
		};
		if (e.type !== "message" || e.message?.role !== "toolResult" || e.message?.toolName !== "todo") continue;
		const state = parseTodoState((e.message?.details as { state?: unknown } | undefined)?.state);
		if (!state) continue;
		const c = counts(state);
		return { done: c.done, total: c.total, inProgress: c.inProgress, blocked: c.blocked };
	}
	return undefined;
}

/**
 * The `readRunTodos` results, keyed by the resolved session file path. The
 * board re-reads run info on every projection refresh, widget update and
 * `kanban:run-todos` event — a poll at the board's cadence — so a session
 * file whose `<size>:<mtimeMs>` stamp is unchanged is not re-parsed.
 */
const todoCache = new Map<string, { stamp: string; todos: RunTodoCounts | undefined }>();

/**
 * runId → the session file the last read resolved, so a terminal run's cache
 * entry can be dropped without a second directory listing.
 */
const todoFileOf = new Map<string, string>();

/**
 * Byte offsets scanned to EOF with NO todo snapshot found, per transcript.
 * The transcript is append-only, so on the next read only [offset, size) is
 * new — and it starts at an EOF boundary, so its first line is complete.
 * Without this, a live run with no list and a transcript past the 4 MB cap
 * pays the whole ladder (32 KB + 512 KB + 4 MB read AND parsed, synchronously
 * in pi's main loop) on every append; with it, growth costs one appended-
 * region read. Cleared when a snapshot IS found (the region stops being
 * evidence) and on every cache drop.
 */
const scannedTo = new Map<string, number>();

function readRunTodos(dir: string, runId: string): RunTodoCounts | undefined {
	try {
		const names = readdirSync(dir).filter((n) => isSessionFileFor(n, runId));
		if (names.length === 0) return undefined;
		// A run dir can hold more than one session file (a resumed session):
		// 3 of 443 recorded dirs do. The names are ISO-timestamp-prefixed, so
		// lexicographic order is chronological order — the newest wins.
		names.sort();
		const file = join(dir, names[names.length - 1]);
		const prev = todoFileOf.get(runId);
		// resumed dir: the older transcript is gone — drop both caches for it
		if (prev && prev !== file) {
			todoCache.delete(prev);
			scannedTo.delete(prev);
		}
		todoFileOf.set(runId, file);
		const st = statSync(file);
		const stamp = `${st.size}:${st.mtimeMs}`;
		const hit = todoCache.get(file);
		if (hit && hit.stamp === stamp) return hit.todos;
		const scanned = scannedTo.get(file);
		if (scanned !== undefined) {
			// Append-only: the bytes below `scanned` were read to EOF and carry
			// no snapshot. Unchanged size = nothing possible; growth = scan the
			// appended region only.
			if (scanned >= st.size) return undefined;
			const lines = readRange(file, scanned, st.size - scanned).split("\n");
			lines.pop(); // torn final line: not evidence
			const grown = parseRunTodos(lines);
			scannedTo.set(file, st.size);
			if (!grown) todoCache.set(file, { stamp, todos: undefined });
			else scannedTo.delete(file); // a found list is not "no list"
			return grown;
		}
		// The ladder: a miss in the small window expands before "no list" is
		// concluded (the measured bound is on TODO_TAIL_STEPS).
		let todos: RunTodoCounts | undefined;
		let covered = false;
		for (const bytes of TODO_TAIL_STEPS) {
			const lines = readTail(file, bytes).split("\n");
			// A torn final line (a write in progress) is not evidence: drop it, the
			// same rule `extractRunResult` applies.
			lines.pop();
			todos = parseRunTodos(lines);
			if (todos) break;
			// A window that already covered the whole file read everything there is:
			// every larger step would re-read and re-parse byte-identical bytes, and
			// a run with no list walks this ladder on **every** append (the board
			// polls at 1 s, the widget refreshes inside pi's main loop). Stop covered.
			if (bytes >= st.size) {
				covered = true;
				break;
			}
		}
		if (todos) scannedTo.delete(file);
		else if (covered) scannedTo.set(file, st.size); // EOF proven empty
		todoCache.set(file, { stamp, todos });
		return todos;
	} catch {
		return undefined;
	}
}

/** `len` bytes starting at `offset`, for the appended region of a scan. */
function readRange(file: string, offset: number, len: number): string {
	const fd = openSync(file, "r");
	try {
		const buf = Buffer.alloc(len);
		const n = readSync(fd, buf, 0, len, offset);
		return buf.toString("utf-8", 0, n);
	} finally {
		closeSync(fd);
	}
}

/** At most `bytes` from the end of `file`, without loading the whole file. */
function readTail(file: string, bytes: number): string {
	const fd = openSync(file, "r");
	try {
		const size = fstatSync(fd).size;
		const len = Math.min(bytes, size);
		const buf = Buffer.alloc(len);
		const bytesRead = readSync(fd, buf, 0, len, size - len);
		return buf.toString("utf-8", 0, bytesRead);
	} finally {
		closeSync(fd);
	}
}
/** One run's status, `unknown` when its record is absent or unreadable. Never throws. */
export function readRunInfo(agentDir: string, runId: string): RunInfo {
	// The id is joined into a path: anything but the minted shape is refused.
	if (!RUN_ID_PATTERN.test(runId)) return { status: "unknown" };
	const dir = runDir(agentDir, runId);
	// A cache entry must not outlive the run it keys: terminal — meta-terminal,
	// or `running` with an `.exit` sidecar (the most common transition, which
	// used to return before the drop) — the session file is closed and will not
	// grow, so the entry goes now. Same for a swept dir (meta absent/unreadable)
	// and a record that fails validation: the path is deleted, never re-read.
	const dropTodoCache = () => {
		const file = todoFileOf.get(runId);
		if (file) {
			todoCache.delete(file);
			todoFileOf.delete(runId);
			scannedTo.delete(file);
		}
	};
	let record: unknown;
	try {
		record = JSON.parse(readFileSync(metaPath(dir), "utf-8"));
	} catch {
		dropTodoCache();
		return { status: "unknown" };
	}
	if (!isRunRecord(record) || record.runId !== runId) {
		dropTodoCache();
		return { status: "unknown" };
	}
	const agent = typeof record.agent === "string" ? record.agent : undefined;
	const status = KNOWN_STATUS.has(record.status) ? record.status : "unknown";
	if (status === "running" && hasExitSidecar(dir, runId)) {
		dropTodoCache();
		return { status: "done", ...(agent ? { agent } : {}) };
	}
	// The board renders progress for live work only: a terminal run's session
	// file is not going to grow, so it is not read.
	if (status !== "running" && status !== "unknown") {
		dropTodoCache();
		return { status, ...(agent ? { agent } : {}) } as RunInfo;
	}
	const todos = readRunTodos(dir, runId);
	return { status, ...(agent ? { agent } : {}), ...(todos ? { todos } : {}) } as RunInfo;
}

/** Status for each id. Small and synchronous: a board links a handful of runs. */
export function readRunInfos(agentDir: string, runIds: readonly string[]): RunInfos {
	const out: Record<string, RunInfo> = {};
	for (const id of runIds) out[id] = readRunInfo(agentDir, id);
	return out;
}
