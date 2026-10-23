#!/usr/bin/env bun
/**
 * The kanban board — a standalone, READ-ONLY viewer drawn in a herdr side pane.
 *
 * Spawned by `kanban/index.ts` with `exec bun board.ts …` typed into a pane it
 * split off the orchestrator, so this process *is* the pane: when it exits, herdr
 * removes the pane (measured on herdr 0.9.0). It never writes canonical state —
 * the extension is the only writer; this process renders the disposable
 * projection the extension publishes (atomic temp+rename into `--file`).
 *
 * Usage: board.ts --file <projection.json> --owner-pid <pi pid> --agent-dir <dir>
 *        [--once] [--width N] [--height N]
 *
 * Exits when: `q` / Ctrl-C; the owner pi process is gone (crash fallback — a
 * clean quit closes the pane from the extension); the runtime directory is
 * removed. Every exit path restores the terminal (alternate screen, cursor,
 * raw mode) — a stranded alt screen looks like a dead pane, a stranded raw mode
 * breaks the shell the pane would otherwise return to.
 *
 * Lessons carried over from the deleted `plan` Board: alternate screen + own
 * paging (a long board overflows any pane, and redrawing on the normal screen
 * stacks frames in the scrollback); watch the DIRECTORY, not the file (an atomic
 * rename replaces the inode a file watch is bound to) plus a slow poll; draws
 * never interleave (every read here is synchronous, so a draw is one tick).
 */

import { readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";

import { linkedRunIds, parseBoardArgs, parseProjection, renderFrame, type KanbanProjection, type RunInfos, type Style, type Tone } from "./lib.js";
import { readRunInfos } from "./runs.js";

const ESC = "\x1b";

/** 256-colour codes close to the tokyo-night theme pi uses, legible on dark and light. */
const TONE_CODE: Record<Tone, string> = {
	accent: "75",
	muted: "245",
	dim: "242",
	text: "252",
	success: "114",
	warning: "221",
	error: "203",
	heading: "141",
};

const ANSI_STYLE: Style = {
	fg: (tone, text) => (text ? `${ESC}[38;5;${TONE_CODE[tone]}m${text}${ESC}[39m` : text),
	bold: (text) => (text ? `${ESC}[1m${text}${ESC}[22m` : text),
};

const parsed = parseBoardArgs(process.argv.slice(2));
if (typeof parsed === "string") {
	process.stderr.write(`${parsed}\n`);
	process.exit(2);
}
const args = parsed;
const runtimeDir = dirname(args.file);

let projection: KanbanProjection | undefined;
let lastRaw = "";
let banner: string | undefined;
let runs: RunInfos = {};
let runsKey = "";
let scroll = 0;
let maxScroll = 0;
/** Body rows in the last frame: one page. */
let pageRows = 1;

/** Re-read the projection. Keeps the last good board on any failure, with a banner. */
function load(): boolean {
	let raw: string;
	try {
		raw = readFileSync(args.file, "utf-8");
	} catch {
		if (!projection) banner = undefined; // "waiting for pi" is drawn instead
		else banner = "projection missing — showing the last board";
		return true;
	}
	if (raw === lastRaw) return false;
	lastRaw = raw;
	let next: KanbanProjection | undefined;
	try {
		next = parseProjection(JSON.parse(raw));
	} catch {
		next = undefined;
	}
	if (!next) {
		banner = "projection unreadable — showing the last board";
		return true;
	}
	if (projection && next.seq < projection.seq && next.ownerPid === projection.ownerPid) {
		banner = "ignored an out-of-order projection";
		return true;
	}
	projection = next;
	banner = undefined;
	refreshRuns();
	return true;
}

/** Re-read linked run statuses. Returns whether anything changed. */
function refreshRuns(): boolean {
	const ids = projection ? linkedRunIds(projection.state) : [];
	const next = ids.length > 0 ? readRunInfos(args.agentDir, ids) : {};
	const key = JSON.stringify(next);
	if (key === runsKey) return false;
	runsKey = key;
	runs = next;
	return true;
}

function size(): { width: number; height: number } {
	return {
		width: args.width ?? process.stdout.columns ?? 80,
		height: args.height ?? process.stdout.rows ?? 24,
	};
}

function frameLines(): string[] {
	const { width, height } = size();
	const label = projection?.sessionName ?? projection?.sessionId.slice(0, 8);
	const frame = renderFrame(
		{ state: projection?.state, runs, width, height, scroll, ...(banner ? { banner } : {}), ...(label ? { label } : {}), ...(projection?.changedFiles ? { changedFiles: projection.changedFiles } : {}) },
		ANSI_STYLE,
	);
	scroll = frame.scroll;
	maxScroll = frame.maxScroll;
	pageRows = Math.max(1, frame.room);
	return frame.lines;
}

if (args.once) {
	load();
	process.stdout.write(`${frameLines().join("\n")}\n`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// Interactive mode
// ---------------------------------------------------------------------------

const timers: ReturnType<typeof setInterval>[] = [];
let watcher: FSWatcher | undefined;
let restored = false;

/** Idempotent: several exit paths can fire, and writing to a closed tty must not throw. */
function restore(): void {
	if (restored) return;
	restored = true;
	for (const t of timers) clearInterval(t);
	try {
		watcher?.close();
	} catch {
		// already closed
	}
	try {
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
	} catch {
		// stdin already gone; the screen restore below still matters
	}
	try {
		process.stdout.write(`${ESC}[?7h${ESC}[?25h${ESC}[?1049l`);
	} catch {
		// nothing left to restore to
	}
}

function quit(code = 0): never {
	restore();
	process.exit(code);
}

process.on("exit", restore);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => quit(0));
process.on("uncaughtException", (err) => {
	restore();
	console.error(err);
	process.exit(1);
});
process.on("unhandledRejection", (err) => {
	restore();
	console.error(err);
	process.exit(1);
});
process.stdout.on("error", () => quit(0)); // EIO: the pane is gone

let pending: ReturnType<typeof setTimeout> | undefined;
function scheduleDraw(): void {
	if (pending) return;
	pending = setTimeout(() => {
		pending = undefined;
		draw();
	}, 30);
}

/**
 * One complete frame, synchronously. Each row is addressed absolutely and
 * cleared before it is written, so a shorter frame never leaves residue and no
 * row relies on newline translation (raw mode turns output post-processing off
 * in some runtimes). Autowrap is off while the board runs, so a line that is
 * exactly the pane's width cannot scroll the screen.
 */
function draw(): void {
	const lines = frameLines();
	let out = `${ESC}[?2026h`;
	lines.forEach((line, i) => {
		out += `${ESC}[${i + 1};1H${ESC}[2K${line}${ESC}[0m`;
	});
	out += `${ESC}[${lines.length + 1};1H${ESC}[0J${ESC}[?2026l`;
	process.stdout.write(out);
}

function ownerAlive(): boolean {
	try {
		process.kill(args.ownerPid, 0);
		return true;
	} catch (err) {
		// EPERM means it exists but belongs to someone else — alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

function onKey(key: string): void {
	const page = pageRows;
	const before = scroll;
	switch (key) {
		case "q":
		case "\x03": // raw mode swallows SIGINT, so Ctrl-C arrives as a byte
			quit(0);
		case "\x1b[A":
		case "k":
			scroll = Math.max(0, scroll - 1);
			break;
		case "\x1b[B":
		case "j":
			scroll = Math.min(maxScroll, scroll + 1);
			break;
		case "\x1b[5~":
		case "\x02":
			scroll = Math.max(0, scroll - page);
			break;
		case "\x1b[6~":
		case "\x06":
		case " ":
			scroll = Math.min(maxScroll, scroll + page);
			break;
		case "g":
		case "\x1b[H":
		case "\x1b[1~":
			scroll = 0;
			break;
		case "G":
		case "\x1b[F":
		case "\x1b[4~":
			scroll = maxScroll;
			break;
		case "r":
			lastRaw = "";
			load();
			refreshRuns();
			draw();
			return;
		default:
			return;
	}
	if (scroll !== before) draw();
}

/**
 * Split a raw-mode chunk into keys: a paste or key repeat can deliver several at
 * once. A CSI sequence is one key; anything else, a lone ESC included, is one
 * byte — unbound keys fall through `onKey`'s switch, which is the intent.
 */
function keysOf(chunk: string): string[] {
	const keys: string[] = [];
	for (let i = 0; i < chunk.length; ) {
		const m = /^\x1b\[[0-9;]*[A-Za-z~]/.exec(chunk.slice(i));
		const len = m ? m[0].length : 1;
		keys.push(chunk.slice(i, i + len));
		i += len;
	}
	return keys;
}

if (!ownerAlive()) {
	process.stderr.write(`kanban board: owner pid ${args.ownerPid} is not running\n`);
	process.exit(0);
}

// Handlers are installed above, so a failure from here on restores the terminal.
process.stdout.write(`${ESC}]2;Kanban${ESC}\\${ESC}[?1049h${ESC}[?25l${ESC}[?7l`);
if (process.stdin.isTTY) {
	process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		for (const key of keysOf(chunk)) onKey(key);
	});
}

load();
draw();

const base = basename(args.file);
try {
	watcher = watch(runtimeDir, (_event, name) => {
		if (name && name.toString() !== base) return;
		if (load()) scheduleDraw();
	});
	watcher.on("error", () => {
		// The directory went away; the liveness tick below exits.
	});
} catch {
	// No inotify: the poll below still catches every change.
}

/**
 * Is the runtime dir gone? Only ENOENT counts: `existsSync` is false for
 * EACCES/EIO too, and a transient stat failure must not close the board.
 */
function runtimeDirGone(): boolean {
	try {
		statSync(runtimeDir);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT";
	}
}

let stamp = "";
timers.push(
	setInterval(() => {
		if (!ownerAlive() || runtimeDirGone()) quit(0);
		let next = "gone";
		try {
			const s = statSync(args.file);
			next = `${s.ino}:${s.mtimeMs}:${s.size}`;
		} catch {
			// handled by load()
		}
		if (next !== stamp) {
			stamp = next;
			if (load()) scheduleDraw();
		}
	}, 1000),
	setInterval(() => {
		if (refreshRuns()) scheduleDraw();
	}, 2000),
);

process.stdout.on("resize", scheduleDraw);
process.on("SIGWINCH", scheduleDraw);
