#!/usr/bin/env bun
/**
 * Mirror — renders one Run's session file in a herdr Pane.
 *
 * A Mirror Pane displays a Run; it never owns it (docs/adr/0016). The subagent
 * extension still spawns and owns the child `pi` process; this process only
 * reads the session file that child is writing (docs/adr/0019) and renders it
 * as it grows. There is no PTY and no byte replay: the child emits pure JSON,
 * so a rendering is strictly more useful than a transcript of bytes
 * (docs/adr/0020).
 *
 * The argument is the Run's session *directory*, not a file. The child's
 * filename is timestamp-prefixed and cannot be predicted, and the child does
 * not write it until after its own startup (extension load, MCP connect) — so
 * a parent that resolves the name up front is racing a boot it cannot bound.
 * This process resolves the newest `.jsonl` itself on every poll and latches
 * on when it appears, which makes a late-starting child a non-event
 * (docs/adr/0025).
 *
 * Closing this pane stops the display, never the Run.
 *
 * Usage: mirror.ts <session-dir> [--agent <name>] [--task <id>]
 *
 * @module mirror
 */

import { watch } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

const ESC = "\x1b";
const fg = (c: string, s: string) => `${ESC}[38;5;${c}m${s}${ESC}[0m`;
const bold = (s: string) => `${ESC}[1m${s}${ESC}[0m`;
const dim = (s: string) => `${ESC}[2m${s}${ESC}[0m`;

/** One rendered line of the transcript. */
type Line = string;

/** A session file entry. Only `message` entries carry a transcript. */
interface SessionEntry {
	type?: string;
	message?: {
		role?: string;
		content?: unknown;
		usage?: { cost?: { total?: number }; totalTokens?: number };
		stopReason?: string;
		errorMessage?: string;
		model?: string;
	};
	provider?: string;
	modelId?: string;
}

/** Truncate a single-line preview. */
function clip(s: string, n: number): string {
	const flat = s.replace(/\s+/g, " ").trim();
	return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** Wrap text to a width on word boundaries. */
function wrap(text: string, width: number): string[] {
	const out: string[] = [];
	for (const para of text.split("\n")) {
		if (!para.trim()) {
			out.push("");
			continue;
		}
		let cur = "";
		for (const w of para.split(/\s+/)) {
			if (!cur) cur = w;
			else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
			else {
				out.push(cur);
				cur = w;
			}
		}
		if (cur) out.push(cur);
	}
	return out;
}

/**
 * Summarise a tool call the way the orchestrator's own renderer does: the
 * argument that identifies the call, not the whole payload.
 */
function summariseTool(name: string, args: Record<string, unknown>): string {
	const s = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
	switch (name) {
		case "bash":
			return clip(s("command") || "…", 70);
		case "read":
		case "write":
		case "edit":
			return clip(s("file_path") || s("path") || "…", 70);
		case "ls":
		case "find":
			return clip(s("path") || s("pattern") || ".", 70);
		case "grep":
		case "ffgrep":
			return clip(s("pattern") || "…", 70);
		default: {
			const j = JSON.stringify(args);
			return clip(j.length > 70 ? `${j.slice(0, 69)}…` : j, 70);
		}
	}
}

/**
 * Render the session file into display lines.
 *
 * Returns the body and the status line separately: the body is append-only
 * output (so the terminal's own scrollback holds the history), while the status
 * is re-emitted only when it changes (docs/adr/0029).
 */
function renderTranscript(
	entries: SessionEntry[],
	width: number,
): { body: Line[]; status: string; empty: boolean } {
	const out: Line[] = [];
	let turns = 0;
	let cost = 0;
	let model = "";
	let lastStop: string | undefined;
	let errorMessage: string | undefined;

	for (const entry of entries) {
		if (entry.type === "model_change" && entry.modelId) model = entry.modelId;
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const content = Array.isArray(msg.content) ? msg.content : [];

		if (msg.role === "user") {
			// The delegated task itself.
			for (const c of content) {
				if (typeof c !== "object" || c === null) continue;
				const part = c as Record<string, unknown>;
				if (part.type === "text" && typeof part.text === "string") {
					out.push(fg("39", bold("▶ task")));
					for (const l of wrap(part.text, width - 4)) out.push(`  ${dim(l)}`);
					out.push("");
				}
			}
			continue;
		}

		if (msg.role === "assistant") {
			turns++;
			if (msg.model) model = msg.model;
			cost += msg.usage?.cost?.total ?? 0;
			if (msg.stopReason) lastStop = msg.stopReason;
			if (msg.errorMessage) errorMessage = msg.errorMessage;

			for (const c of content) {
				if (typeof c !== "object" || c === null) continue;
				const part = c as Record<string, unknown>;

				if (part.type === "thinking" && typeof part.thinking === "string") {
					const t = part.thinking.trim();
					if (t) out.push(`  ${dim(fg("240", clip(t, width - 6)))}`);
				} else if (part.type === "text" && typeof part.text === "string") {
					const t = part.text.trim();
					if (t) {
						for (const l of wrap(t, width - 4)) out.push(`  ${l}`);
						out.push("");
					}
				} else if (part.type === "toolCall") {
					const name = typeof part.name === "string" ? part.name : "?";
					const args =
						typeof part.arguments === "object" && part.arguments !== null
							? (part.arguments as Record<string, unknown>)
							: {};
					out.push(
						`  ${fg("214", "⚙")} ${fg("214", name)} ${dim(summariseTool(name, args))}`,
					);
				}
			}
			continue;
		}

		if (msg.role === "toolResult") {
			for (const c of content) {
				if (typeof c !== "object" || c === null) continue;
				const part = c as Record<string, unknown>;
				if (part.type === "text" && typeof part.text === "string") {
					const first = clip(part.text, width - 8);
					if (first) out.push(`     ${dim(fg("108", `→ ${first}`))}`);
				}
			}
		}
	}

	// The status line is built last so it can report totals gathered above. It is
	// emitted separately from the body: output is append-only so nothing can be
	// pinned, and reprinting a header per frame would litter the scrollback.
	const agent = argOf("--agent") ?? "subagent";
	const task = argOf("--task");
	const status =
		bold(fg("141", `── ${agent}`)) +
		(task ? dim(`  ${task}`) : "") +
		(model ? dim(`  ${model}`) : "") +
		dim(`  ${turns} turn${turns === 1 ? "" : "s"}`) +
		(cost > 0 ? dim(`  $${cost.toFixed(4)}`) : "") +
		(errorMessage
			? fg("203", "  error")
			: lastStop
				? dim(`  ${lastStop}`)
				: fg("45", "  working"));

	if (errorMessage) {
		out.push("");
		out.push(fg("203", `✗ ${clip(errorMessage, width - 4)}`));
	}

	return { body: out, status, empty: entries.length === 0 };
}

/** Read the CLI flag value following `name`. */
function argOf(name: string): string | undefined {
	const i = process.argv.indexOf(name);
	return i > 0 ? process.argv[i + 1] : undefined;
}

/** Parse the session file, tolerating partial final lines. */
async function load(file: string): Promise<SessionEntry[]> {
	let raw: string;
	try {
		raw = await readFile(file, "utf-8");
	} catch {
		return [];
	}
	const entries: SessionEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as SessionEntry);
		} catch {
			// The child appends as it goes, so the last line can be half-written.
		}
	}
	return entries;
}

const sessionDir = process.argv[2];
if (!sessionDir) {
	console.error("usage: mirror.ts <session-dir> [--agent <name>] [--task <id>]");
	process.exit(2);
}

/**
 * The session file being rendered, once one exists.
 *
 * Resolved lazily rather than passed in: the child's filename is
 * timestamp-prefixed, and it is not written until the child finishes its own
 * startup. Latching here means a slow boot delays the first frame instead of
 * pinning the pane to a path that never appears (docs/adr/0025).
 */
let file: string | null = null;
/** Filename of the latched attempt, so latching only ever moves forward. */
let latchedName = "";

/**
 * Find the Run's session file: the newest `.jsonl` in the Run's directory.
 *
 * Once latched the name is kept, so a reap or thaw racing a redraw cannot make
 * the pane jump to a different Run's transcript mid-flight.
 *
 * @returns Path of the session file, or null while the child has written none.
 */
async function resolveFile(): Promise<string | null> {
	try {
		const names = await readdir(sessionDir);
		const jsonl = names.filter((n) => n.endsWith(".jsonl"));
		if (!jsonl.length) return null;

		// Order by the timestamp the child put in the FILENAME, not by mtime.
		//
		// Both were tried. Filename-sort alone cannot distinguish attempts (it was
		// only ever "latch the last one"), and mtime cannot either: a thaw rewrites
		// an archived earlier attempt *now*, giving the oldest attempt the newest
		// mtime, which walked the viewer backwards mid-Run. The filename is the one
		// value that identifies *which attempt* a file belongs to — every session
		// file is `<iso>_<runId>.jsonl`, verified across all 19 on disk — so it is
		// the attempt boundary, and mtime is only a mirror of when bytes moved
		// (docs/adr/0036).
		const latest = jsonl.sort()[jsonl.length - 1];
		const candidate = path.join(sessionDir, latest);

		// Strictly forward: never move to an attempt older than the latched one.
		// Switching resets the printed cursor, so a backwards move would reprint an
		// earlier attempt's transcript as though it were new.
		if (!file || latest > latchedName) {
			file = candidate;
			latchedName = latest;
		}
		return file;
	} catch {
		// The directory can be created before anything lands in it.
		return null;
	}
}

/**
 * Emit whatever is new since the last draw.
 *
 * Append-only, and deliberately so. The previous implementation redrew a full
 * frame — clearing the screen with `2J`, the scrollback with `3J`, and keeping
 * only the tail of the body that fit the window. That made the pane
 * unscrollable twice over: the overflow was never written, and the scrollback
 * that would have held it was erased every tick. Printing only the new tail and
 * never clearing lets the terminal's own scrollback and mouse wheel work
 * (docs/adr/0029).
 *
 * The status line is re-emitted only when it changes, since it cannot be pinned
 * in an append-only stream.
 */
let printed = 0;
let lastStatus = "";
let announcedWaiting = false;
let announcedNoSession = false;
/** Which file `printed` counts lines of, so a switch can reset the cursor. */
let printedFor: string | null = null;

/**
 * Explain an empty pane when the Run will never fill it.
 *
 * Returns a sentence to print, or null while "waiting" is still the truth. The
 * viewer owns no lifecycle state, so this reads the two things it can see: the
 * Run Meta sidecar the parent writes, and whether the directory is readable at
 * all (docs/adr/0036).
 */
async function terminalWithoutSession(): Promise<string | null> {
	try {
		await readdir(sessionDir);
	} catch (err) {
		const code = (err as { code?: string }).code;
		// ENOENT is normal: the parent may not have created the directory yet.
		if (code === "ENOENT") return null;
		return `cannot read this run's directory (${code ?? "unknown error"}) — the run may be fine; this viewer cannot see it.`;
	}
	try {
		const meta = JSON.parse(
			await readFile(path.join(sessionDir, "run.json"), "utf-8"),
		) as { outcome?: unknown; stopReason?: unknown };
		if (typeof meta.outcome === "string" && meta.outcome !== "running")
			return `run ended (${meta.outcome}) without writing a session — there is no transcript to show.`;
	} catch {
		// No sidecar, or it predates the outcome field: stay silent rather than
		// guess. An older Run with no metadata is indistinguishable from a slow one.
	}
	return null;
}

async function draw(): Promise<void> {
	const resolved = await resolveFile();

	// A different file than the one `printed` counts means the Run moved on to a
	// new attempt (a model fallback re-runs in the same directory). Start the new
	// attempt's transcript as its own stream rather than diffing it against the
	// previous one's line count (docs/adr/0036).
	if (resolved && printedFor && resolved !== printedFor) {
		printed = 0;
		lastStatus = "";
		process.stdout.write(`\n${dim("  — new attempt —")}\n`);
	}
	if (resolved) printedFor = resolved;

	const entries = resolved ? await load(resolved) : [];
	const cols = process.stdout.columns ?? 80;
	const width = Math.max(30, Math.min(cols, 110));
	const { body, status, empty } = renderTranscript(entries, width);

	if (empty) {
		// The pane can open before the child has written anything: startup runs
		// before the first session write. Say so once rather than every tick.
		if (!announcedWaiting) {
			announcedWaiting = true;
			process.stdout.write(`${dim("  waiting for the run to start…")}\n`);
		}
		// "Waiting" is only honest while the Run might still start. The viewer has
		// file state but no lifecycle state, so a Run that died before its first
		// write — or a directory it cannot read — looked identical to a slow start
		// and sat there reassuringly forever. Run Meta carries the outcome, so say
		// what actually happened instead (docs/adr/0036).
		const why = await terminalWithoutSession();
		if (why && !announcedNoSession) {
			announcedNoSession = true;
			process.stdout.write(`${dim(`  ${why}`)}\n`);
		}
		return;
	}

	// A rewritten session (a thaw replacing the file, or a fresh run in the same
	// directory) can be shorter than what has already been printed. Reprinting
	// from zero would duplicate everything, so treat a shrink as a new stream.
	if (body.length < printed) printed = 0;

	if (body.length > printed) {
		process.stdout.write(`${body.slice(printed).join("\n")}\n`);
		printed = body.length;
	}

	if (status !== lastStatus) {
		lastStatus = status;
		process.stdout.write(`${status}\n`);
	}
}

let pending: ReturnType<typeof setTimeout> | undefined;
/** True while a draw is in flight; a second draw must not interleave with it. */
let drawing = false;
/** Set when a draw was requested while one was already running. */
let redrawRequested = false;

/**
 * Run one draw at a time.
 *
 * `draw` awaits a file read partway through, so a timer or watch event could
 * start a second draw while the first was suspended. Both then mutate `printed`
 * — the line count an append-only stream depends on — and whichever finished
 * last won: an older draw seeing a shorter body could reset `printed` to 0 and
 * reprint the whole transcript as though it were new (docs/adr/0036).
 */
async function drawOnce(): Promise<void> {
	if (drawing) {
		redrawRequested = true;
		return;
	}
	drawing = true;
	try {
		await draw();
		// Coalesce every request that arrived while this draw was running into one
		// follow-up, so a burst of watch events cannot queue a backlog of draws.
		while (redrawRequested) {
			redrawRequested = false;
			await draw();
		}
	} finally {
		drawing = false;
	}
}

function scheduleDraw(): void {
	if (pending) clearTimeout(pending);
	pending = setTimeout(() => {
		pending = undefined;
		void drawOnce();
	}, 80);
}

await drawOnce();

// Watch the Run's directory: the session file is appended to as the run goes,
// and the directory is also where it first appears if this process started
// before the child had written anything. Every event is a redraw candidate
// because the filename is not known until it exists.
try {
	watch(sessionDir, () => scheduleDraw());
} catch {
	// No inotify; the poll below carries it.
}

let lastStamp = "";
setInterval(() => {
	void (async () => {
		const resolved = await resolveFile();
		if (!resolved) return;
		try {
			const info = await stat(resolved);
			const stamp = `${info.mtimeMs}:${info.size}`;
			if (stamp !== lastStamp) {
				lastStamp = stamp;
				scheduleDraw();
			}
		} catch {
			// Latched name, but the file is momentarily unreadable (thaw/rename).
		}
	})();
}, 1000);

// No resize handler: reflowing would mean reprinting history the terminal now
// owns, which would duplicate it. Existing lines keep their original wrapping
// and new lines use the new width.
process.on("SIGINT", () => {
	process.stdout.write("\n");
	process.exit(0);
});
// The cursor stays visible: it marks where output has reached, and hiding it
// only made sense while this process owned the whole frame.
