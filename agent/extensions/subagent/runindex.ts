/**
 * Run Index — the listing of Runs available to open, read from disk.
 *
 * The registry is memory-only by design (docs/adr/0001), so it cannot see past
 * sessions; the disk can. Neither source alone suffices, so the full index
 * merges both, with the registry winning for the current session (it knows
 * Mode, exact state, and cost) and the disk filling in the rest. `run.json`
 * is written best-effort, so a Run without it is still listed, with its
 * agent shown as `unknown` rather than hidden (docs/adr/0026, docs/adr/0028).
 *
 * This module reads Run session directories only, with no extension runtime,
 * so it can be unit-tested by running it directly.
 *
 * @module runindex
 */

import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

/**
 * Stop reasons that actually END a Run.
 *
 * Deliberately excludes `toolUse`, which is truthy but means the turn is
 * continuing — the model paused to call a tool. Measured across the run
 * directories on disk, `toolUse` outnumbers every terminal reason combined, so
 * "any stopReason means finished" mislabels the common case.
 *
 * `aborted` never appears in a session file (the cancel path stamps it in
 * memory) but is listed because a thawed or hand-written session could carry it
 * and it unambiguously means over. plan/board.ts keeps its own copy of this
 * list: the two are separate processes with no shared import, and ADR 0024
 * already accepted that the Board hand-mirrors what it cannot import.
 */
const TERMINAL_STOP_REASONS: readonly string[] = ["stop", "error", "aborted"];

/** One row of the Run Index. */
export interface RunIndexEntry {
	/** e.g. `sub-6748` — derived from the run dir name. */
	taskId: string;
	/** e.g. `sub-6748-1` — the run dir name itself. */
	runId: string;
	/** From `run.json`, or `unknown` when absent. */
	agent: string;
	/** Count of assistant messages in the session. */
	turns: number;
	/** `"completed" | "failed" | "running" | "dismissed" | "unknown"`. */
	state: string;
	/** ms epoch, from the session's first timestamp. */
	startedAt?: number;
	/** True when only a `.jsonl.zst` exists. */
	archived: boolean;
	/** True when the in-memory registry supplied this row. */
	live: boolean;
}

/**
 * Strip the trailing ordinal from a Run dir name to get the Task ID.
 *
 * `sub-6748-1` → `sub-6748`; falls back to the whole name when there is no
 * ordinal, so an unparseable directory still gets a row.
 */
function taskIdOf(runDirName: string): string {
	const m = /-\d+$/.exec(runDirName);
	return m ? runDirName.slice(0, m.index) : runDirName;
}

/**
 * Read a Run's `run.json` sidecar: the specialist name and the lifecycle
 * outcome the parent recorded (docs/adr/0026, docs/adr/0036).
 *
 * The sidecar is best-effort and missing from some Run directories, so every
 * failure mode degrades to `unknown` — the row is still listed, because the
 * Task ID is the thing being looked up (docs/adr/0028). `outcome` is likewise
 * undefined for the sidecars written before the field existed, and the caller
 * falls back to deriving state from the session for those.
 */
async function readRunMeta(
	runDir: string,
): Promise<{ agent: string; outcome?: string }> {
	try {
		const meta = JSON.parse(
			await readFile(path.join(runDir, "run.json"), "utf-8"),
		) as { agent?: unknown; outcome?: unknown };
		return {
			agent:
				typeof meta.agent === "string" && meta.agent !== ""
					? meta.agent
					: "unknown",
			outcome: typeof meta.outcome === "string" ? meta.outcome : undefined,
		};
	} catch {
		return { agent: "unknown" };
	}
}

/**
 * What one live session file tells the index: turn count, start, state.
 *
 * Tolerates a half-written final line: the child appends as it goes, so the
 * last line can be truncated mid-JSON (same pattern as mirror.ts `load()`).
 */
async function scanLiveSession(
	file: string,
): Promise<{ turns: number; startedAt?: number; state: string }> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		// Unreadable file: the row still exists, it just reports nothing.
		return { turns: 0, state: "unknown" };
	}

	let turns = 0;
	let startedAt: number | undefined;
	let failed = false;
	let lastStopReason: string | undefined;

	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;

		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			// Half-written final line: drop it, the row is still usable.
			continue;
		}

		if (startedAt === undefined && typeof entry.timestamp === "string") {
			const t = Date.parse(entry.timestamp);
			if (!Number.isNaN(t)) startedAt = t;
		}

		if (entry.type !== "message") continue;
		const message = entry.message as
			| { role?: unknown; stopReason?: unknown; errorMessage?: unknown }
			| undefined;
		if (!message || message.role !== "assistant") continue;

		turns++;
		// The outcome is the LAST assistant message, not the worst one ever seen:
		// a Run that errored, retried and delivered is a success. Latching here
		// made /runs report every retry-surviving Run as failed — the common case
		// now that litellm 400s retry (docs/adr/0033).
		failed =
			message.stopReason === "error" ||
			typeof message.errorMessage === "string";
		// Overwritten unconditionally: a final assistant message with no
		// stopReason means the Run never settled, even when an earlier one did.
		lastStopReason =
			typeof message.stopReason === "string" ? message.stopReason : undefined;
	}

	// Any assistant message that errored fails the Run; otherwise a Run with
	// no stopReason on its last assistant message is still running.
	// `toolUse` is a truthy stopReason that means the OPPOSITE of finished: the
	// model stopped to call a tool and the turn continues. Treating any truthy
	// value as terminal reported a Run mid-tool-call as `completed` (measured on
	// disk: toolUse is by far the most common stopReason). board.ts was fixed for
	// this under the same finding; this is the same bug in the other consumer, so
	// the two now share one definition of terminal (docs/adr/0038).
	const state = failed
		? "failed"
		: lastStopReason !== undefined &&
				TERMINAL_STOP_REASONS.includes(lastStopReason)
			? "completed"
			: "running";
	return { turns, startedAt, state };
}

/**
 * One Run directory, reduced to its index row.
 *
 * Never throws: the caller skips a Run whose directory defies it.
 */
async function scanRunDir(
	runDir: string,
	runDirName: string,
): Promise<RunIndexEntry> {
	const names = await readdir(runDir);
	const taskId = taskIdOf(runDirName);
	const { agent, outcome } = await readRunMeta(runDir);

	// A live file wins over a leftover archive (an interrupted thaw leaves
	// both), mirroring the reaper's resolution order. Filenames carry a
	// timestamp prefix, so the newest live file is the last one sorted.
	const live = names.filter((n) => n.endsWith(".jsonl")).sort();
	const archived = names.filter((n) => n.endsWith(".jsonl.zst")).sort();

	if (live.length > 0) {
		const scanned = await scanLiveSession(path.join(runDir, live[live.length - 1]));
		return {
			taskId,
			runId: runDirName,
			agent,
			archived: false,
			live: false,
			...scanned,
			// run.json's outcome is the PARENT's record of the Run's lifecycle; the
			// session is only what the child managed to write. The parent wins in BOTH
			// directions, because each side is blind in one:
			//
			// - A Run killed mid-tool-call (a cancelled Task, a reaped wedge) leaves
			//   `toolUse` as its last stopReason forever, so the session alone reads
			//   "running" for a Run that died 14 hours ago — measured on sub-16a4.
			// - A Run still retrying a provider error has `error` as its last
			//   stopReason, so the session alone reads "failed" for a Run that is
			//   alive and will likely recover — measured live on sub-c1c23c02, which
			//   the registry reported running while this index called it failed.
			//   Since the retry patch (ADR 0034) made mid-Run errors routine, this is
			//   now the common case, not an edge one.
			//
			// - A dismissed Run (pane closed before it finished, docs/adr/0044)
			//   never settles: the session's last stopReason stays `toolUse` or is
			//   absent, so the session alone reads "running" for a Run the user
			//   ended. `dismissed` is terminal and must not fall through to it.
			//
			// So an explicit outcome is authoritative whatever it says, and only a
			// sidecar predating the field (or missing entirely) falls back to the
			// session derivation (docs/adr/0036 promoted run.json to real state).
			state:
				outcome === "completed" ||
				outcome === "failed" ||
				outcome === "running" ||
				outcome === "dismissed"
					? outcome
					: scanned.state,
		};
	}

if (archived.length > 0) {
		// Do not decompress during a scan: thawing would make listing as
		// expensive as opening, and the index only promises *that* a Run is
		// archived, not its contents (docs/adr/0022).
		//
		// The sidecar's terminal outcome is still authoritative here: run.json
		// keeps its state after the transcript is compressed, and reporting
		// "unknown" would lose a terminal state the parent already recorded.
		// `running` is deliberately not honoured: an archived file is cold
		// storage by definition, so a sidecar still reading `running` is stale
		// (the parent never finalized it), and "running" next to
		// `archived: true` would be self-contradictory.
		return {
			taskId,
			runId: runDirName,
			agent,
			archived: true,
			live: false,
			turns: 0,
			state:
				outcome === "completed" || outcome === "failed" || outcome === "dismissed"
					? outcome
					: "unknown",
		};
	}

	// An empty directory is a Run that has written nothing yet — the child is
	// still booting, or it died before its first write and the reaper has not
	// yet collected it (docs/adr/0022). Those two look identical on disk, which is
	// exactly why run.json carries the outcome: the parent knows which happened
	// even though the directory cannot show it. Without consulting it, a review
	// that wedged and was killed before writing a transcript reads "running"
	// forever — the dishonest-waiting bug ADR 0036 fixed in the Mirror Pane, which
	// survived here because this branch never looked at the sidecar.
	return {
		taskId,
		runId: runDirName,
		agent,
		archived: false,
		live: false,
		turns: 0,
		state:
			outcome === "completed" || outcome === "failed" || outcome === "dismissed"
				? outcome
				: "running",
	};
}

/**
 * Scan the on-disk Run session directories.
 *
 * Never throws: an unreadable directory is skipped, not fatal, so one wedged
 * Run cannot take the index down with it.
 *
 * @param agentDir - The pi agent directory (`getAgentDir()`).
 * @returns One row per Run directory, newest first by `startedAt` (undefined
 *          sorts last).
 */
export async function scanRunDirs(agentDir: string): Promise<RunIndexEntry[]> {
	const root = path.join(agentDir, "subagent-sessions");

	let dirents;
	try {
		dirents = await readdir(root, { withFileTypes: true });
	} catch {
		return []; // Nothing has ever run.
	}

	const entries: RunIndexEntry[] = [];
	for (const dirent of dirents) {
		if (!dirent.isDirectory()) continue;
		// Skip bookkeeping directories that share this root but are not Runs. The
		// tree-wide spawn cap keeps its tokens here (docs/adr/0044), and a dot-prefixed
		// name can never be a Run since every runId is `sub-`/`pln-` prefixed.
		if (dirent.name.startsWith(".")) continue;
		try {
			entries.push(await scanRunDir(path.join(root, dirent.name), dirent.name));
		} catch {
			// Skip the unreadable directory; the rest of the index stands.
		}
	}

	entries.sort(
		(a, b) =>
			(b.startedAt ?? 0) - (a.startedAt ?? 0) ||
			a.runId.localeCompare(b.runId),
	);
	return entries;
}

/**
 * Relative time in the "5m ago" style; anything under a minute is "just now".
 */
function relativeTime(fromMs: number, nowMs: number = Date.now()): string {
	const s = Math.max(0, Math.round((nowMs - fromMs) / 1000));
	if (s < 60) return "just now";
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	return `${Math.floor(h / 24)}d ago`;
}

/**
 * Format entries as the lines shown to a human, **grouped by Task**.
 *
 * One row per Run made a parallel or chain Task appear two or three times with
 * the *same* ID, and since `/run <id>` opens every Run of a Task, those rows
 * were not separately actionable: three identical `sub-1ed9` rows offered three
 * ways to do one thing. Runs are the unit of execution; the Task is the unit a
 * human addresses, so the Task is what gets a row.
 *
 * A single-Run Task keeps the old one-line shape — the overwhelming case, and
 * indenting it under a header would be ceremony for nothing. A multi-Run Task
 * gets a header line carrying the ID, the agent, an aggregate state and the
 * total turns, then one indented child line per Run identified by its ordinal.
 *
 * The aggregate state is deliberately pessimistic: `failed` if any Run failed,
 * The aggregate state is deliberately pessimistic: `failed` if any Run failed,
 * else `running` if any is still going, else `dismissed` if any Run was waved
 * away, else `completed` only when all are.
 * what someone scanning this list is looking for.
 *
 * No cost column: session files record `cost.total: 0` throughout, and a
 * column that always reads `$0.0000` is worse than no column (docs/adr/0028).
 */
export function formatRunIndex(entries: RunIndexEntry[]): string {
	if (entries.length === 0) return "";

	const turnsLabel = (n: number) => `${n} turn${n === 1 ? "" : "s"}`;

	// Group by Task, preserving the order scanRunDirs established (newest first).
	const tasks: { taskId: string; runs: RunIndexEntry[] }[] = [];
	const byId = new Map<string, RunIndexEntry[]>();
	for (const e of entries) {
		let runs = byId.get(e.taskId);
		if (!runs) {
			runs = [];
			byId.set(e.taskId, runs);
			tasks.push({ taskId: e.taskId, runs });
		}
		runs.push(e);
	}
	// Within a Task, order by the Run's ordinal so #1 reads before #2. Sorting by
	// runId as a string would put -10 before -2, so compare the ordinal numerically.
	for (const t of tasks) t.runs.sort((a, b) => ordinalOf(a) - ordinalOf(b));

	// Column widths are computed across the header rows only — child lines are
	// indented and free-form, so including them would pad every header by the
	// indent and leave a ragged gap.
	const headerAgent = (t: { runs: RunIndexEntry[] }) =>
		t.runs.every((r) => r.agent === t.runs[0]!.agent) ? t.runs[0]!.agent : "mixed";
	const idW = Math.max(...tasks.map((t) => t.taskId.length));
	const agentW = Math.max(...tasks.map((t) => headerAgent(t).length));
	const stateW = Math.max(...tasks.map((t) => aggregateState(t.runs).length));
	const turnsW = Math.max(
		...tasks.map(
			(t) => turnsLabel(t.runs.reduce((n, r) => n + r.turns, 0)).length,
		),
	);

	const out: string[] = [];
	for (const t of tasks) {
		const runs = t.runs;
		const turns = runs.reduce((n, r) => n + r.turns, 0);
		const state = aggregateState(runs);
		// A Task started when its earliest Run started.
		const starts = runs
			.map((r) => r.startedAt)
			.filter((s): s is number => s !== undefined);
		const when = starts.length ? relativeTime(Math.min(...starts)) : "unknown";

		let line =
			`${t.taskId.padEnd(idW)}  ${headerAgent(t).padEnd(agentW)}  ` +
			`${state.padEnd(stateW)}  ${turnsLabel(turns).padEnd(turnsW)}  ${when}`;
		if (runs.length > 1) line += `  (${runs.length} runs)`;
		// The marker goes after the time so the columns stay aligned. On a header it
		// means every Run is archived; a partially-archived Task says so per Run.
		else if (runs[0]!.archived) line += "  (archived)";
		out.push(line);

		if (runs.length === 1) continue;
		for (const r of runs) {
			const rWhen =
				r.startedAt !== undefined ? relativeTime(r.startedAt) : "unknown";
			let child =
				`  #${ordinalOf(r)}  ${r.agent}  ${r.state}  ` +
				`${turnsLabel(r.turns)}  ${rWhen}`;
			if (r.archived) child += "  (archived)";
			out.push(child);
		}
	}
	return out.join("\n");
}

/** The Run's ordinal within its Task: `sub-6748-2` → 2, unnumbered → 0. */
function ordinalOf(e: RunIndexEntry): number {
	const m = /-(\d+)$/.exec(e.runId);
	return m ? Number(m[1]) : 0;
}

/**
 * Collapse a Task's Run states into one, worst-first.
 *
 * Pessimistic by design: a Task with a failed Run reads `failed` even if its
 * siblings succeeded, because a partial failure is the thing worth surfacing.
 * A dismissed Run is terminal like a failure but names the user's decision,
 * not a fault: it loses to any live or failed Run and wins over `completed`.
 */
function aggregateState(runs: RunIndexEntry[]): string {
	if (runs.some((r) => r.state === "failed")) return "failed";
	if (runs.some((r) => r.state === "running")) return "running";
	if (runs.some((r) => r.state === "dismissed")) return "dismissed";
	if (runs.every((r) => r.state === "completed")) return "completed";
	return runs.some((r) => r.state === "unknown") ? "unknown" : runs[0]!.state;
}
